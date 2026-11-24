import { cloudState, syncGameRunningBridge } from './cloudState.js';

/** @type {WebSocket | null} */
let hubSocket = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pingTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let reconnectDelayMs = 2000;

/** @type {Array<(event: any) => void>} */
const gameLogListeners = [];
/** @type {Array<(msg: any) => void>} */
const commandResultListeners = [];

export function onCloudGameLogEvent(listener) {
    gameLogListeners.push(listener);
    return () => {
        const idx = gameLogListeners.indexOf(listener);
        if (idx >= 0) gameLogListeners.splice(idx, 1);
    };
}

export function onCloudCommandResult(listener) {
    commandResultListeners.push(listener);
    return () => {
        const idx = commandResultListeners.indexOf(listener);
        if (idx >= 0) commandResultListeners.splice(idx, 1);
    };
}

/**
 * Same-origin authenticated JSON API call to the Cloudflare Worker backend.
 *
 * @template [T=any]
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [options]
 * @returns {Promise<T>}
 */
export async function cloudFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (options.json !== undefined) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(options.json);
    }

    const res = await fetch(path, {
        ...options,
        headers,
        body,
        credentials: 'include'
    });

    if (res.status === 401 && !path.startsWith('/api/auth/')) {
        cloudState.authenticated = false;
        throw new Error('Cloud authentication required');
    }

    const text = await res.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`Invalid JSON from ${path} (HTTP ${res.status})`);
    }

    if (!res.ok || parsed?.ok === false) {
        const msg = parsed?.error?.message || `Request failed (${res.status})`;
        const err = new Error(msg);
        // @ts-ignore attach error code for callers
        err.code = parsed?.error?.code || `HTTP_${res.status}`;
        // @ts-ignore
        err.status = res.status;
        throw err;
    }

    return parsed.data;
}

function dispatchLiveGameState() {
    syncGameRunningBridge();
}

export function connectCloudHubWs() {
    if (typeof window === 'undefined' || !cloudState.authenticated) {
        return;
    }
    if (hubSocket && (hubSocket.readyState === WebSocket.OPEN || hubSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/web`;

    try {
        const ws = new WebSocket(wsUrl);
        hubSocket = ws;

        ws.onopen = () => {
            cloudState.wsConnected = true;
            reconnectDelayMs = 2000;
            if (pingTimer) clearInterval(pingTimer);
            // Matches AgentHubDO setWebSocketAutoResponse("ping", "pong") — reduced to 120s to minimize WS messages.
            pingTimer = setInterval(() => {
                if (
                    ws.readyState === WebSocket.OPEN &&
                    (typeof document === 'undefined' || document.visibilityState === 'visible')
                ) {
                    ws.send('ping');
                }
            }, 120_000);
        };

        ws.onmessage = (event) => {
            if (event.data === 'pong' || typeof event.data !== 'string') {
                return;
            }
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            if (msg.type === 'agent.online' && msg.payload?.deviceId) {
                const deviceId = msg.payload.deviceId;
                cloudState.deviceLastSeen[deviceId] = Date.now();
                if (!cloudState.wsAgentsOnline.includes(deviceId)) {
                    cloudState.wsAgentsOnline.push(deviceId);
                }
                if (!cloudState.agentsOnline.includes(deviceId)) {
                    cloudState.agentsOnline.push(deviceId);
                }
                dispatchLiveGameState();
            } else if (msg.type === 'agent.offline' && msg.payload?.deviceId) {
                const deviceId = msg.payload.deviceId;
                cloudState.wsAgentsOnline = cloudState.wsAgentsOnline.filter((id) => id !== deviceId);
                delete cloudState.deviceLastSeen[deviceId];
                cloudState.agentsOnline = cloudState.agentsOnline.filter((id) => id !== deviceId);
                dispatchLiveGameState();
            } else if (msg.type === 'agent.state' && msg.payload?.deviceId) {
                const { deviceId, ...rest } = msg.payload;
                cloudState.deviceStates[deviceId] = {
                    state: rest,
                    updatedAt: new Date().toISOString()
                };
                cloudState.deviceLastSeen[deviceId] = Date.now();
                if (!cloudState.agentsOnline.includes(deviceId)) {
                    cloudState.agentsOnline.push(deviceId);
                }
                // Only WS-connected agents can serve /rpc/vrc-http; HTTP periodic sync agents must not wake DO on VRChat calls.
                if (rest.syncMode !== 'http' && !cloudState.wsAgentsOnline.includes(deviceId)) {
                    cloudState.wsAgentsOnline.push(deviceId);
                }
                dispatchLiveGameState();
            } else if (msg.type === 'gamelog.batch' && Array.isArray(msg.payload?.events)) {
                for (const ev of msg.payload.events) {
                    for (const fn of gameLogListeners) {
                        try {
                            fn(ev);
                        } catch (err) {
                            console.error('[cloud] gameLog listener error', err);
                        }
                    }
                }
            } else if (msg.type === 'cmd.result') {
                for (const fn of commandResultListeners) {
                    try {
                        fn(msg);
                    } catch (err) {
                        console.error('[cloud] cmd result listener error', err);
                    }
                }
            }
        };

        ws.onclose = () => {
            cloudState.wsConnected = false;
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            if (hubSocket === ws) {
                hubSocket = null;
            }
            if (cloudState.authenticated) {
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => {
                    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
                    connectCloudHubWs();
                }, reconnectDelayMs);
            }
        };

        ws.onerror = () => {
            try {
                ws.close();
            } catch {
                // Ignore
            }
        };
    } catch (err) {
        console.warn('[cloud] Failed to connect AgentHub WS:', err);
    }
}

export function disconnectCloudHubWs() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
    if (hubSocket) {
        try {
            hubSocket.close(1000, 'logout');
        } catch {
            // Ignore
        }
        hubSocket = null;
    }
    cloudState.wsConnected = false;
}
