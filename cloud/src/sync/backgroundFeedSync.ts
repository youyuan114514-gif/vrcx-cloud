import type { Env } from '../env';
import {
    incrementCounter,
    parseCloudSyncIntervalSeconds,
    parseWebSyncIntervalSeconds,
    upsertEntityWorld
} from '../routes/coreData';
import { ingestFeedItems } from '../routes/eventsData';
import { buildCookieHeader, loadCookieJar, mergeSetCookies, saveCookieJar, VRC_USER_AGENT } from '../routes/vrcProxy';

const VRC_API_BASE = 'https://api.vrchat.cloud/api/1';
const STATE_KEY_SNAPSHOT = 'friends_snapshot';
const STATE_KEY_META = 'poller_meta';
export const BG_FEED_SYNC_CONFIG_KEY = 'cloud:bgFeedSyncEnabled';

// Strict Cloudflare Workers Free-tier subrequest guardrails (max 50 external fetch/invocation; keep <= 14 here).
const MAX_FRIEND_PAGES = 5;
const FRIEND_PAGE_SIZE = 100;
const MAX_WORLD_LOOKUPS_PER_TICK = 4;
const MAX_BIO_PROFILES_PER_TICK = 3;
const BIO_RECHECK_COOLDOWN_MS = 10 * 60_000; // Recheck each online friend's bio at most once per 10 minutes
const AUTH_EXPIRED_BACKOFF_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

export interface FriendSnapshotEntry {
    /** DisplayName */
    n: string;
    /** Last non-traveling location (e.g. wrld_...:12345 or private) */
    l: string;
    /** Cached worldName for last location */
    w: string;
    /** Cached groupName (if any) */
    g: string;
    /** Status (active/join me/ask me/busy/offline) */
    s: string;
    /** StatusDescription */
    d: string;
    /** Epoch ms when friend entered current location/session */
    la: number;
    /** Whether friend is in-game online (location != '' && location != 'offline') */
    o: boolean;
}

export type FriendSnapshotMap = Record<string, FriendSnapshotEntry>;

export interface PollerMeta {
    lastRunAt: string;
    lastSuccessAt: string;
    nextAllowedAt: string;
    webLastActiveAt: string;
    lastStatus:
        | 'never'
        | 'ok'
        | 'baseline'
        | 'skipped_disabled'
        | 'skipped_web_active'
        | 'skipped_interval'
        | 'no_session'
        | 'auth_expired'
        | 'rate_limited'
        | 'error';
    lastError: string;
    lastOnlineCount: number;
    lastFeedInserted: number;
    lastNotificationsInserted: number;
    lastBioChecked: number;
}

export interface VrcFriendApiRecord {
    id?: string;
    displayName?: string;
    location?: string;
    status?: string;
    statusDescription?: string;
    platform?: string;
}

export interface BackgroundFeedSyncResult {
    ran: boolean;
    status: PollerMeta['lastStatus'];
    onlineCount: number;
    feedInserted: number;
    notificationsInserted: number;
    bioChecked: number;
    error?: string;
}

