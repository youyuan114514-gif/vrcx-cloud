import { reactive } from 'vue';

export const DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS = 60;
export const MIN_CLOUD_SYNC_INTERVAL_SECONDS = 30;
export const MAX_CLOUD_SYNC_INTERVAL_SECONDS = 3600;
export const DEFAULT_WEB_SYNC_INTERVAL_SECONDS = 300;
export const MIN_WEB_SYNC_INTERVAL_SECONDS = 60;

/**
 * Normalizes a user or server-supplied VRCX.Agent sync interval into [30, 3600] seconds (default 60s).
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function clampSyncIntervalSeconds(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS;
    }
    return Math.min(Math.max(Math.round(n), MIN_CLOUD_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Normalizes a user or server-supplied Cloud/Web sync interval into [60, 3600] seconds (default 300s = 5 min).
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function clampWebSyncIntervalSeconds(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_WEB_SYNC_INTERVAL_SECONDS;
    }
    return Math.min(Math.max(Math.round(n), MIN_WEB_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Shared reactive telemetry and authentication state for Cloudflare Web mode.
 * Purely in-memory: clearing browser cache or using incognito recovers everything from cloud.
 */
export const cloudState = reactive({
    initialized: false,
    authenticated: true,
    authMode: 'open_setup',
    requiresTotp: false,
    subject: '',
    wsConnected: false,
    r2Enabled: false,
    cloudFallbackAllowed: true,
    /** Authoritative VRCX.Agent periodic upload interval in seconds (default 60s). */
    syncIntervalSeconds: DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS,
    /**
     * Authoritative Cloud/Web sync interval in seconds (default 300s = 5 min) for Web throttling and offline Cron Feed
     * sync.
     */
    webSyncIntervalSeconds: DEFAULT_WEB_SYNC_INTERVAL_SECONDS,
    /** @type {'agent_residential_ip' | 'cloud_direct' | 'offline' | ''} */
    lastVrcRoute: '',
    /** @type {string[]} All active/known companion devices (WS + HTTP sync). */
    agentsOnline: [],
    /** @type {string[]} Only devices with an active /ws/agent socket capable of vrc-http RPC relay. */
    wsAgentsOnline: [],
    /** @type {Record<string, number>} Map of deviceId -> last_seen epoch ms for HTTP periodic sync companions. */
    deviceLastSeen: {},
    /** @type {Record<string, { state: Record<string, any>; updatedAt: string }>} */
    deviceStates: {},
    /** Persistent cumulative cloud uptime seconds (web + background VRCX.Agent) synced from D1. */
    totalUptimeBaseSeconds: 0,
    /** Local epoch ms when `totalUptimeBaseSeconds` was last synced from server (0 before bootstrap). */
    totalUptimeSyncedAt: 0,
    hubDialogOpen: false
});

/**
 * Online recency window for HTTP periodic sync companions (at least 5 minutes, or 3x sync interval).
 *
 * @returns {number}
 */
export function getAgentOnlineWindowMs() {
    return Math.max(clampSyncIntervalSeconds(cloudState.syncIntervalSeconds) * 3, 300) * 1000;
}

/**
 * Returns deduplicated IDs of all currently online VRCX.Agent companions (both WebSocket and active HTTP sync).
 *
 * @param {number} [nowMs]
 * @returns {string[]}
 */
export function getOnlineAgentIds(nowMs = Date.now()) {
    const windowMs = getAgentOnlineWindowMs();
    const active = new Set(cloudState.wsAgentsOnline);
    for (const [deviceId, lastSeenMs] of Object.entries(cloudState.deviceLastSeen)) {
        if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= windowMs) {
            active.add(deviceId);
        }
    }
    return Array.from(active);
}

/**
 * Aggregates live VRChat and SteamVR running flags across ALL currently online VRCX.Agent devices.
 * If any online PC is running VRChat or SteamVR, the corresponding status indicator turns green.
 *
 * @param {number} [nowMs]
 * @returns {{ vrcRunning: boolean; steamVrRunning: boolean }}
 */
