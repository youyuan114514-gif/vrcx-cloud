import { cloudFetch } from './apiClient.js';
import { clampWebSyncIntervalSeconds, cloudState } from './cloudState.js';

const MAX_CACHE_ENTRIES = 800;
const MAX_BATCH_SIZE = 12;

/**
 * Classifies read-only VRChat GET requests into tiered cache TTL categories so stable entity
 * metadata (worlds/avatars/groups/config/status) is not refetched every 60s while auth probes
 * and write requests always bypass cache.
 *
 * @param {Record<string, any>} options
 * @returns {'static' | 'entity' | 'dynamic' | 'volatile' | null}
 */
function classifyThrottleableReadGet(options) {
    if (!options || typeof options !== 'object') return null;
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') return null;
    if (options.uploadImage || options.uploadFilePUT || options.uploadImageLegacy || options.uploadPrintImage) {
        return null;
    }
    if (options.headers && (options.headers.Authorization || options.headers.authorization)) {
        return null;
    }
    const rawUrl = String(options.url || '');
    if (!rawUrl) return null;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (parsed.hostname === 'status.vrchat.com') {
        return 'static';
    }
    if (parsed.hostname !== 'api.vrchat.cloud') {
        return null;
    }
    const p = parsed.pathname;
    // Never cache direct login/auth/2FA/logout probes
    if (p === '/api/1/auth' || p === '/api/1/auth/user' || p === '/api/1/logout') {
        return null;
    }
    if (p === '/api/1/config' || p === '/api/1/auth/permissions') {
        return 'static';
    }
    if (
        p.startsWith('/api/1/worlds/') ||
        p.startsWith('/api/1/avatars/') ||
        p.startsWith('/api/1/groups/') ||
        p.startsWith('/api/1/file/') ||
        p.startsWith('/api/1/prints')
    ) {
        return 'entity';
    }
    if (p.startsWith('/api/1/users/') || p.startsWith('/api/1/instances/')) {
        return 'dynamic';
    }
    if (
        p.startsWith('/api/1/auth/user/') ||
        p.startsWith('/api/1/favorites') ||
        p.startsWith('/api/1/notifications') ||
        p.startsWith('/api/1/inventory') ||
        p.startsWith('/api/1/user/') ||
        p === '/api/1/visits'
    ) {
        return 'volatile';
    }
    return null;
}

/**
 * Computes tiered TTL in milliseconds respecting the user's independent Web/Cloud sync interval.
 *
 * @param {'static' | 'entity' | 'dynamic' | 'volatile'} tier
 * @returns {number}
 */
function getTierTtlMs(tier) {
    const baseSec = clampWebSyncIntervalSeconds(cloudState.webSyncIntervalSeconds);
    if (tier === 'static') return Math.max(600, baseSec) * 1000;
    if (tier === 'entity') return Math.max(300, baseSec) * 1000;
    if (tier === 'dynamic') return Math.max(120, baseSec) * 1000;
    return baseSec * 1000;
}

/**
 * Browser-side WebApi bridge compatible with Dotnet/WebApi.cs and src/services/webapi.js.
 * Minimizes Cloudflare Worker requests by:
 * 1. Tiered read caching + in-flight deduplication across VRChat GET endpoints
 * 2. Targeted cache invalidation on writes (preserving static world/avatar/config caches)
 * 3. Same-tick microtask coalescing of concurrent read GETs into a single POST /api/vrc/execute-batch
 * 4. Bypassing AgentHubDO whenever no WebSocket RPC agent is connected (`preferCloudDirect: true`)
 */