function defaultPollerMeta(): PollerMeta {
    return {
        lastRunAt: '',
        lastSuccessAt: '',
        nextAllowedAt: '',
        webLastActiveAt: '',
        lastStatus: 'never',
        lastError: '',
        lastOnlineCount: 0,
        lastFeedInserted: 0,
        lastNotificationsInserted: 0,
        lastBioChecked: 0
    };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function extractWorldIdFromLocation(location: string): string {
    if (!location || location === 'offline' || location === 'private' || location === 'traveling') {
        return '';
    }
    const idx = location.indexOf(':');
    const candidate = idx > 0 ? location.slice(0, idx) : location;
    return /^wrld_[0-9a-f-]{36}$/i.test(candidate) ? candidate : '';
}

function arraysEqualStrings(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string');
}

/**
 * Pure diff engine comparing previous online-friend snapshot against the latest VRChat online friend list.
 * Produces upstream-compatible Feed records (Online, Offline, GPS, Status) and the updated snapshot.
 * When `prevSnapshot` is null (first run), establishes a clean baseline without emitting false online bursts.
 */
export function diffFriendSnapshot(
    prevSnapshot: FriendSnapshotMap | null,
    currentFriends: VrcFriendApiRecord[],
    nowIso: string,
    worldNameLookup: Map<string, string> = new Map()
): {
    nextSnapshot: FriendSnapshotMap;
    feedItems: Array<Record<string, unknown>>;
    isBaseline: boolean;
} {
    const nowMs = Date.parse(nowIso) || Date.now();
    const isBaseline = prevSnapshot === null;
    const prevMap: FriendSnapshotMap = prevSnapshot ?? {};
    const nextSnapshot: FriendSnapshotMap = {};
    const feedItems: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>();

    for (const friend of currentFriends) {
        const userId = typeof friend.id === 'string' ? friend.id.trim() : '';
        const displayName = typeof friend.displayName === 'string' ? friend.displayName.trim() : '';
        if (!userId || !displayName) continue;
        seenIds.add(userId);

        const rawLoc = typeof friend.location === 'string' ? friend.location.trim() : '';
        const status = typeof friend.status === 'string' ? friend.status.trim() : '';
        const statusDescription = typeof friend.statusDescription === 'string' ? friend.statusDescription : '';
        const isGameOnline = Boolean(rawLoc && rawLoc !== 'offline');
        const isTraveling = rawLoc === 'traveling';
        const prev = prevMap[userId];

        const worldId = extractWorldIdFromLocation(rawLoc);
        const resolvedWorldName = worldId ? (worldNameLookup.get(worldId) ?? '') : '';

        // Keep previous stable location while traveling so transient traveling ticks never generate bogus GPS rows.
        const effectiveLocation = isTraveling ? (prev?.l ?? '') : isGameOnline ? rawLoc : '';
        const effectiveWorldName = isTraveling
            ? (prev?.w ?? '')
            : isGameOnline
              ? resolvedWorldName || (prev?.l === rawLoc ? (prev?.w ?? '') : '')
              : '';
        const effectiveGroupName = isTraveling ? (prev?.g ?? '') : '';

        let nextLocationAt = prev?.la && prev.la > 0 ? prev.la : nowMs;

        if (!isBaseline) {
            const wasGameOnline = Boolean(prev?.o);

            // 1. Online / Offline transitions
            if (isGameOnline && !wasGameOnline) {
                nextLocationAt = nowMs;
                feedItems.push({
                    created_at: nowIso,
                    type: 'Online',
                    userId,
                    displayName,
                    location: isTraveling ? '' : rawLoc,
                    worldName: isTraveling ? '' : resolvedWorldName,
                    groupName: '',
                    time: 0
                });
            } else if (!isGameOnline && wasGameOnline && prev) {
                const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
                feedItems.push({
                    created_at: nowIso,
                    type: 'Offline',
                    userId,
                    displayName,
                    location: prev.l,
                    worldName: prev.w,
                    groupName: prev.g,
                    time: elapsedMs
                });
                nextLocationAt = nowMs;
            } else if (isGameOnline && wasGameOnline && prev && !isTraveling) {
                // 2. GPS (world/instance change)
                const prevLoc = prev.l;
                if (prevLoc && prevLoc !== rawLoc) {
                    const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
                    feedItems.push({
                        created_at: nowIso,
                        type: 'GPS',
                        userId,
                        displayName,
                        location: rawLoc,
                        worldName: resolvedWorldName,
                        previousLocation: prevLoc,
                        groupName: '',
                        time: elapsedMs
                    });
                    nextLocationAt = nowMs;
                }
            }

            // 3. Status / StatusDescription changes (matches upstream: ignore transitions involving 'offline')
            if (
                prev &&
                status &&
                prev.s &&
                status !== 'offline' &&
                prev.s !== 'offline' &&
                (status !== prev.s || statusDescription !== prev.d)
            ) {
                feedItems.push({
                    created_at: nowIso,
                    type: 'Status',
                    userId,
                    displayName,
                    status,
                    statusDescription,
                    previousStatus: prev.s,
                    previousStatusDescription: prev.d
                });
            }
        }

        nextSnapshot[userId] = {
            n: displayName,
            l: effectiveLocation,
            w: effectiveWorldName,
            g: effectiveGroupName,
            s: status,
            d: statusDescription,
            la: nextLocationAt,
            o: isGameOnline
        };
    }

    // Friends who disappeared completely from the online list went Offline
    if (!isBaseline) {
        for (const [userId, prev] of Object.entries(prevMap)) {
            if (seenIds.has(userId) || !prev.o) continue;
            const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
            feedItems.push({
                created_at: nowIso,
                type: 'Offline',
                userId,
                displayName: prev.n,
                location: prev.l,
                worldName: prev.w,
                groupName: prev.g,
                time: elapsedMs
            });
        }
    }

    return { nextSnapshot, feedItems, isBaseline };
}

async function readPollerState(env: Env): Promise<{
    meta: PollerMeta;
    snapshot: FriendSnapshotMap | null;
    agentSyncIntervalSeconds: number;
    webSyncIntervalSeconds: number;
    enabled: boolean;
    cookieUpdatedAt: string;
}> {
    const [cfgRes, stateRes, vaultRes] = await env.DB_CORE.batch([
        env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
        env.DB_CORE.prepare('SELECT state_key, payload_json FROM cloud_bg_sync_state WHERE state_key IN (?, ?)').bind(
            STATE_KEY_META,
            STATE_KEY_SNAPSHOT
        ),
        env.DB_CORE.prepare("SELECT updated_at FROM cloud_cookie_vault WHERE account_key = 'default' LIMIT 1")
    ]);

    const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
    const cfg = safeJsonParse<Record<string, string>>(cfgRow?.payload_json, {});
    const agentSyncIntervalSeconds = parseCloudSyncIntervalSeconds(cfg['cloud:syncIntervalSeconds']);
    const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(cfg['cloud:webSyncIntervalSeconds']);
    // Default enabled so closing the browser tab automatically continues recording Feed & Notifications.
    const enabled = cfg[BG_FEED_SYNC_CONFIG_KEY] !== 'false';

    let meta = defaultPollerMeta();
    let snapshot: FriendSnapshotMap | null = null;

    for (const row of (stateRes?.results ?? []) as Array<{ state_key: string; payload_json: string }>) {
        if (row.state_key === STATE_KEY_META) {
            meta = { ...meta, ...safeJsonParse<Partial<PollerMeta>>(row.payload_json, {}) };
        } else if (row.state_key === STATE_KEY_SNAPSHOT) {
            const parsed = safeJsonParse<FriendSnapshotMap | null>(row.payload_json, null);
            if (parsed && typeof parsed === 'object') {
                snapshot = parsed;
            }
        }
    }

    const vaultRow = (vaultRes?.results?.[0] ?? null) as { updated_at?: string } | null;
    return {
        meta,
        snapshot,
        agentSyncIntervalSeconds,
        webSyncIntervalSeconds,
        enabled,
        cookieUpdatedAt: vaultRow?.updated_at ?? ''
    };
}

async function writePollerMeta(env: Env, meta: PollerMeta, nowIso: string): Promise<void> {
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_META, JSON.stringify(meta), nowIso)
        .run();
}