export function getAggregatedGameState(nowMs = Date.now()) {
    let vrcRunning = false;
    let steamVrRunning = false;
    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const st = cloudState.deviceStates[deviceId]?.state;
        if (!st || typeof st !== 'object') continue;
        if (st.vrcRunning === true || st.isGameRunning === true) {
            vrcRunning = true;
        }
        if (st.steamVrRunning === true || st.isVrRunning === true) {
            steamVrRunning = true;
        }
        if (vrcRunning && steamVrRunning) break;
    }
    return { vrcRunning, steamVrRunning };
}

/**
 * Aggregates the earliest VRChat and SteamVR process start timestamps across currently online VRCX.Agent devices.
 * Falls back to device `updatedAt` when an older agent has not yet reported `vrcStartedAt` / `steamVrStartedAt`.
 *
 * @param {number} [nowMs]
 * @returns {{ vrcStartedAtMs: number; steamVrStartedAtMs: number }}
 */
export function getAggregatedGameStartTimes(nowMs = Date.now()) {
    let earliestVrcMs = 0;
    let earliestSteamMs = 0;

    const parseStartMs = (raw, fallbackIso) => {
        const primary = typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
        const fallback = typeof fallbackIso === 'string' && fallbackIso ? Date.parse(fallbackIso) : NaN;
        const ts = Number.isFinite(primary) && primary > 0 ? primary : fallback;
        if (!Number.isFinite(ts) || ts <= 0) return 0;
        return Math.min(ts, nowMs);
    };

    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const entry = cloudState.deviceStates[deviceId];
        const st = entry?.state;
        if (!st || typeof st !== 'object') continue;

        if (st.vrcRunning === true || st.isGameRunning === true) {
            const vrcTs = parseStartMs(st.vrcStartedAt, entry?.updatedAt);
            if (vrcTs > 0 && (earliestVrcMs === 0 || vrcTs < earliestVrcMs)) {
                earliestVrcMs = vrcTs;
            }
        }
        if (st.steamVrRunning === true || st.isVrRunning === true) {
            const steamTs = parseStartMs(st.steamVrStartedAt, entry?.updatedAt);
            if (steamTs > 0 && (earliestSteamMs === 0 || steamTs < earliestSteamMs)) {
                earliestSteamMs = steamTs;
            }
        }
    }

    return { vrcStartedAtMs: earliestVrcMs, steamVrStartedAtMs: earliestSteamMs };
}

let lastCloudInstanceSignature = '';

/**
 * Computes a compact signature of online VRChat room & player snapshots so the Web PlayerList
 * refreshes automatically whenever HTTP-synced VRCX.Agent uploads a room change or player join/leave.
 *
 * @param {number} [nowMs]
 * @returns {string}
 */
function getActiveCloudInstanceSignature(nowMs = Date.now()) {
    const parts = [];
    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const entry = cloudState.deviceStates[deviceId];
        const st = entry?.state;
        if (!st || typeof st !== 'object') continue;
        if (st.vrcRunning !== true && st.isGameRunning !== true) continue;
        const playerSig = Array.isArray(st.currentPlayers)
            ? st.currentPlayers
                  .map((p) => `${p?.userId || ''}:${p?.displayName || ''}`)
                  .sort()
                  .join(',')
            : String(st.playerCount ?? '');
        parts.push(
            `${deviceId}|${st.currentLocation || ''}|${st.currentWorldName || ''}|${playerSig}|${entry?.updatedAt || ''}`
        );
    }
    return parts.sort().join(';');
}

/**
 * Synchronizes aggregated multi-PC game/SteamVR running state and process start times into upstream `window.$bridge`.
 *
 * @param {number} [nowMs]
 */