export function createWebApiBridge() {
    /**
     * @type {Map<
     *     string,
     *     { expiresAt: number; responseJson: string; tier: 'static' | 'entity' | 'dynamic' | 'volatile' }
     * >}
     */
    const getCache = new Map();
    /** @type {Map<string, Promise<string>>} */
    const inflightGets = new Map();
    /**
     * @type {{
     *     options: Record<string, any>;
     *     cacheKey: string;
     *     tier: 'static' | 'entity' | 'dynamic' | 'volatile';
     *     resolve: (val: string) => void;
     * }[]}
     */
    let pendingBatch = [];
    let batchScheduled = false;

    function clearReadCache() {
        getCache.clear();
    }

    /**
     * Invalidates volatile lists and the mutated target URL while preserving stable entity/config caches.
     *
     * @param {string} writeUrl
     */
    function invalidateCacheForWrite(writeUrl) {
        let writePath = '';
        try {
            writePath = new URL(writeUrl).pathname;
        } catch {
            clearReadCache();
            return;
        }
        for (const [key, entry] of getCache.entries()) {
            if (entry.tier === 'volatile') {
                getCache.delete(key);
                continue;
            }
            if (entry.tier === 'dynamic' && (key.includes(writePath) || writePath.startsWith('/api/1/instances/'))) {
                getCache.delete(key);
                continue;
            }
            if (entry.tier === 'entity' && key.includes(writePath)) {
                getCache.delete(key);
            }
        }
    }

    function setCachedResponse(url, responseJson, tier) {
        if (getCache.size >= MAX_CACHE_ENTRIES) {
            const firstKey = getCache.keys().next().value;
            if (firstKey !== undefined) {
                getCache.delete(firstKey);
            }
        }
        getCache.set(url, {
            expiresAt: Date.now() + getTierTtlMs(tier),
            responseJson,
            tier
        });
    }

    function shouldPreferCloudDirect(options) {
        return Boolean(
            options &&
            typeof options === 'object' &&
            cloudState.wsAgentsOnline.length === 0 &&
            cloudState.cloudFallbackAllowed &&
            options.preferCloudDirect === undefined
        );
    }

    async function executeSingleRequest(options, cacheTier, cacheKey) {
        try {
            const payload = shouldPreferCloudDirect(options) ? { ...options, preferCloudDirect: true } : options;
            const data = await cloudFetch('/api/vrc/execute', {
                method: 'POST',
                json: payload
            });
            if (data?.route) {
                cloudState.lastVrcRoute = data.route;
            }
            const status = data?.status ?? 200;
            const serialized = JSON.stringify({
                status,
                message: data?.data ?? ''
            });
            if (cacheTier && status >= 200 && status < 300) {
                setCachedResponse(cacheKey, serialized, cacheTier);
            }
            return serialized;
        } catch (err) {
            if (err?.code === 'AGENT_OFFLINE_READONLY') {
                cloudState.lastVrcRoute = 'offline';
            }
            return JSON.stringify({
                status: -1,
                message: err instanceof Error ? err.message : String(err)
            });
        }
    }

    function flushGetBatch() {
        batchScheduled = false;
        const queued = pendingBatch;
        pendingBatch = [];
        if (queued.length === 0) return;

        // Single request in this microtask turn -> send via standard /api/vrc/execute with zero batch overhead.
        if (queued.length === 1) {
            const item = queued[0];
            executeSingleRequest(item.options, item.tier, item.cacheKey).then(item.resolve);
            return;
        }

        // Chunk into <= 12 GETs per Worker invocation (1 Worker request + 1 D1 cookie read per batch).
        for (let i = 0; i < queued.length; i += MAX_BATCH_SIZE) {
            const chunk = queued.slice(i, i + MAX_BATCH_SIZE);
            if (chunk.length === 1) {
                const item = chunk[0];
                executeSingleRequest(item.options, item.tier, item.cacheKey).then(item.resolve);
                continue;
            }

            cloudFetch('/api/vrc/execute-batch', {
                method: 'POST',
                json: {
                    requests: chunk.map((c) => ({
                        url: c.options.url,
                        method: 'GET',
                        headers: c.options.headers
                    }))
                }
            })
                .then((data) => {
                    if (data?.route) {
                        cloudState.lastVrcRoute = data.route;
                    }
                    const results = Array.isArray(data?.results) ? data.results : [];
                    chunk.forEach((item, idx) => {
                        const r = results[idx];
                        if (!r) {
                            item.resolve(JSON.stringify({ status: -1, message: 'Missing batch result' }));
                            return;
                        }
                        const status = r.status ?? 200;
                        const serialized = JSON.stringify({
                            status,
                            message: r.error ? String(r.error) : (r.data ?? '')
                        });
                        if (status >= 200 && status < 300) {
                            setCachedResponse(item.cacheKey, serialized, item.tier);
                        }
                        item.resolve(serialized);
                    });
                })
                .catch((err) => {
                    if (err?.code === 'AGENT_OFFLINE_READONLY') {
                        cloudState.lastVrcRoute = 'offline';
                    }
                    const errJson = JSON.stringify({
                        status: -1,
                        message: err instanceof Error ? err.message : String(err)
                    });
                    for (const item of chunk) {
                        item.resolve(errJson);
                    }
                });
        }
    }

    return {
        async ClearCookies() {
            clearReadCache();
            await cloudFetch('/api/vrc/cookies', { method: 'DELETE' });
        },

        async GetCookies() {
            const data = await cloudFetch('/api/vrc/cookies');
            return data?.cookies || '';
        },

        async SetCookies(cookie) {
            clearReadCache();
            await cloudFetch('/api/vrc/cookies', {
                method: 'PUT',
                json: { cookies: cookie || '' }
            });
        },

        async ExecuteJson(requestJson) {
            let options;
            try {
                options = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
            } catch {
                return JSON.stringify({ status: -1, message: 'Invalid request JSON' });
            }

            const method = String(options?.method || 'GET').toUpperCase();
            if (method !== 'GET') {
                invalidateCacheForWrite(String(options?.url || ''));
            }

            const cacheTier = classifyThrottleableReadGet(options);
            const cacheKey = cacheTier ? String(options.url) : '';
            if (cacheTier) {
                const cached = getCache.get(cacheKey);
                if (cached && cached.expiresAt > Date.now()) {
                    return cached.responseJson;
                }
                const existingFlight = inflightGets.get(cacheKey);
                if (existingFlight) {
                    return existingFlight;
                }
            }

            let execPromise;
            if (cacheTier && shouldPreferCloudDirect(options)) {
                execPromise = new Promise((resolve) => {
                    pendingBatch.push({ options, cacheKey, tier: cacheTier, resolve });
                    if (!batchScheduled) {
                        batchScheduled = true;
                        Promise.resolve().then(flushGetBatch);
                    }
                });
            } else {
                execPromise = executeSingleRequest(options, cacheTier, cacheKey);
            }

            if (cacheTier) {
                const tracked = execPromise.finally(() => {
                    inflightGets.delete(cacheKey);
                });
                inflightGets.set(cacheKey, tracked);
                return tracked;
            }
            return execPromise;
        },

        async Execute(options) {
            const jsonStr = await this.ExecuteJson(JSON.stringify(options));
            const parsed = JSON.parse(jsonStr);
            return {
                Item1: parsed.status,
                Item2: parsed.message
            };
        }
    };
}