/**
 * Records whether a Web UI tab is actively connected (or closing via `pagehide`) so the Cron poller
 * stays idle while the browser's live Pipeline WebSocket is running and takes over immediately on close.
 */
export async function markWebClientActive(env: Env, nowIso: string, closing = false): Promise<void> {
    const row = await env.DB_CORE.prepare('SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1')
        .bind(STATE_KEY_META)
        .first<{ payload_json: string }>();
    const meta: PollerMeta = {
        ...defaultPollerMeta(),
        ...safeJsonParse<Partial<PollerMeta>>(row?.payload_json, {})
    };
    meta.webLastActiveAt = closing ? '' : nowIso;
    await writePollerMeta(env, meta, nowIso);
}

/**
 * Clears auth/rate-limit backoff whenever the user logs in or refreshes VRChat cookies in Web mode.
 */
export async function clearBgSyncBackoff(env: Env): Promise<void> {
    const nowIso = new Date().toISOString();
    const row = await env.DB_CORE.prepare('SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1')
        .bind(STATE_KEY_META)
        .first<{ payload_json: string }>();
    if (!row) return;
    const meta: PollerMeta = {
        ...defaultPollerMeta(),
        ...safeJsonParse<Partial<PollerMeta>>(row.payload_json, {})
    };
    if (!meta.nextAllowedAt && meta.lastStatus !== 'auth_expired' && meta.lastStatus !== 'no_session') {
        return;
    }
    meta.nextAllowedAt = '';
    if (meta.lastStatus === 'auth_expired' || meta.lastStatus === 'no_session') {
        meta.lastError = '';
    }
    await writePollerMeta(env, meta, nowIso);
}

