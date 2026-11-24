import type { Env } from '../env';
import { buildSafeTrigramMatch, searchGameLogByEntity } from '../search/entityFts';
import {
    getAgentOnlineWindowMs,
    incrementCounter,
    parseCloudSyncIntervalSeconds,
    resolveRecentHttpAgents,
    upsertEntityUser,
    upsertEntityWorld
} from './coreData';

const MAX_LIMIT = 100;

function clampLimit(val: string | null, fallback = 50): number {
    const n = Number(val ?? fallback);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), MAX_LIMIT);
}

export interface GameLogIngestItem {
    type: 'Location' | 'OnPlayerJoined' | 'OnPlayerLeft' | 'PortalSpawn' | 'VideoPlay' | 'Event' | 'External';
    created_at?: string;
    location?: string;
    worldId?: string;
    worldName?: string;
    time?: number;
    groupName?: string;
    displayName?: string;
    userId?: string;
    instanceId?: string;
    videoUrl?: string;
    videoName?: string;
    videoId?: string;
    data?: string;
    message?: string;
}

/**
 * Inserts a batch of structured GameLog events into DB_GAMELOG (chunked <= 25 per D1 batch),
 * updates deduplicated entity dictionaries in DB_CORE, and increments stats_counters.
 */
export async function ingestGameLogItems(
    env: Env,
    items: GameLogIngestItem[]
): Promise<{ inserted: number; lastRowId: number }> {
    const stmts: D1PreparedStatement[] = [];
    const userEntities = new Map<string, string>();
    const worldEntities = new Map<string, string>();
    const counterDeltas = new Map<string, number>();

    const bump = (k: string) => counterDeltas.set(k, (counterDeltas.get(k) ?? 0) + 1);

    for (const item of items) {
        const createdAt = item.created_at || new Date().toISOString();
        switch (item.type) {
            case 'Location': {
                const worldId = item.worldId || (item.location?.split(':')[0] ?? '');
                stmts.push(
                    env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.location ?? '',
                        worldId,
                        item.worldName ?? '',
                        item.time ?? 0,
                        item.groupName ?? ''
                    )
                );
                if (worldId && item.worldName) worldEntities.set(worldId, item.worldName);
                bump('gamelog_location');
                break;
            }
            case 'OnPlayerJoined':
            case 'OnPlayerLeft': {
                stmts.push(
                    env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.type,
                        item.displayName ?? '',
                        item.location ?? '',
                        item.userId ?? '',
                        item.time ?? 0
                    )
                );
                if (item.userId && item.displayName) userEntities.set(item.userId, item.displayName);
                bump('gamelog_join_leave');
                break;
            }
            case 'PortalSpawn': {
                stmts.push(
                    env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.displayName ?? '',
                        item.location ?? '',
                        item.userId ?? '',
                        item.instanceId ?? '',
                        item.worldName ?? ''
                    )
                );
                if (item.userId && item.displayName) userEntities.set(item.userId, item.displayName);
                bump('gamelog_portal_spawn');
                break;
            }
            case 'VideoPlay': {
                stmts.push(
                    env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_video_play (created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.videoUrl ?? '',
                        item.videoName ?? '',
                        item.videoId ?? '',
                        item.location ?? '',
                        item.displayName ?? '',
                        item.userId ?? ''
                    )
                );
                bump('gamelog_video_play');
                break;
            }
            case 'Event': {
                stmts.push(
                    env.DB_GAMELOG.prepare('INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (?, ?)').bind(
                        createdAt,
                        item.data ?? ''
                    )
                );
                bump('gamelog_event');
                break;
            }
            case 'External': {
                stmts.push(
                    env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_external (created_at, message, display_name, user_id, location) VALUES (?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.message ?? '',
                        item.displayName ?? '',
                        item.userId ?? '',
                        item.location ?? ''
                    )
                );
                bump('gamelog_external');
                break;
            }
            default:
                break;
        }
    }

    let inserted = 0;
    let lastRowId = 0;
    for (let i = 0; i < stmts.length; i += 25) {
        const results = await env.DB_GAMELOG.batch(stmts.slice(i, i + 25));
        for (const r of results) {
            const changes = r.meta?.changes ?? 0;
            inserted += changes;
            if (r.meta?.last_row_id) {
                lastRowId = Number(r.meta.last_row_id);
            }
        }
    }

    // Update deduplicated entities and counters in DB_CORE (capped to stay under Free subrequest cap)
    let dictOps = 0;
    for (const [uid, name] of userEntities) {
        if (dictOps++ >= 10) break;
        await upsertEntityUser(env.DB_CORE, uid, name);
    }
    for (const [wid, name] of worldEntities) {
        if (dictOps++ >= 15) break;
        await upsertEntityWorld(env.DB_CORE, wid, name);
    }
    for (const [key, delta] of counterDeltas) {
        await incrementCounter(env.DB_CORE, key, delta);
    }

    return { inserted, lastRowId };
}