export function syncGameRunningBridge(nowMs = Date.now()) {
    if (typeof window === 'undefined' || !window.$bridge?.updateIsGameRunning) {
        return;
    }
    const { vrcRunning, steamVrRunning } = getAggregatedGameState(nowMs);
    const startTimes = getAggregatedGameStartTimes(nowMs);
    window.$bridge.updateCloudGameStartTimes?.(startTimes);
    window.$bridge.updateIsGameRunning(vrcRunning, steamVrRunning);

    const nextSig = vrcRunning ? getActiveCloudInstanceSignature(nowMs) : '';
    if (vrcRunning && nextSig && nextSig !== lastCloudInstanceSignature) {
        lastCloudInstanceSignature = nextSig;
        window.$bridge.refreshCloudPlayerList?.();
    } else if (!vrcRunning) {
        lastCloudInstanceSignature = '';
    }
}

/**
 * Applies server-reported HTTP agent presence, device states, and optional cumulative uptime snapshot to `cloudState`.
 *
 * @param {{
 *     deviceLastSeen?: Record<string, number>;
 *     httpAgentsOnline?: string[];
 *     deviceStates?: Record<string, { state: Record<string, any>; updatedAt: string }>;
 *     totalUptimeSeconds?: number;
 *     syncIntervalSeconds?: number;
 *     webSyncIntervalSeconds?: number;
 *     replaceDeviceMap?: boolean;
 * }} payload
 */
export function applyCloudPresenceUpdate(payload) {
    if (!payload) return;
    const nowMs = Date.now();
    if (payload.syncIntervalSeconds !== undefined) {
        cloudState.syncIntervalSeconds = clampSyncIntervalSeconds(payload.syncIntervalSeconds);
    }
    if (payload.webSyncIntervalSeconds !== undefined) {
        cloudState.webSyncIntervalSeconds = clampWebSyncIntervalSeconds(payload.webSyncIntervalSeconds);
    }
    if (payload.deviceLastSeen && typeof payload.deviceLastSeen === 'object') {
        if (payload.replaceDeviceMap) {
            cloudState.deviceLastSeen = {};
        }
        for (const [deviceId, ts] of Object.entries(payload.deviceLastSeen)) {
            const num = Number(ts);
            if (deviceId && Number.isFinite(num)) {
                cloudState.deviceLastSeen[deviceId] = num;
            }
        }
    }
    if (Array.isArray(payload.httpAgentsOnline)) {
        for (const deviceId of payload.httpAgentsOnline) {
            if (deviceId && !Number.isFinite(cloudState.deviceLastSeen[deviceId])) {
                cloudState.deviceLastSeen[deviceId] = nowMs;
            }
        }
    }
    if (payload.deviceStates && typeof payload.deviceStates === 'object') {
        for (const [deviceId, entry] of Object.entries(payload.deviceStates)) {
            if (!deviceId || !entry || typeof entry !== 'object') continue;
            cloudState.deviceStates[deviceId] = {
                state: entry.state && typeof entry.state === 'object' ? entry.state : {},
                updatedAt: entry.updatedAt || new Date(nowMs).toISOString()
            };
        }
    }
    cloudState.agentsOnline = getOnlineAgentIds(nowMs);
    if (payload.totalUptimeSeconds !== undefined) {
        const nextBase = Math.max(0, Math.floor(Number(payload.totalUptimeSeconds) || 0));
        cloudState.totalUptimeBaseSeconds = nextBase;
        cloudState.totalUptimeSyncedAt = nowMs;
    }
    syncGameRunningBridge(nowMs);
}

export function isAnyAgentOnline(nowMs = Date.now()) {
    return getOnlineAgentIds(nowMs).length > 0;
}

export function getPrimaryAgentState() {
    const firstId = getOnlineAgentIds()[0] || Object.keys(cloudState.deviceStates)[0];
    if (!firstId) return null;
    return cloudState.deviceStates[firstId]?.state ?? null;
}