export async function getBackgroundFeedSyncStatus(env: Env): Promise<{
    enabled: boolean;
    webSyncIntervalSeconds: number;
    effectiveCronIntervalSeconds: number;
    hasVrcSession: boolean;
    meta: PollerMeta;
}> {
    const [{ meta, webSyncIntervalSeconds, enabled }, jar] = await Promise.all([
        readPollerState(env),
        loadCookieJar(env)
    ]);
    return {
        enabled,
        webSyncIntervalSeconds,
        effectiveCronIntervalSeconds: Math.max(webSyncIntervalSeconds, 60),
        hasVrcSession: Boolean(jar.auth?.trim()),
        meta
    };
}

export async function setBackgroundFeedSyncEnabled(env: Env, enabled: boolean): Promise<boolean> {
    const row = await env.DB_CORE.prepare(
        "SELECT payload_json, version FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
    ).first<{ payload_json: string; version: number }>();
    const current = safeJsonParse<Record<string, string>>(row?.payload_json, {});
    current[BG_FEED_SYNC_CONFIG_KEY] = enabled ? 'true' : 'false';
    const nextVersion = (row?.version ?? 0) + 1;
    const nowIso = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
         VALUES ('vrcx_config', ?, ?, ?)
         ON CONFLICT(bundle_key) DO UPDATE SET
            version = excluded.version,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(nextVersion, JSON.stringify(current), nowIso)
        .run();
    return enabled;
}

async function fetchVrcJson(
    pathWithQuery: string,
    jar: Record<string, string>
): Promise<{ status: number; data: unknown; cookieChanged: boolean }> {
    const headers = new Headers();
    headers.set('User-Agent', VRC_USER_AGENT);
    headers.set('Accept', 'application/json');
    const cookieHeader = buildCookieHeader(jar);
    if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
    }

    const res = await fetch(`${VRC_API_BASE}/${pathWithQuery}`, {
        method: 'GET',
        headers
    });
    const cookieChanged = mergeSetCookies(jar, res.headers);
    const text = await res.text();
    let data: unknown = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    return { status: res.status, data, cookieChanged };
}

async function resolveWorldNames(
    env: Env,
    worldIds: string[],
    jar: Record<string, string>
): Promise<{ names: Map<string, string>; cookieChanged: boolean }> {
    const names = new Map<string, string>();
    const unique = Array.from(new Set(worldIds.filter(Boolean)));
    if (unique.length === 0) {
        return { names, cookieChanged: false };
    }

    // 1. Check cached entity_worlds dictionary in DB_CORE first (zero external requests)
    for (let i = 0; i < unique.length; i += 25) {
        const chunk = unique.slice(i, i + 25);
        const ph = chunk.map(() => '?').join(', ');
        const res = await env.DB_CORE.prepare(
            `SELECT world_id, world_name FROM entity_worlds WHERE world_id IN (${ph})`
        )
            .bind(...chunk)
            .all<{ world_id: string; world_name: string }>();
        for (const r of res.results ?? []) {
            if (r.world_id && r.world_name) {
                names.set(r.world_id, r.world_name);
            }
        }
    }

    // 2. Fetch at most MAX_WORLD_LOOKUPS_PER_TICK missing worlds from VRChat API and cache them
    let cookieChanged = false;
    let fetched = 0;
    for (const worldId of unique) {
        if (names.has(worldId) || fetched >= MAX_WORLD_LOOKUPS_PER_TICK) continue;
        fetched++;
        try {
            const res = await fetchVrcJson(`worlds/${encodeURIComponent(worldId)}`, jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 200 && res.data && typeof res.data === 'object') {
                const name = String((res.data as { name?: unknown }).name ?? '').trim();
                if (name) {
                    names.set(worldId, name);
                    await upsertEntityWorld(env.DB_CORE, worldId, name);
                }
            }
        } catch {
            // Non-fatal: leave worldName blank if lookup transiently fails
        }
    }

    return { names, cookieChanged };
}