/**
 * Inserts a batch of structured Feed events (GPS, Online/Offline, Status, Bio) into DB_FEED,
 * updates deduplicated user entities in DB_CORE, and increments stats_counters idempotently.
 */
export async function ingestFeedItems(
    env: Env,
    items: Array<Record<string, unknown>>
): Promise<{ count: number; inserted: number; lastRowId: number }> {
    const stmts: Array<{ stmt: D1PreparedStatement; counterKey: string }> = [];
    const users = new Map<string, string>();

    for (const e of items) {
        const type = String(e.type ?? '');
        const createdAt = String(e.created_at ?? new Date().toISOString());
        const userId = String(e.userId ?? '');
        const displayName = String(e.displayName ?? '');
        if (userId && displayName) users.set(userId, displayName);

        if (type === 'GPS') {
            stmts.push({
                counterKey: 'feed_gps',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.location ?? ''),
                    String(e.worldName ?? ''),
                    String(e.previousLocation ?? ''),
                    Number(e.time ?? 0),
                    String(e.groupName ?? '')
                )
            });
        } else if (type === 'Online' || type === 'Offline') {
            stmts.push({
                counterKey: 'feed_online_offline',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    type,
                    String(e.location ?? ''),
                    String(e.worldName ?? ''),
                    Number(e.time ?? 0),
                    String(e.groupName ?? '')
                )
            });
        } else if (type === 'Status') {
            stmts.push({
                counterKey: 'feed_status',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.status ?? ''),
                    String(e.statusDescription ?? ''),
                    String(e.previousStatus ?? ''),
                    String(e.previousStatusDescription ?? '')
                )
            });
        } else if (type === 'Bio') {
            stmts.push({
                counterKey: 'feed_bio',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_bio (created_at, user_id, display_name, bio, previous_bio, bio_links, previous_bio_links) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.bio ?? ''),
                    String(e.previousBio ?? ''),
                    JSON.stringify(e.bioLinks ?? []),
                    JSON.stringify(e.previousBioLinks ?? [])
                )
            });
        }
        // Avatar feed intentionally skipped by default on Free D1 tier to prevent multi-GB bloat
    }

    let inserted = 0;
    let lastRowId = 0;
    const counterDeltas = new Map<string, number>();
    for (let i = 0; i < stmts.length; i += 25) {
        const chunk = stmts.slice(i, i + 25);
        const results = await env.DB_FEED.batch(chunk.map((c) => c.stmt));
        for (let j = 0; j < results.length; j++) {
            const r = results[j]!;
            const changes = r.meta?.changes ?? 0;
            if (changes > 0) {
                inserted += changes;
                const key = chunk[j]!.counterKey;
                counterDeltas.set(key, (counterDeltas.get(key) ?? 0) + changes);
            }
            if (r.meta?.last_row_id) lastRowId = Number(r.meta.last_row_id);
        }
    }

    let ops = 0;
    for (const [uid, name] of users) {
        if (ops++ >= 8) break;
        await upsertEntityUser(env.DB_CORE, uid, name);
    }
    for (const [k, delta] of counterDeltas) {
        await incrementCounter(env.DB_CORE, k, delta);
    }

    return { count: stmts.length, inserted, lastRowId };
}

