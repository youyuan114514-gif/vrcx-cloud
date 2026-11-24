import { cloudFetch, onCloudGameLogEvent } from './apiClient.js';
import { bootstrapCache, flushStorageNow, scheduleStoragePatch } from './bootstrapCache.js';
import { getAggregatedGameState, getPrimaryAgentState, syncGameRunningBridge } from './cloudState.js';

/**
 * Lightweight RFC 1321 MD5 returning Base64 (used by imageUploadCoordinator for VRChat file uploads).
 *
 * @param {Uint8Array} input
 * @returns {string}
 */
function md5Base64(input) {
    const k = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }
    const s = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21
    ];

    const bitLen = input.length * 8;
    const paddedLen = (((input.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(paddedLen);
    buf.set(input);
    buf[input.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(paddedLen - 8, bitLen >>> 0, true);
    view.setUint32(paddedLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < paddedLen; offset += 64) {
        const m = new Uint32Array(16);
        for (let j = 0; j < 16; j++) {
            m[j] = view.getUint32(offset + j * 4, true);
        }
        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;
        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const temp = d;
            d = c;
            c = b;
            const sum = (a + f + k[i] + m[g]) >>> 0;
            const rot = ((sum << s[i]) | (sum >>> (32 - s[i]))) >>> 0;
            b = (b + rot) >>> 0;
            a = temp;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const dv = new DataView(digest.buffer);
    dv.setUint32(0, a0, true);
    dv.setUint32(4, b0, true);
    dv.setUint32(8, c0, true);
    dv.setUint32(12, d0, true);
    return btoa(String.fromCharCode(...digest));
}

function base64ToBytes(b64) {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

/**
 * Deterministic 16-bit hue hash matching VRCX desktop user colour assignment.
 *
 * @param {string} userId
 * @returns {number}
 */
function hashUserIdToHue(userId) {
    let hash = 2166136261;
    const str = String(userId || '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash % 65536;
}

/**
 * Client-side Canvas image resize (replaces .NET ImageSharp in Web mode so Workers stay under 10ms CPU).
 *
 * @param {string} base64Data
 * @returns {Promise<string>}
 */
async function resizeImageInBrowser(base64Data) {
    try {
        const clean = base64Data.includes(',') ? base64Data : `data:image/png;base64,${base64Data}`;
        const res = await fetch(clean);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const maxDim = 2048;
        let width = bitmap.width;
        let height = bitmap.height;
        if (width > maxDim || height > maxDim) {
            const scale = Math.min(maxDim / width, maxDim / height);
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return base64Data;
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const dataUrl = canvas.toDataURL('image/png');
        return dataUrl.slice(dataUrl.indexOf(',') + 1);
    } catch {
        return base64Data;
    }
}

async function dispatchRemoteCommand(action, params = {}) {
    try {
        await cloudFetch('/api/commands', {
            method: 'POST',
            json: { action, params }
        });
        return true;
    } catch (err) {
        console.warn(`[cloud] Remote command ${action} failed:`, err?.message || err);
        return false;
    }
}

export function createVrcxStorageBridge() {
    return {
        async Get(key) {
            return bootstrapCache.storage[key] ?? '';
        },
        async GetAll() {
            return JSON.stringify(bootstrapCache.storage);
        },
        async Set(key, value) {
            scheduleStoragePatch(key, value ?? '');
        },
        async Remove(key) {
            scheduleStoragePatch(key, null);
        },
        async Clear() {
            for (const k of Object.keys(bootstrapCache.storage)) {
                scheduleStoragePatch(k, null);
            }
            await flushStorageNow();
        },
        async Save() {
            await flushStorageNow();
        }
    };
}

export function createLogWatcherBridge() {
    /** @type {string[][]} */
    const queue = [];

    onCloudGameLogEvent((ev) => {
        const dt = ev.created_at || new Date().toISOString();
        if (ev.type === 'Location') {
            queue.push(['cloud', dt, 'location', ev.location || '', ev.worldName || '']);
        } else if (ev.type === 'OnPlayerJoined') {
            queue.push(['cloud', dt, 'player-joined', ev.displayName || '', ev.userId || '']);
        } else if (ev.type === 'OnPlayerLeft') {
            queue.push(['cloud', dt, 'player-left', ev.displayName || '', ev.userId || '']);
        } else if (ev.type === 'VideoPlay') {
            queue.push(['cloud', dt, 'video-play', ev.videoUrl || '', ev.displayName || '']);
        } else if (ev.type === 'Event') {
            queue.push(['cloud', dt, 'event', ev.data || '']);
        } else if (ev.type === 'PortalSpawn') {
            queue.push(['cloud', dt, 'portal-spawn']);
        }
    });

    return {
        async Reset() {
            queue.length = 0;
        },
        async SetDateTill() {},
        async Get() {
            if (queue.length === 0) return [];
            return queue.splice(0, 50);
        },
        async GetLogLines() {
            return [];
        }
    };
}

export function createDiscordBridge() {
    /** @type {Record<string, any>} */
    const state = { active: false, details: '', stateText: '', largeImage: '', smallImage: '' };
    /** @type {ReturnType<typeof setTimeout> | null} */
    let syncTimer = null;

    function queueSync() {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            dispatchRemoteCommand('discord_update', { ...state });
        }, 2500);
    }

    return {
        async SetActive(active) {
            if (state.active === Boolean(active)) return state.active;
            state.active = Boolean(active);
            queueSync();
            return state.active;
        },
        async SetText(details, stateText) {
            if (state.details === details && state.stateText === stateText) return;
            state.details = details || '';
            state.stateText = stateText || '';
            queueSync();
        },
        async SetTimestamps() {},
        async SetAssets(
            details,
            stateText,
            detailsUrl,
            largeImage,
            largeText,
            smallImage,
            smallText,
            startUnixMilliseconds,
            endUnixMilliseconds,
            partyId,
            partySize,
            partyMax,
            buttonText,
            buttonUrl,
            appId,
            activityType,
            statusDisplayType
        ) {
            const next = {
                active: state.active,
                details: details || '',
                stateText: stateText || '',
                detailsUrl: detailsUrl || '',
                largeImage: largeImage || '',
                largeText: largeText || '',
                smallImage: smallImage || '',
                smallText: smallText || '',
                startUnixMilliseconds: startUnixMilliseconds || 0,
                endUnixMilliseconds: endUnixMilliseconds || 0,
                partyId: partyId || '',
                partySize: partySize || 0,
                partyMax: partyMax || 0,
                buttonText: buttonText || '',
                buttonUrl: buttonUrl || '',
                appId: appId || '',
                activityType: activityType || 0,
                statusDisplayType: statusDisplayType || 0
            };
            if (JSON.stringify(next) === JSON.stringify(state)) return;
            Object.assign(state, next);
            queueSync();
        }
    };
}

export function createAssetBundleManagerBridge() {
    return {
        async SweepCache() {
            return '';
        },
        async GetCacheSize() {
            const st = getPrimaryAgentState();
            return Number(st?.cacheSizeBytes ?? 0);
        },
        async GetVRChatCacheFullLocation() {
            return '';
        },
        async CheckVRChatCache() {
            return { Item1: -1, Item2: false, Item3: '' };
        },
        async DeleteCache() {
            await dispatchRemoteCommand('clear_cache', { scope: 'single' });
        },
        async DeleteAllCache() {
            await dispatchRemoteCommand('clear_cache', { scope: 'all' });
        }
    };
}

export function createAppApiBridge() {
    let zoomLevel = 1;

    const api = {
        async ShowDevTools() {},
        async SetVR() {},
        async SetZoom(val) {
            zoomLevel = Number(val) || 1;
        },
        async GetZoom() {
            return zoomLevel;
        },
        async DesktopNotification(boldText, text) {
            if (typeof Notification === 'undefined') return;
            if (Notification.permission === 'granted') {
                new Notification(boldText || 'VRCX', { body: text || '' });
            } else if (Notification.permission === 'default') {
                Notification.requestPermission().catch(() => {});
            }
        },
        async RestartApplication() {
            window.location.reload();
        },
        async CheckForUpdateExe() {
            return false;
        },
        async ExecuteVrOverlayFunction() {},
        async FocusWindow() {
            window.focus?.();
        },
        async ChangeTheme() {},
        async DoFunny() {},
        async GetClipboard() {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return '';
            }
        },
        async SetStartup() {},
        async CopyImageToClipboard() {},
        async FlashWindow() {},
        async SetUserAgent() {},
        async SetTrayIconNotification() {},
        async OpenCalendarFile(icsContent) {
            const blob = new Blob([icsContent || ''], { type: 'text/calendar;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'vrchat-event.ics';
            a.click();
            URL.revokeObjectURL(url);
        },
        async GetColourFromUserID(userId) {
            return hashUserIdToHue(userId);
        },
        async GetColourBulk(userIds) {
            /** @type {Record<string, number>} */
            const out = {};
            for (const id of userIds || []) {
                out[id] = hashUserIdToHue(id);
            }
            return out;
        },
        async OpenLink(url) {
            if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
                window.open(url, '_blank', 'noopener,noreferrer');
            }
        },
        async OpenDiscordProfile(discordId) {
            window.open(`https://discord.com/users/${encodeURIComponent(discordId)}`, '_blank', 'noopener,noreferrer');
        },
        async OpenSteamStorePage(appId) {
            window.open(`https://store.steampowered.com/app/${encodeURIComponent(appId)}`, '_blank', 'noopener,noreferrer');
        },
        async GetLaunchCommand() {
            return '';
        },
        async IPCAnnounceStart() {},
        async SendIpc() {},
        async CustomCss() {
            return '';
        },
        async CustomScript() {
            return '';
        },
        async CurrentCulture() {
            return navigator.language || 'en-US';
        },
        async CurrentLanguage() {
            return navigator.language || 'en-US';
        },
        async GetVersion() {
            return `VRCX Cloud ${typeof VERSION === 'string' ? VERSION : '2026.11'}`;
        },
        async VrcClosedGracefully() {
            return true;
        },
        async SetAppLauncherSettings() {},
        async GetFileBase64() {
            return null;
        },
        async TryOpenInstanceInVrc(launchUrl) {
            const raw = String(launchUrl || '').trim();
            if (!raw.startsWith('vrchat://launch?')) return false;
            const urlWithAttach = raw.includes('attach=') ? raw : `${raw}&attach=1`;
            return dispatchRemoteCommand('launch_vrc', { launchUrl: urlWithAttach });
        },
        async StartGame(args) {
            const rawArgs = String(args || '');
            const match = rawArgs.match(/vrchat:\/\/launch\?[^\s"']+/);
            if (!match) return false;
            const desktopMode = /(?:^|\s)--no-vr(?:\s|$)/.test(rawArgs);
            return dispatchRemoteCommand('launch_vrc', desktopMode ? { launchUrl: match[0], desktopMode: true } : { launchUrl: match[0] });
        },
        async StartGameFromPath(_path, args) {
            return this.StartGame(args);
        },
        async QuitGame() {
            const ok = await dispatchRemoteCommand('quit_vrc', {});
            return ok ? 1 : 0;
        },
        async CheckGameRunning() {
            syncGameRunningBridge();
        },
        async IsGameRunning() {
            return getAggregatedGameState().vrcRunning;
        },
        async IsSteamVRRunning() {
            return getAggregatedGameState().steamVrRunning;
        },
        async MD5File(base64) {
            return md5Base64(base64ToBytes(base64));
        },
        async SignFile(base64) {
            return md5Base64(base64ToBytes(base64));
        },
        async FileLength(base64) {
            return String(base64ToBytes(base64).byteLength);
        },
        async ResizeImageToFitLimits(base64data) {
            return resizeImageInBrowser(base64data);
        },
        async PopulateImageHosts() {},
        async GetImage(url) {
            return url || '';
        },
        async XSNotification(title, content, timeout, opacity, image) {
            await dispatchRemoteCommand('send_vr_notify', {
                target: 'xsoverlay',
                title,
                content,
                timeout,
                opacity,
                image
            });
        },
        async OVRTNotification(hudNotification, wristNotification, title, body, timeout, opacity, image) {
            await dispatchRemoteCommand('send_vr_notify', {
                target: 'ovrtoolkit',
                hudNotification,
                wristNotification,
                title,
                body,
                timeout,
                opacity,
                image
            });
        },
        async GetVRChatRegistry() {
            return {};
        },
        async GetVRChatRegistryKey() {
            return null;
        },
        async SetVRChatRegistryKey() {
            return false;
        },
        async DeleteVRChatRegistryKey() {
            return false;
        },
        async GetVRChatRegistryJson() {
            return '{}';
        },
        async HasVRChatRegistryFolder() {
            return false;
        },
        async GetVRChatModerations() {
            return null;
        },
        async GetVRChatUserModeration() {
            return 0;
        },
        async SetVRChatUserModeration() {
            return false;
        },
        async ReadConfigFile() {
            return '{}';
        },
        async ReadConfigFileSafe() {
            return '{}';
        },
        async WriteConfigFile() {},
        async FindScreenshotsBySearch() {
            const rows = await cloudFetch('/api/screenshots?limit=50').catch(() => []);
            return JSON.stringify(rows);
        },
        async GetScreenshotMetadata() {
            return '{}';
        },
        async GetExtraScreenshotData() {
            return '{}';
        },
        async GetLastScreenshot() {
            return '';
        }
    };

    // Safe proxy fallback for any remaining desktop-only AppApi methods
    return new Proxy(api, {
        get(target, prop) {
            if (prop in target) {
                return target[prop];
            }
            if (typeof prop === 'string') {
                return async () => '';
            }
            return undefined;
        }
    });
}

export function createElectronShim() {
    const noopUnsub = () => () => {};
    return {
        getArch: async () => 'web',
        getClipboardText: async () => {
            try {
                return await navigator.clipboard.readText();
            } catch {
                return '';
            }
        },
        getNoUpdater: async () => true,
        setTrayIconNotification: async () => {},
        setThemeSource: async () => {},
        onSystemThemeChanged: noopUnsub,
        openFileDialog: async () => '',
        openDirectoryDialog: async () => '',
        desktopNotification: async (title, body) => {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title || 'VRCX', { body: body || '' });
            }
        },
        restartApp: async () => window.location.reload(),
        getOverlayWindow: async () => false,
        updateVr: async () => {},
        onWindowPositionChanged: noopUnsub,
        onWindowSizeChanged: noopUnsub,
        onWindowStateChange: noopUnsub,
        onBrowserFocus: noopUnsub,
        onBrowserBlur: noopUnsub,
        ipcRenderer: {
            on: noopUnsub
        }
    };
}

export function createSqliteNoopShim() {
    return {
        async Execute() {
            return [];
        },
        async ExecuteJson() {
            return '[]';
        },
        async ExecuteNonQuery() {
            return 0;
        },
        async ExecuteInsert() {
            return 0;
        }
    };
}