async function pollRotatingFriendBios(
    env: Env,
    onlineFriends: VrcFriendApiRecord[],
    jar: Record<string, string>,
    nowIso: string,
    nowMs: number
): Promise<{ bioFeeds: Array<Record<string, unknown>>; bioChecked: number; cookieChanged: boolean }> {
    const bioFeeds: Array<Record<string, unknown>> = [];
    const candidates = onlineFriends
        .filter((f) => typeof f.id === 'string' && f.id.startsWith('usr_') && typeof f.displayName === 'string')
        .map((f) => ({ id: f.id!, displayName: f.displayName! }));

    if (candidates.length === 0) {
        return { bioFeeds, bioChecked: 0, cookieChanged: false };
    }

    // Load existing cached profiles for online friends in batched IN queries
    const existingMap = new Map<string, { bio: string; bioLinks: string[]; updatedAtMs: number }>();
    for (let i = 0; i < candidates.length; i += 25) {
        const chunk = candidates.slice(i, i + 25).map((c) => c.id);
        const ph = chunk.map(() => '?').join(', ');
        const res = await env.DB_CORE.prepare(
            `SELECT user_id, bio, bio_links, updated_at FROM user_profile WHERE user_id IN (${ph})`
        )
            .bind(...chunk)
            .all<{ user_id: string; bio: string; bio_links: string; updated_at: string }>();
        for (const r of res.results ?? []) {
            existingMap.set(r.user_id, {
                bio: r.bio ?? '',
                bioLinks: normalizeStringArray(safeJsonParse<unknown>(r.bio_links, [])),
                updatedAtMs: Date.parse(r.updated_at || '') || 0
            });
        }
    }

    // Round-robin pick up to MAX_BIO_PROFILES_PER_TICK online friends whose profiles are missing or oldest (>10m)
    const due = candidates
        .map((c) => ({
            ...c,
            existing: existingMap.get(c.id),
            updatedAtMs: existingMap.get(c.id)?.updatedAtMs ?? 0
        }))
        .filter((c) => !c.existing || nowMs - c.updatedAtMs >= BIO_RECHECK_COOLDOWN_MS)
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
        .slice(0, MAX_BIO_PROFILES_PER_TICK);

    let bioChecked = 0;
    let cookieChanged = false;
    const profileWrites: D1PreparedStatement[] = [];

    for (const target of due) {
        try {
            const res = await fetchVrcJson(`users/${encodeURIComponent(target.id)}`, jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 429 || res.status === 401 || res.status === 403) {
                break;
            }
            if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
                continue;
            }
            const user = res.data as { displayName?: unknown; bio?: unknown; bioLinks?: unknown };
            if (typeof user.bio !== 'string') {
                continue;
            }
            bioChecked++;
            const displayName =
                typeof user.displayName === 'string' && user.displayName.trim()
                    ? user.displayName.trim()
                    : target.displayName;
            const bio = user.bio;
            const bioLinks = normalizeStringArray(user.bioLinks);

            if (target.existing) {
                const bioChanged =
                    target.existing.bio !== bio || !arraysEqualStrings(target.existing.bioLinks, bioLinks);
                if (bioChanged) {
                    bioFeeds.push({
                        created_at: nowIso,
                        type: 'Bio',
                        userId: target.id,
                        displayName,
                        bio,
                        previousBio: target.existing.bio,
                        bioLinks,
                        previousBioLinks: target.existing.bioLinks
                    });
                }
            }

            profileWrites.push(
                env.DB_CORE.prepare(
                    `INSERT INTO user_profile (user_id, bio, bio_links, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET
                        bio = excluded.bio,
                        bio_links = excluded.bio_links,
                        updated_at = excluded.updated_at`
                ).bind(target.id, bio, JSON.stringify(bioLinks), nowIso)
            );
        } catch {
            // Non-fatal per-profile error
        }
    }

    if (profileWrites.length > 0) {
        await env.DB_CORE.batch(profileWrites);
    }

    return { bioFeeds, bioChecked, cookieChanged };
}