function normalizeGameLogRows(results: D1Result<Record<string, unknown>>[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const [loc, jl, portal, video, ev, ext] = results;

    for (const r of loc?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'Location',
            location: r.location,
            worldId: r.world_id,
            worldName: r.world_name,
            time: r.time,
            groupName: r.group_name
        });
    }
    for (const r of jl?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: r.type,
            displayName: r.display_name,
            location: r.location,
            userId: r.user_id,
            time: r.time
        });
    }
    for (const r of portal?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'PortalSpawn',
            displayName: r.display_name,
            location: r.location,
            userId: r.user_id,
            instanceId: r.instance_id,
            worldName: r.world_name
        });
    }
    for (const r of video?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'VideoPlay',
            videoUrl: r.video_url,
            videoName: r.video_name,
            videoId: r.video_id,
            location: r.location,
            displayName: r.display_name,
            userId: r.user_id
        });
    }
    for (const r of ev?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'Event',
            data: r.data
        });
    }
    for (const r of ext?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'External',
            message: r.message,
            displayName: r.display_name,
            userId: r.user_id,
            location: r.location
        });
    }

    out.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    return out;
}

export async function handleEventsDataRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // ===== GAMELOG =====
    if (url.pathname === '/api/gamelog/current-instance' && request.method === 'GET') {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const cutoffMs = nowMs - 24 * 3600_000;
        const cutoffIso = new Date(cutoffMs).toISOString();

        const [cfgRes, devicesRes, statesRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
            env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices'),
            env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states')
        ]);

        let syncIntervalSeconds = 60;
        const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
        if (cfgRow?.payload_json) {
            try {
                const parsed = JSON.parse(cfgRow.payload_json) as Record<string, unknown>;
                syncIntervalSeconds = parseCloudSyncIntervalSeconds(parsed['cloud:syncIntervalSeconds']);
            } catch {
                // Keep default
            }
        }
        const { httpAgentsOnline } = resolveRecentHttpAgents(
            (devicesRes?.results ?? []) as Array<{ device_id: string; last_seen_at?: string | null }>,
            nowMs,
            getAgentOnlineWindowMs(syncIntervalSeconds)
        );
        const onlineSet = new Set(httpAgentsOnline);

        interface ActiveDeviceSnapshot {
            location: string;
            worldName: string;
            updatedAt: string;
            currentPlayers: Array<{ displayName: string; userId: string; joinedAt?: string }> | null;
        }
        let activeSnapshot: ActiveDeviceSnapshot | null = null;
        for (const rawRow of (statesRes?.results ?? []) as Array<{
            device_id?: string;
            state_json?: string;
            updated_at?: string;
        }>) {
            const devId = rawRow.device_id ?? '';
            if (!devId || !onlineSet.has(devId) || !rawRow.state_json) continue;
            try {
                const st = JSON.parse(rawRow.state_json) as Record<string, unknown>;
                if (st.vrcRunning !== true && st.isGameRunning !== true) continue;
                const loc = typeof st.currentLocation === 'string' ? st.currentLocation.trim() : '';
                const worldName = typeof st.currentWorldName === 'string' ? st.currentWorldName.trim() : '';
                const players = Array.isArray(st.currentPlayers)
                    ? st.currentPlayers
                          .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
                          .map((p) => ({
                              displayName: typeof p.displayName === 'string' ? p.displayName : '',
                              userId: typeof p.userId === 'string' ? p.userId : '',
                              joinedAt: typeof p.joinedAt === 'string' ? p.joinedAt : undefined
                          }))
                          .filter((p) => Boolean(p.displayName || p.userId))
                    : null;
                const updatedAt = rawRow.updated_at || nowIso;
                if (
                    !activeSnapshot ||
                    (Boolean(loc) && !activeSnapshot.location) ||
                    (Boolean(loc) === Boolean(activeSnapshot.location) && updatedAt > activeSnapshot.updatedAt)
                ) {
                    activeSnapshot = { location: loc, worldName, updatedAt, currentPlayers: players };
                }
            } catch {
                // Skip malformed device state
            }
        }

        const [latestLocRes, latestJlRes] = await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT 1'),
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_join_leave ORDER BY created_at DESC LIMIT 1')
        ]);
        const latestLoc = (latestLocRes?.results?.[0] ?? null) as Record<string, unknown> | null;
        const latestJl = (latestJlRes?.results?.[0] ?? null) as Record<string, unknown> | null;

        const latestLocCreatedAt = typeof latestLoc?.created_at === 'string' ? latestLoc.created_at : '';
        const latestLocValid24h = Boolean(latestLocCreatedAt && latestLocCreatedAt >= cutoffIso);
        const latestLocTag = typeof latestLoc?.location === 'string' ? latestLoc.location.trim() : '';
        const latestJlCreatedAt = typeof latestJl?.created_at === 'string' ? latestJl.created_at : '';
        const latestJlValid24h = Boolean(latestJlCreatedAt && latestJlCreatedAt >= cutoffIso);
        const latestJlTag = typeof latestJl?.location === 'string' ? latestJl.location.trim() : '';

        // Path A: Online v1.10.5+ Agent provided an authoritative live currentPlayers snapshot for an active room.
        if (activeSnapshot?.location && activeSnapshot.currentPlayers !== null) {
            const worldId = activeSnapshot.location.split(':')[0] ?? '';
            const earliestJoin = activeSnapshot.currentPlayers
                .map((p) => p.joinedAt || '')
                .filter(Boolean)
                .sort()[0];
            const locCreatedAt =
                latestLocValid24h && (!latestLocTag || latestLocTag === activeSnapshot.location)
                    ? latestLocCreatedAt
                    : earliestJoin || activeSnapshot.updatedAt;
            const out: Array<Record<string, unknown>> = [
                {
                    rowId: Number(latestLoc?.id ?? 0),
                    created_at: locCreatedAt,
                    type: 'Location',
                    location: activeSnapshot.location,
                    worldId,
                    worldName: activeSnapshot.worldName || String(latestLoc?.world_name ?? ''),
                    time: Number(latestLoc?.time ?? 0),
                    groupName: String(latestLoc?.group_name ?? '')
                }
            ];
            const sortedPlayers = [...activeSnapshot.currentPlayers].sort((a, b) =>
                String(a.joinedAt || locCreatedAt).localeCompare(String(b.joinedAt || locCreatedAt))
            );
            for (const p of sortedPlayers) {
                out.push({
                    rowId: 0,
                    created_at: p.joinedAt || locCreatedAt,
                    type: 'OnPlayerJoined',
                    displayName: p.displayName,
                    location: activeSnapshot.location,
                    userId: p.userId,
                    time: 0
                });
            }
            return Response.json({ ok: true, data: out });
        }

        // Path B: Replay DB_GAMELOG join/leave events chronologically (also handles legacy v1.10.4 empty/shifted Location rows).
        let resolvedLocation = activeSnapshot?.location || '';
        if (!resolvedLocation && latestJlValid24h && latestJlTag) {
            if (!latestLocValid24h || !latestLocTag || latestJlCreatedAt >= latestLocCreatedAt) {
                resolvedLocation = latestJlTag;
            }
        }
        if (!resolvedLocation && latestLocValid24h && latestLocTag) {
            resolvedLocation = latestLocTag;
        }
        if (!resolvedLocation) {
            return Response.json({ ok: true, data: [] });
        }

        const locTimeMs = latestLocValid24h ? Date.parse(latestLocCreatedAt) : NaN;
        const querySinceIso = Number.isFinite(locTimeMs)
            ? new Date(Math.max(locTimeMs - 2000, cutoffMs)).toISOString()
            : cutoffIso;

        const jlRangeRes = await env.DB_GAMELOG.prepare(
            'SELECT * FROM gamelog_join_leave WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500'
        )
            .bind(querySinceIso)
            .all<Record<string, unknown>>();

        let jlRows = (jlRangeRes.results ?? []).filter((r) => {
            const rLoc = typeof r.location === 'string' ? r.location.trim() : '';
            return !rLoc || rLoc === resolvedLocation;
        });

        if (jlRows.length === 0) {
            const byLocRes = await env.DB_GAMELOG.prepare(
                'SELECT * FROM gamelog_join_leave WHERE location = ? AND created_at >= ? ORDER BY id DESC LIMIT 200'
            )
                .bind(resolvedLocation, cutoffIso)
                .all<Record<string, unknown>>();
            jlRows = [...(byLocRes.results ?? [])].sort((a, b) =>
                String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
            );
        }

        const worldId = resolvedLocation.split(':')[0] ?? '';
        const locCreatedAt =
            (latestLocValid24h ? latestLocCreatedAt : '') ||
            (typeof jlRows[0]?.created_at === 'string' ? jlRows[0].created_at : '') ||
            nowIso;
        const worldName = activeSnapshot?.worldName || (latestLocValid24h ? String(latestLoc?.world_name ?? '') : '');

        const out: Array<Record<string, unknown>> = [
            {
                rowId: Number(latestLoc?.id ?? 0),
                created_at: locCreatedAt,
                type: 'Location',
                location: resolvedLocation,
                worldId,
                worldName,
                time: Number(latestLoc?.time ?? 0),
                groupName: String(latestLoc?.group_name ?? '')
            }
        ];
        for (const r of jlRows) {
            out.push({
                rowId: r.id,
                created_at: r.created_at,
                type: r.type,
                displayName: r.display_name,
                location: r.location || resolvedLocation,
                userId: r.user_id,
                time: r.time
            });
        }
        return Response.json({ ok: true, data: out });
    }

    if (url.pathname === '/api/gamelog') {
        if (request.method === 'GET') {
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const perTable = Math.max(10, Math.min(limit, 50));
            const results = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT ?').bind(
                    perTable
                ),
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_join_leave ORDER BY created_at DESC LIMIT ?').bind(
                    perTable
                ),
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_portal_spawn ORDER BY created_at DESC LIMIT ?').bind(
                    perTable
                ),
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_video_play ORDER BY created_at DESC LIMIT ?').bind(
                    perTable
                ),
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_event ORDER BY created_at DESC LIMIT ?').bind(perTable),
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_external ORDER BY created_at DESC LIMIT ?').bind(perTable)
            ]);
            const rows = normalizeGameLogRows(results as D1Result<Record<string, unknown>>[]).slice(0, limit);
            return Response.json({ ok: true, data: rows });
        }

        if (request.method === 'POST') {
            const body = (await request.json()) as { items?: GameLogIngestItem[]; item?: GameLogIngestItem };
            const items = body.items ?? (body.item ? [body.item] : []);
            const res = await ingestGameLogItems(env, items.slice(0, 100));
            return Response.json({ ok: true, data: res });
        }

        if (request.method === 'PATCH') {
            const body = (await request.json()) as {
                op: 'update_location_time' | 'update_video_name';
                created_at?: string;
                location?: string;
                time?: number;
                videoUrl?: string;
                videoName?: string;
                videoId?: string;
            };
            if (body.op === 'update_location_time' && body.created_at && body.location) {
                await env.DB_GAMELOG.prepare(
                    'UPDATE gamelog_location SET time = ? WHERE created_at = ? AND location = ?'
                )
                    .bind(body.time ?? 0, body.created_at, body.location)
                    .run();
            } else if (body.op === 'update_video_name' && body.videoUrl) {
                await env.DB_GAMELOG.prepare(
                    'UPDATE gamelog_video_play SET video_name = ?, video_id = ? WHERE video_url = ?'
                )
                    .bind(body.videoName ?? '', body.videoId ?? '', body.videoUrl)
                    .run();
            }
            return Response.json({ ok: true });
        }

        if (request.method === 'DELETE') {
            const kind = url.searchParams.get('kind') ?? '';
            const rowId = Number(url.searchParams.get('rowId') ?? '0');
            const location = url.searchParams.get('location') ?? '';
            if (kind === 'instance' && location) {
                await env.DB_GAMELOG.batch([
                    env.DB_GAMELOG.prepare('DELETE FROM gamelog_location WHERE location = ?').bind(location),
                    env.DB_GAMELOG.prepare('DELETE FROM gamelog_join_leave WHERE location = ?').bind(location)
                ]);
                return Response.json({ ok: true });
            }
            const tableMap: Record<string, string> = {
                Location: 'gamelog_location',
                OnPlayerJoined: 'gamelog_join_leave',
                OnPlayerLeft: 'gamelog_join_leave',
                PortalSpawn: 'gamelog_portal_spawn',
                VideoPlay: 'gamelog_video_play',
                Event: 'gamelog_event',
                External: 'gamelog_external'
            };
            const table = tableMap[kind];
            if (table && rowId > 0) {
                await env.DB_GAMELOG.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(rowId).run();
            }
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/gamelog/search' && request.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        const explain = url.searchParams.get('explain') === '1';
        const result = await searchGameLogByEntity(env, q, { limit, includeExplain: explain });
        return Response.json({ ok: true, data: result });
    }

    if (url.pathname === '/api/gamelog/by-location' && request.method === 'GET') {
        const location = url.searchParams.get('location') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 100);
        if (!location) {
            return Response.json({ ok: true, data: [] });
        }
        const [locRes, jlRes] = await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            ),
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_join_leave WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            )
        ]);
        const rows = normalizeGameLogRows([
            locRes as D1Result<Record<string, unknown>>,
            jlRes as D1Result<Record<string, unknown>>
        ]);
        return Response.json({ ok: true, data: rows });
    }

    if (url.pathname === '/api/gamelog/stats' && request.method === 'GET') {
        const kind = url.searchParams.get('kind') ?? '';
        const worldId = url.searchParams.get('worldId') ?? '';
        const userId = url.searchParams.get('userId') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 50);

        if (kind === 'world' && worldId) {
            const [agg, lastVisit, recent] = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    'SELECT COUNT(*) AS visitCount, COALESCE(SUM(time), 0) AS totalTime FROM gamelog_location WHERE world_id = ?'
                ).bind(worldId),
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, world_name FROM gamelog_location WHERE world_id = ? ORDER BY id DESC LIMIT 1'
                ).bind(worldId),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE world_id = ? ORDER BY id DESC LIMIT ?'
                ).bind(worldId, limit)
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { visitCount?: number; totalTime?: number };
            const lastRow = (lastVisit?.results?.[0] ?? {}) as { created_at?: string; world_name?: string };
            return Response.json({
                ok: true,
                data: {
                    visitCount: aggRow.visitCount ?? 0,
                    timeSpent: aggRow.totalTime ?? 0,
                    lastVisit: lastRow.created_at ?? '',
                    worldName: lastRow.world_name ?? '',
                    instances: recent?.results ?? []
                }
            });
        }

        if (kind === 'user' && userId) {
            const [agg, lastSeen, recent] = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "SELECT COUNT(*) AS joinCount, COALESCE(SUM(time), 0) AS totalTime FROM gamelog_join_leave WHERE user_id = ? AND type = 'OnPlayerLeft'"
                ).bind(userId),
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, display_name FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT 1'
                ).bind(userId),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT ?'
                ).bind(userId, limit)
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { joinCount?: number; totalTime?: number };
            const lastRow = (lastSeen?.results?.[0] ?? {}) as { created_at?: string; display_name?: string };
            return Response.json({
                ok: true,
                data: {
                    joinCount: aggRow.joinCount ?? 0,
                    timeSpent: aggRow.totalTime ?? 0,
                    lastSeen: lastRow.created_at ?? '',
                    lastDisplayName: lastRow.display_name ?? '',
                    recentEvents: recent?.results ?? []
                }
            });
        }

        if (kind === 'top_worlds') {
            const rows = await env.DB_GAMELOG.prepare(
                `SELECT world_id, MAX(world_name) AS world_name, COUNT(*) AS visits, COALESCE(SUM(time), 0) AS total_time
                 FROM (SELECT world_id, world_name, time FROM gamelog_location ORDER BY id DESC LIMIT 500)
                 WHERE world_id != ''
                 GROUP BY world_id
                 ORDER BY total_time DESC
                 LIMIT ?`
            )
                .bind(Math.min(limit, 20))
                .all();
            return Response.json({ ok: true, data: rows.results ?? [] });
        }

        if (kind === 'last_date') {
            const row = await env.DB_GAMELOG.prepare(
                'SELECT created_at FROM gamelog_location ORDER BY id DESC LIMIT 1'
            ).first<{
                created_at: string;
            }>();
            return Response.json({ ok: true, data: { lastDate: row?.created_at ?? '' } });
        }

        if (kind === 'sessions_segments') {
            const beforeId = Number(url.searchParams.get('beforeId') ?? '0');
            const segs =
                beforeId > 0
                    ? await env.DB_GAMELOG.prepare(
                          'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE id < ? ORDER BY id DESC LIMIT ?'
                      )
                          .bind(beforeId, limit)
                          .all()
                    : await env.DB_GAMELOG.prepare(
                          'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location ORDER BY id DESC LIMIT ?'
                      )
                          .bind(limit)
                          .all();
            return Response.json({ ok: true, data: segs.results ?? [] });
        }

        return Response.json({ ok: true, data: {} });
    }

    // ===== FEED =====
    if (url.pathname === '/api/feed') {
        if (request.method === 'GET') {
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const perTable = Math.max(10, Math.min(limit, 50));
            const [gps, oo, status, bio] = await env.DB_FEED.batch([
                env.DB_FEED.prepare('SELECT * FROM feed_gps ORDER BY id DESC LIMIT ?').bind(perTable),
                env.DB_FEED.prepare('SELECT * FROM feed_online_offline ORDER BY id DESC LIMIT ?').bind(perTable),
                env.DB_FEED.prepare('SELECT * FROM feed_status ORDER BY id DESC LIMIT ?').bind(perTable),
                env.DB_FEED.prepare('SELECT * FROM feed_bio ORDER BY id DESC LIMIT ?').bind(perTable)
            ]);

            const items: Array<Record<string, unknown>> = [];
            for (const r of (gps?.results ?? []) as Array<Record<string, unknown>>) {
                items.push({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'GPS',
                    userId: r.user_id,
                    displayName: r.display_name,
                    location: r.location,
                    worldName: r.world_name,
                    previousLocation: r.previous_location,
                    time: r.time,
                    groupName: r.group_name
                });
            }
            for (const r of (oo?.results ?? []) as Array<Record<string, unknown>>) {
                items.push({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: r.type,
                    userId: r.user_id,
                    displayName: r.display_name,
                    location: r.location,
                    worldName: r.world_name,
                    time: r.time,
                    groupName: r.group_name
                });
            }
            for (const r of (status?.results ?? []) as Array<Record<string, unknown>>) {
                items.push({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'Status',
                    userId: r.user_id,
                    displayName: r.display_name,
                    status: r.status,
                    statusDescription: r.status_description,
                    previousStatus: r.previous_status,
                    previousStatusDescription: r.previous_status_description
                });
            }
            for (const r of (bio?.results ?? []) as Array<Record<string, unknown>>) {
                items.push({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'Bio',
                    userId: r.user_id,
                    displayName: r.display_name,
                    bio: r.bio,
                    previousBio: r.previous_bio,
                    bioLinks: JSON.parse(String(r.bio_links ?? '[]')),
                    previousBioLinks: JSON.parse(String(r.previous_bio_links ?? '[]'))
                });
            }

            items.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
            return Response.json({ ok: true, data: items.slice(0, limit) });
        }

        if (request.method === 'POST') {
            const body = (await request.json()) as {
                items: Array<Record<string, unknown>>;
            };
            const list = (body.items ?? []).slice(0, 50);
            const result = await ingestFeedItems(env, list);
            return Response.json({ ok: true, data: result });
        }
    }

    if (url.pathname === '/api/feed/search' && request.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        if (!q) {
            return Response.json({ ok: true, data: [] });
        }
        // Resolve matching user_ids via deduplicated FTS5 trigram dictionary in DB_CORE
        let userIds: string[] = [];
        if (q.startsWith('usr_')) {
            userIds = [q];
        } else if (Array.from(q).length >= 3) {
            const matchExpr = buildSafeTrigramMatch(q);
            const res = await env.DB_CORE.prepare(
                `SELECT u.user_id FROM entity_users_fts f
                 JOIN entity_users u ON u.rowid = f.rowid
                 WHERE entity_users_fts MATCH ? LIMIT 30`
            )
                .bind(matchExpr)
                .all<{ user_id: string }>();
            userIds = (res.results ?? []).map((r) => r.user_id);
        } else {
            const res = await env.DB_CORE.prepare(
                `SELECT user_id FROM (SELECT user_id, display_name FROM entity_users ORDER BY rowid DESC LIMIT 50)
                 WHERE display_name LIKE ? LIMIT 20`
            )
                .bind(`%${q}%`)
                .all<{ user_id: string }>();
            userIds = (res.results ?? []).map((r) => r.user_id);
        }

        if (userIds.length === 0) {
            return Response.json({ ok: true, data: [] });
        }
        const ph = userIds.map(() => '?').join(', ');
        const [gps, oo, status] = await env.DB_FEED.batch([
            env.DB_FEED.prepare(
                `SELECT *, 'GPS' AS _kind FROM feed_gps WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
            ).bind(...userIds, limit),
            env.DB_FEED.prepare(
                `SELECT *, type AS _kind FROM feed_online_offline WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
            ).bind(...userIds, limit),
            env.DB_FEED.prepare(
                `SELECT *, 'Status' AS _kind FROM feed_status WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
            ).bind(...userIds, limit)
        ]);
        const merged = [...(gps?.results ?? []), ...(oo?.results ?? []), ...(status?.results ?? [])] as Array<
            Record<string, unknown>
        >;
        merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return Response.json({ ok: true, data: merged.slice(0, limit) });
    }

    // ===== ACTIVITY SESSIONS V2 =====
    if (url.pathname === '/api/activity/sessions') {
        if (request.method === 'GET') {
            const userId = url.searchParams.get('userId') ?? '';
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const res = await env.DB_FEED.prepare(
                'SELECT session_id, user_id, start_at, end_at, is_open_tail, source_revision FROM activity_sessions_v2 WHERE user_id = ? ORDER BY start_at DESC LIMIT ?'
            )
                .bind(userId, limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = (await request.json()) as {
                userId: string;
                replace?: boolean;
                sessions: Array<{ startAt: number; endAt: number; isOpenTail?: boolean; sourceRevision?: string }>;
            };
            const stmts: D1PreparedStatement[] = [];
            if (body.replace) {
                stmts.push(env.DB_FEED.prepare('DELETE FROM activity_sessions_v2 WHERE user_id = ?').bind(body.userId));
            }
            for (const s of (body.sessions ?? []).slice(0, 40)) {
                stmts.push(
                    env.DB_FEED.prepare(
                        'INSERT INTO activity_sessions_v2 (user_id, start_at, end_at, is_open_tail, source_revision) VALUES (?, ?, ?, ?, ?)'
                    ).bind(body.userId, s.startAt, s.endAt, s.isOpenTail ? 1 : 0, s.sourceRevision ?? '')
                );
            }
            if (stmts.length > 0) {
                await env.DB_FEED.batch(stmts);
            }
            return Response.json({ ok: true });
        }
    }

    return null;
}
