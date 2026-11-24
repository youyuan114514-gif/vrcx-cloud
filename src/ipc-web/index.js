import { cloudFetch, connectCloudHubWs } from './apiClient.js';
import {
    createAppApiBridge,
    createAssetBundleManagerBridge,
    createDiscordBridge,
    createElectronShim,
    createLogWatcherBridge,
    createSqliteNoopShim,
    createVrcxStorageBridge
} from './appApiWeb.js';
import { loadBootstrap } from './bootstrapCache.js';
import { cloudState } from './cloudState.js';
import { createWebApiBridge } from './webApiRemote.js';

/**
 * Initializes the stateless Cloudflare Web runtime bridges before Vue mounts.
 * Desktop CEF and Electron builds never import or invoke this path.
 */
export async function initWebInteropApi() {
    // @ts-ignore expose global bridges matching desktop signatures
    window.AppApi = createAppApiBridge();
    // @ts-ignore
    window.WebApi = createWebApiBridge();
    // @ts-ignore
    window.VRCXStorage = createVrcxStorageBridge();
    // @ts-ignore
    window.SQLite = createSqliteNoopShim();
    // @ts-ignore
    window.LogWatcher = createLogWatcherBridge();
    // @ts-ignore
    window.Discord = createDiscordBridge();
    // @ts-ignore
    window.AssetBundleManager = createAssetBundleManagerBridge();
    // @ts-ignore
    window.electron = createElectronShim();

    try {
        const authInfo = await cloudFetch('/api/auth/me');
        cloudState.authenticated = Boolean(authInfo.authenticated);
        cloudState.authMode = authInfo.authMode || 'open_setup';
        cloudState.requiresTotp = Boolean(authInfo.requiresTotp);
        cloudState.subject = authInfo.subject || '';
        cloudState.r2Enabled = Boolean(authInfo.r2Enabled);
        cloudState.cloudFallbackAllowed = authInfo.cloudFallbackAllowed !== false;

        if (cloudState.authenticated) {
            await loadBootstrap();
            connectCloudHubWs();
        }
    } catch (err) {
        console.warn('[cloud] Initial auth/bootstrap check failed:', err);
    } finally {
        cloudState.initialized = true;
    }
}