async function pollNotifications(
    env: Env,
    jar: Record<string, string>,
    nowIso: string
): Promise<{ inserted: number; cookieChanged: boolean }> {
    let inserted = 0;
    let cookieChanged = false;

    // 1. Notifications v1 (invites, requestInvite, inviteResponse, etc.)
    try {
        const resV1 = await fetchVrcJson('auth/user/notifications?n=60', jar);
        if (resV1.cookieChanged) cookieChanged = true;
        if (resV1.status === 200 && Array.isArray(resV1.data)) {
            const stmts: D1PreparedStatement[] = [];
            for (const raw of resV1.data as Array<Record<string, unknown>>) {
                const id = typeof raw.id === 'string' ? raw.id.trim() : '';
                const type = typeof raw.type === 'string' ? raw.type.trim() : '';
                if (!id || !type) continue;
                // Match upstream src/stores/notification/index.js exclusion rules
                if (type === 'friendRequest' || type === 'ignoredFriendRequest' || type.includes('.')) {
                    continue;
                }
                let details: Record<string, unknown> = {};
                if (typeof raw.details === 'string') {
                    details = safeJsonParse<Record<string, unknown>>(raw.details, {});
                } else if (raw.details && typeof raw.details === 'object') {
                    details = raw.details as Record<string, unknown>;
                }
                stmts.push(
                    env.DB_CORE.prepare(
                        `INSERT OR IGNORE INTO notifications
                         (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
                    ).bind(
                        id,
                        String(raw.created_at ?? nowIso),
                        type,
                        String(raw.senderUserId ?? ''),
                        String(raw.senderUsername ?? ''),
                        String(raw.receiverUserId ?? ''),
                        String(raw.message ?? ''),
                        String(details.worldId ?? ''),
                        String(details.worldName ?? ''),
                        String(details.imageUrl ?? ''),
                        String(details.inviteMessage ?? ''),
                        String(details.requestMessage ?? ''),
                        String(details.responseMessage ?? '')
                    )
                );
            }
            let v1Added = 0;
            for (let i = 0; i < stmts.length; i += 25) {
                const results = await env.DB_CORE.batch(stmts.slice(i, i + 25));
                for (const r of results) {
                    v1Added += r.meta?.changes ?? 0;
                }
            }
            if (v1Added > 0) {
                inserted += v1Added;
                await incrementCounter(env.DB_CORE, 'notifications', v1Added);
            }
        }
    } catch {
        // Non-fatal
    }

    // 2. Notifications v2 (group announcements, boops, invites v2)
    try {
        const resV2 = await fetchVrcJson('notifications?n=60', jar);
        if (resV2.cookieChanged) cookieChanged = true;
        if (resV2.status === 200 && Array.isArray(resV2.data)) {
            const items = (resV2.data as Array<Record<string, unknown>>).filter(
                (raw) => typeof raw.id === 'string' && raw.id.trim().length > 0
            );
            if (items.length > 0) {
                // Check which v2 IDs are genuinely new for accurate reporting
                const existingIds = new Set<string>();
                for (let i = 0; i < items.length; i += 25) {
                    const chunkIds = items.slice(i, i + 25).map((r) => String(r.id));
                    const ph = chunkIds.map(() => '?').join(', ');
                    const res = await env.DB_CORE.prepare(`SELECT id FROM notifications_v2 WHERE id IN (${ph})`)
                        .bind(...chunkIds)
                        .all<{ id: string }>();
                    for (const row of res.results ?? []) {
                        existingIds.add(row.id);
                    }
                }

                for (let i = 0; i < items.length; i += 25) {
                    const chunk = items.slice(i, i + 25);
                    await env.DB_CORE.batch(
                        chunk.map((e) =>
                            env.DB_CORE.prepare(
                                `INSERT OR REPLACE INTO notifications_v2
                                 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                                String(e.id),
                                String(e.createdAt ?? e.created_at ?? nowIso),
                                String(e.updatedAt ?? e.updated_at ?? ''),
                                String(e.expiresAt ?? e.expires_at ?? ''),
                                String(e.type ?? ''),
                                String(e.link ?? ''),
                                String(e.linkText ?? e.link_text ?? ''),
                                String(e.message ?? ''),
                                String(e.title ?? ''),
                                String(e.imageUrl ?? e.image_url ?? ''),
                                e.seen ? 1 : 0,
                                String(e.senderUserId ?? e.sender_user_id ?? ''),
                                String(e.senderUsername ?? e.sender_username ?? ''),
                                typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? {}),
                                typeof e.responses === 'string' ? e.responses : JSON.stringify(e.responses ?? []),
                                typeof e.details === 'string' ? e.details : JSON.stringify(e.details ?? {})
                            )
                        )
                    );
                }
                for (const item of items) {
                    if (!existingIds.has(String(item.id))) {
                        inserted++;
                    }
                }
            }
        }
    } catch {
        // Non-fatal
    }

    return { inserted, cookieChanged };
}

/**
 * Executes one scheduled or manual cloud-side VRChat Feed & Notification sync cycle.
 * Strictly obeys the independent Web/Cloud `webSyncIntervalSeconds` (default 300s = 5 min, min 60s on Cloudflare Cron),
 * skips external VRChat API requests when a browser tab is actively connected (unless `force` is true),
 * and stays well within Cloudflare Free Tier Worker/D1/subrequest guardrails with zero DO wakeups.
 */
export async function runBackgroundFeedSync(
    env: Env,
    options: { force?: boolean; trigger?: 'cron' | 'manual' } = {}
): Promise<BackgroundFeedSyncResult> {
    const force = Boolean(options.force);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { meta, snapshot, agentSyncIntervalSeconds, webSyncIntervalSeconds, enabled, cookieUpdatedAt } =
        await readPollerState(env);

    if (!force && !enabled) {
        return {
            ran: false,
            status: 'skipped_disabled',
            onlineCount: meta.lastOnlineCount,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0
        };
    }

    // Defer to live browser WebSocket while a Web tab is actively open (unless manually triggered).
    // StatusBar sends heartbeats every max(agentSyncInterval*2, 180)s, and tab close fires ?closing=1 to clear webLastActiveAt immediately.
    if (!force && meta.webLastActiveAt) {
        const webActiveMs = Date.parse(meta.webLastActiveAt);
        const activeWindowMs = (Math.max(agentSyncIntervalSeconds * 2, 180) + 45) * 1000;
        if (Number.isFinite(webActiveMs) && nowMs - webActiveMs <= activeWindowMs) {
            return {
                ran: false,
                status: 'skipped_web_active',
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0
            };
        }
    }

    if (!force && meta.nextAllowedAt) {
        const nextAllowedMs = Date.parse(meta.nextAllowedAt);
        const cookieRefreshed =
            meta.lastStatus === 'auth_expired' &&
            Boolean(cookieUpdatedAt) &&
            Date.parse(cookieUpdatedAt) > (Date.parse(meta.lastRunAt) || 0);
        if (!cookieRefreshed && Number.isFinite(nextAllowedMs) && nowMs < nextAllowedMs) {
            return {
                ran: false,
                status: meta.lastStatus,
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                error: meta.lastError || undefined
            };
        }
    }

    if (!force && meta.lastRunAt) {
        const lastRunMs = Date.parse(meta.lastRunAt);
        const minIntervalMs = Math.max(webSyncIntervalSeconds, 60) * 1000 - 3_000; // 3s cron jitter tolerance
        if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < minIntervalMs) {
            return {
                ran: false,
                status: 'skipped_interval',
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0
            };
        }
    }

    const jar = await loadCookieJar(env);
    if (!jar.auth?.trim()) {
        meta.lastRunAt = nowIso;
        meta.lastStatus = 'no_session';
        meta.lastError = 'No VRChat session cookie in cloud vault';
        await writePollerMeta(env, meta, nowIso);
        return {
            ran: false,
            status: 'no_session',
            onlineCount: 0,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            error: meta.lastError
        };
    }

    let cookieDirty = false;
    const onlineFriends: VrcFriendApiRecord[] = [];
    const seenIds = new Set<string>();

    try {
        for (let page = 0; page < MAX_FRIEND_PAGES; page++) {
            const offset = page * FRIEND_PAGE_SIZE;
            const res = await fetchVrcJson(
                `auth/user/friends?offline=false&n=${FRIEND_PAGE_SIZE}&offset=${offset}`,
                jar
            );
            if (res.cookieChanged) cookieDirty = true;

            if (res.status === 401) {
                meta.lastRunAt = nowIso;
                meta.lastStatus = 'auth_expired';
                meta.lastError = 'VRChat session expired (HTTP 401); open Web UI to re-login.';
                meta.nextAllowedAt = new Date(nowMs + AUTH_EXPIRED_BACKOFF_MS).toISOString();
                await writePollerMeta(env, meta, nowIso);
                return {
                    ran: true,
                    status: 'auth_expired',
                    onlineCount: 0,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    error: meta.lastError
                };
            }

            if (res.status === 429 || res.status === 403) {
                meta.lastRunAt = nowIso;
                meta.lastStatus = 'rate_limited';
                meta.lastError = `VRChat API throttled/blocked (HTTP ${res.status}); backing off 10 min.`;
                meta.nextAllowedAt = new Date(nowMs + RATE_LIMIT_BACKOFF_MS).toISOString();
                await writePollerMeta(env, meta, nowIso);
                return {
                    ran: true,
                    status: 'rate_limited',
                    onlineCount: meta.lastOnlineCount,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    error: meta.lastError
                };
            }

            if (res.status !== 200 || !Array.isArray(res.data)) {
                throw new Error(`VRChat friends endpoint returned HTTP ${res.status}`);
            }

            const batch = res.data as VrcFriendApiRecord[];
            for (const item of batch) {
                const id = typeof item.id === 'string' ? item.id.trim() : '';
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                onlineFriends.push(item);
            }
            if (batch.length < FRIEND_PAGE_SIZE) {
                break;
            }
        }

        // Resolve world names for online friends' current worlds (DB cache first, <=4 API fetches)
        const worldIdsToResolve: string[] = [];
        for (const f of onlineFriends) {
            const loc = typeof f.location === 'string' ? f.location.trim() : '';
            const wid = extractWorldIdFromLocation(loc);
            if (!wid) continue;
            const prev = snapshot?.[f.id ?? ''];
            if (!snapshot || !prev || prev.l !== loc || !prev.w) {
                worldIdsToResolve.push(wid);
            }
        }
        const worldRes = await resolveWorldNames(env, worldIdsToResolve, jar);
        if (worldRes.cookieChanged) cookieDirty = true;

        const { nextSnapshot, feedItems, isBaseline } = diffFriendSnapshot(
            snapshot,
            onlineFriends,
            nowIso,
            worldRes.names
        );

        // Rotate bio checks across online friends (<=3 per tick, >=10m per friend)
        const bioRes = await pollRotatingFriendBios(env, onlineFriends, jar, nowIso, nowMs);
        if (bioRes.cookieChanged) cookieDirty = true;
        if (bioRes.bioFeeds.length > 0) {
            feedItems.push(...bioRes.bioFeeds);
        }

        // Persist any new Feed events (Online, Offline, GPS, Status, Bio)
        let feedInserted = 0;
        if (feedItems.length > 0) {
            const ingestRes = await ingestFeedItems(env, feedItems);
            feedInserted = ingestRes.inserted;
        }

        // Poll v1 + v2 notifications
        const notifRes = await pollNotifications(env, jar, nowIso);
        if (notifRes.cookieChanged) cookieDirty = true;

        if (cookieDirty) {
            await saveCookieJar(env, jar);
        }

        const inGameCount = Object.values(nextSnapshot).filter((entry) => entry.o).length;
        meta.lastRunAt = nowIso;
        meta.lastSuccessAt = nowIso;
        meta.nextAllowedAt = '';
        meta.lastStatus = isBaseline ? 'baseline' : 'ok';
        meta.lastError = '';
        meta.lastOnlineCount = inGameCount;
        meta.lastFeedInserted = feedInserted;
        meta.lastNotificationsInserted = notifRes.inserted;
        meta.lastBioChecked = bioRes.bioChecked;

        await env.DB_CORE.batch([
            env.DB_CORE.prepare(
                `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at`
            ).bind(STATE_KEY_SNAPSHOT, JSON.stringify(nextSnapshot), nowIso),
            env.DB_CORE.prepare(
                `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at`
            ).bind(STATE_KEY_META, JSON.stringify(meta), nowIso)
        ]);

        return {
            ran: true,
            status: meta.lastStatus,
            onlineCount: inGameCount,
            feedInserted,
            notificationsInserted: notifRes.inserted,
            bioChecked: bioRes.bioChecked
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unexpected background sync error';
        meta.lastRunAt = nowIso;
        meta.lastStatus = 'error';
        meta.lastError = msg.slice(0, 240);
        await writePollerMeta(env, meta, nowIso);
        return {
            ran: true,
            status: 'error',
            onlineCount: meta.lastOnlineCount,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            error: meta.lastError
        };
    }
}
