import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bootstrapCache,
    loadBootstrap,
    saveCloudSyncIntervalSeconds,
    saveWebSyncIntervalSeconds,
    scheduleConfigPatch
} from '../bootstrapCache.js';
import {
    applyCloudPresenceUpdate,
    cloudState,
    getAggregatedGameStartTimes,
    getAggregatedGameState,
    getOnlineAgentIds
} from '../cloudState.js';
import { createAppApiBridge } from '../appApiWeb.js';
import { createWebApiBridge } from '../webApiRemote.js';
import { createCloudDatabase } from '../../services/database/cloud/index.js';
import { formatTotalUptime } from '../../components/statusBarUtils.js';
import { formatCloudPhotoDateTime, groupCloudScreenshotsByDate } from '../cloudGalleryUtils.js';

function mockOk(data, status = 200) {
    return new Response(JSON.stringify({ ok: true, data }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function mockErr(code, message, status = 500) {
    return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('WEB cloud adapter (stateless)', () => {
    /** @type {ReturnType<typeof vi.spyOn>} */
    let fetchSpy;

    beforeEach(() => {
        vi.useFakeTimers();
        bootstrapCache.loaded = false;
        bootstrapCache.configs = {};
        bootstrapCache.storage = {};
        bootstrapCache.memos.clear();
        bootstrapCache.notes.clear();
        bootstrapCache.userProfiles.clear();
        cloudState.agentsOnline = [];
        cloudState.wsAgentsOnline = [];
        cloudState.deviceStates = {};
        cloudState.lastVrcRoute = '';
        cloudState.syncIntervalSeconds = 60;
        cloudState.webSyncIntervalSeconds = 300;
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('hydrates full session state from a single /api/bootstrap call and batches config writes', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                configs: { VRCX_theme: 'dark' },
                storage: { VRCX_DatabaseLocation: '' },
                memos: [{ user_id: 'usr_1', edited_at: '2026-11-24T00:00:00Z', memo: 'friend memo' }],
                worldMemos: [],
                avatarMemos: [],
                notes: [],
                favoriteFriends: [],
                favoriteWorlds: [],
                favoriteAvatars: [],
                favoritePrints: [],
                avatarTags: [],
                moderations: [],
                userProfiles: [],
                statsCounters: { gamelog_location: 42 },
                r2Enabled: true,
                agentStatus: {
                    agentsOnline: ['dev_win1'],
                    deviceStates: { dev_win1: { state: { vrcRunning: true, cacheSizeBytes: 12345 } } }
                }
            })
        );

        await loadBootstrap();
        expect(bootstrapCache.loaded).toBe(true);
        expect(bootstrapCache.configs.VRCX_theme).toBe('dark');
        expect(bootstrapCache.memos.get('usr_1')?.memo).toBe('friend memo');
        expect(cloudState.r2Enabled).toBe(true);
        expect(cloudState.agentsOnline).toEqual(['dev_win1']);

        // Writing an unchanged value is a no-op (0 Worker requests).
        scheduleConfigPatch('VRCX_theme', 'dark');
        await vi.advanceTimersByTimeAsync(9000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Multiple config mutations coalesce into a single PUT /api/config/bundle write.
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        scheduleConfigPatch('k1', 'v1');
        scheduleConfigPatch('k2', 'v2');
        scheduleConfigPatch('k1', 'v1_updated');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(8100);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        const [url, init] = fetchSpy.mock.calls[1];
        expect(url).toBe('/api/config/bundle');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { k1: 'v1_updated', k2: 'v2' }
        });
    });

    it('routes WebApi.ExecuteJson through /api/vrc/execute and tracks route telemetry', async () => {
        const webApi = createWebApiBridge();
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                status: 200,
                data: '{"id":"usr_me"}',
                route: 'agent_residential_ip'
            })
        );

        const resJson = await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' })
        );
        expect(JSON.parse(resJson)).toEqual({ status: 200, message: '{"id":"usr_me"}' });
        expect(cloudState.lastVrcRoute).toBe('agent_residential_ip');

        // Graceful readonly error when PC agent is offline and fallback is disabled.
        fetchSpy.mockResolvedValueOnce(mockErr('AGENT_OFFLINE_READONLY', 'Offline', 503));
        const offlineRes = JSON.parse(
            await webApi.ExecuteJson(JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' }))
        );
        expect(offlineRes.status).toBe(-1);
        expect(cloudState.lastVrcRoute).toBe('offline');
    });

    it('computes RFC 1321 MD5 Base64 and validates vrchat://launch commands in AppApi bridge', async () => {
        const appApi = createAppApiBridge();
        // MD5("hello") = 5d41402abc4b2a76b9719d911017c592 => base64 "XUFAKrxLKna5cZ2REBfFkg=="
        const md5 = await appApi.MD5File(btoa('hello'));
        expect(md5).toBe('XUFAKrxLKna5cZ2REBfFkg==');

        // Reject non-vrchat launch args without calling cloud API
        const badStart = await appApi.StartGame('cmd.exe /c calc');
        expect(badStart).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();

        // Allow valid vrchat://launch URL
        fetchSpy.mockResolvedValueOnce(mockOk({ id: 'cmd_1' }));
        const launchUrl = 'vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)';
        const okStart = await appApi.StartGame(`--url=${launchUrl}`);
        expect(okStart).toBe(true);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/commands');
        expect(JSON.parse(init.body)).toEqual({ action: 'launch_vrc', params: { launchUrl } });
    });

    it('exposes stateless cloud database repository methods backed by REST endpoints', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });

        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        await db.setUserMemo({ userId: 'usr_2', editedAt: '2026-11-24T01:00:00Z', memo: 'hello cloud' });
        expect(await db.getUserMemo('usr_2')).toEqual({
            userId: 'usr_2',
            editedAt: '2026-11-24T01:00:00Z',
            memo: 'hello cloud'
        });

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ id: 1, type: 'Location', world_name: 'Japanese Shrine', location: 'wrld_1:1' }])
        );
        const logs = await db.lookupGameLogDatabase(['Location'], [], 50);
        expect(logs).toHaveLength(1);
        expect(fetchSpy.mock.calls[1][0]).toContain('/api/gamelog?');

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                locationRows: [
                    {
                        id: 2,
                        created_at: '2026-11-24T01:00:00Z',
                        location: 'wrld_1:1',
                        world_id: 'wrld_1',
                        world_name: 'Japanese Shrine'
                    }
                ],
                joinLeaveRows: []
            })
        );
        const searchLogs = await db.searchGameLogDatabase('Shrine', ['Location'], [], 50);
        expect(searchLogs).toHaveLength(1);
        expect(fetchSpy.mock.calls[2][0]).toContain('/api/gamelog/search?q=Shrine');
    });

    it('throttles repetitive api.vrchat.cloud GET sync calls using independent cloudState.webSyncIntervalSeconds (default 300s) and invalidates volatile cache on writes', async () => {
        // Default webSyncIntervalSeconds is 300s even when VRCX.Agent syncIntervalSeconds is 60s
        cloudState.syncIntervalSeconds = 60;
        expect(cloudState.webSyncIntervalSeconds).toBe(300);

        // Saving webSyncIntervalSeconds writes cloud:webSyncIntervalSeconds without altering VRCX.Agent syncIntervalSeconds
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        expect(await saveWebSyncIntervalSeconds(60)).toBe(60);
        expect(cloudState.webSyncIntervalSeconds).toBe(60);
        expect(cloudState.syncIntervalSeconds).toBe(60);
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { 'cloud:webSyncIntervalSeconds': '60' }
        });

        // Saving VRCX.Agent syncIntervalSeconds writes cloud:syncIntervalSeconds without altering webSyncIntervalSeconds
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        expect(await saveCloudSyncIntervalSeconds(180)).toBe(180);
        expect(cloudState.syncIntervalSeconds).toBe(180);
        expect(cloudState.webSyncIntervalSeconds).toBe(60);
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { 'cloud:syncIntervalSeconds': '180' }
        });

        fetchSpy.mockClear();
        const webApi = createWebApiBridge();
        const friendsUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?offline=false&n=50&offset=0';

        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f1"}]', route: 'cloud_direct' }));

        const first = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(first.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Within 60s webSyncIntervalSeconds -> served from cache with 0 extra Worker / api.vrchat.cloud calls
        await vi.advanceTimersByTimeAsync(30_000);
        const second = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // After 60s webSyncIntervalSeconds window expires (even while Agent syncIntervalSeconds=180s) -> fetches fresh data
        await vi.advanceTimersByTimeAsync(31_000);
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f2"}]', route: 'cloud_direct' }));
        const third = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(third.message).toContain('usr_f2');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Any write operation immediately invalidates volatile read cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f3"}]', route: 'cloud_direct' }));
        const fourth = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(fourth.message).toContain('usr_f3');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('coalesces concurrent read GETs into one /api/vrc/execute-batch call and preserves stable entity cache across unrelated writes', async () => {
        cloudState.webSyncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const worldUrl = 'https://api.vrchat.cloud/api/1/worlds/wrld_abc';
        const instanceUrl = 'https://api.vrchat.cloud/api/1/instances/wrld_abc:12345';
        const userUrl = 'https://api.vrchat.cloud/api/1/users/usr_friend1';

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '{"id":"wrld_abc","name":"Sakura"}' },
                    { status: 200, data: '{"id":"wrld_abc:12345","n_users":5}' },
                    { status: 200, data: '{"id":"usr_friend1","displayName":"Sakura"}' }
                ]
            })
        );

        const [wRes, iRes, uRes] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: worldUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: instanceUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: userUrl, method: 'GET' }))
        ]);

        // All 3 concurrent GETs collapsed into a single Worker invocation
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/vrc/execute-batch');
        expect(JSON.parse(wRes).message).toContain('Sakura');
        expect(JSON.parse(iRes).message).toContain('12345');
        expect(JSON.parse(uRes).message).toContain('usr_friend1');

        // An unrelated PUT (updating current user) must NOT wipe the stable world entity cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        const cachedWorld = await webApi.ExecuteJson(JSON.stringify({ url: worldUrl, method: 'GET' }));
        expect(JSON.parse(cachedWorld).message).toContain('Sakura');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent world stats reads and batches userProfile/friendLog/notification writes', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });

        // 3 simultaneous world stats getters (world dialog open) issue only 1 Worker request
        fetchSpy.mockResolvedValueOnce(
            mockOk({ lastVisit: '2026-11-24T00:00:00Z', visitCount: 7, timeSpent: 3600, worldName: 'Shrine' })
        );
        const [lastVisit, visitCount, timeSpent] = await Promise.all([
            db.getLastVisit('wrld_dedupe'),
            db.getVisitCount('wrld_dedupe'),
            db.getTimeSpentInWorld('wrld_dedupe')
        ]);
        expect(lastVisit).toBe('2026-11-24T00:00:00Z');
        expect(visitCount).toBe(7);
        expect(timeSpent).toBe(3600);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Multiple setUserProfile / setFriendLogCurrent / addNotificationToDatabase calls coalesce into 1 request each
        fetchSpy.mockResolvedValue(mockOk({ count: 2 }));
        await db.setUserProfile({ userId: 'usr_a', bio: 'hi', bioLinks: [] });
        await db.setUserProfile({ userId: 'usr_b', bio: 'yo', bioLinks: [] });
        await db.setUserProfile({ userId: 'usr_a', bio: 'hi', bioLinks: [] }); // unchanged -> skipped
        await db.setFriendLogCurrent({ userId: 'usr_a', displayName: 'A', trustLevel: 'Known', friendNumber: 1 });
        await db.setFriendLogCurrent({ userId: 'usr_b', displayName: 'B', trustLevel: 'Trusted', friendNumber: 2 });
        await db.addNotificationToDatabase({ id: 'not_1', type: 'invite', message: 'join' });
        await db.addNotificationToDatabase({ id: 'not_2', type: 'invite', message: 'join 2' });

        // None sent immediately; all flush in batches once timers elapse
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        const calledUrls = fetchSpy.mock.calls
            .slice(1)
            .map((c) => c[0])
            .sort();
        expect(calledUrls).toEqual(['/api/friend-log/current', '/api/notifications', '/api/user-profiles']);
    });

    it('reports HTTP VRCX.Agent devices as online in StatusBar without enabling WS RPC, expires stale devices, and formats multi-day total uptime', () => {
        const baseNow = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        applyCloudPresenceUpdate({
            deviceLastSeen: { dev_http_1: baseNow - 30_000, dev_stale: baseNow - 600_000 },
            totalUptimeSeconds: 90_061,
            replaceDeviceMap: true
        });

        expect(getOnlineAgentIds(baseNow)).toEqual(['dev_http_1']);
        expect(cloudState.wsAgentsOnline).toEqual([]);
        expect(cloudState.totalUptimeBaseSeconds).toBe(90_061);
        // Once the active window (300s) passes without a new sync, stale HTTP agent automatically goes offline
        expect(getOnlineAgentIds(baseNow + 280_000)).toEqual([]);

        expect(formatTotalUptime(3661)).toBe('01:01:01');
        expect(formatTotalUptime(90_061)).toBe('1d 01:01:01');
    });

    it('groups Cloud Gallery screenshots by local calendar date with Chinese YYYY年MM月DD日 HH:mm timestamps', () => {
        const d1a = new Date(2026, 10, 24, 21, 35, 0).toISOString();
        const d1b = new Date(2026, 10, 24, 14, 5, 0).toISOString();
        const d2 = new Date(2026, 10, 20, 9, 8, 0).toISOString();

        expect(formatCloudPhotoDateTime(d1a, 'zh-CN')).toBe('2026年11月24日 21:35');
        expect(formatCloudPhotoDateTime(d2, 'en')).toBe('2026-11-20 09:08');

        const groups = groupCloudScreenshotsByDate(
            [
                { id: 's1', taken_at: d1a },
                { id: 's2', taken_at: d1b },
                { id: 's3', taken_at: d2 }
            ],
            'zh-CN',
            '未知日期'
        );
        expect(groups).toHaveLength(2);
        expect(groups[0].dateLabel).toBe('2026年11月24日');
        expect(groups[0].timeRange).toBe('14:05 – 21:35');
        expect(groups[0].items.map((i) => i.dateTimeLabel)).toEqual(['2026年11月24日 21:35', '2026年11月24日 14:05']);
        expect(groups[1].dateLabel).toBe('2026年11月20日');
        expect(groups[1].timeRange).toBe('09:08');
        expect(groups[1].items[0].dateTimeLabel).toBe('2026年11月20日 09:08');
    });

    it('aggregates VRChat and SteamVR running state across multiple online PCs and forwards full invite launch URLs', async () => {
        const nowMs = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        cloudState.deviceStates = {};

        const updateSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({ $bridge: { updateIsGameRunning: updateSpy } });

        try {
            // PC-1 is online and idle; PC-2 is online running VRChat; PC-3 is offline with stale SteamVR=true
            applyCloudPresenceUpdate({
                deviceLastSeen: {
                    pc_idle: nowMs - 10_000,
                    pc_vrc: nowMs - 20_000,
                    pc_offline: nowMs - 600_000
                },
                deviceStates: {
                    pc_idle: {
                        state: { vrcRunning: false, steamVrRunning: false },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_vrc: {
                        state: { vrcRunning: true, steamVrRunning: false },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_offline: {
                        state: { vrcRunning: true, steamVrRunning: true },
                        updatedAt: new Date(nowMs - 600_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });

            expect(getAggregatedGameState(nowMs)).toEqual({ vrcRunning: true, steamVrRunning: false });
            expect(updateSpy).toHaveBeenLastCalledWith(true, false);

            // Bringing PC-1 SteamVR online turns SteamVR green too
            applyCloudPresenceUpdate({
                deviceStates: {
                    pc_idle: {
                        state: { vrcRunning: false, steamVrRunning: true },
                        updatedAt: new Date(nowMs).toISOString()
                    }
                }
            });
            const appApi = createAppApiBridge();
            expect(await appApi.IsGameRunning()).toBe(true);
            expect(await appApi.IsSteamVRRunning()).toBe(true);
            await appApi.CheckGameRunning();
            expect(updateSpy).toHaveBeenLastCalledWith(true, true);

            // Full upstream invite/launch URL with ref + shortName + --no-vr
            fetchSpy.mockResolvedValueOnce(mockOk({ cmdId: 'cmd_launch_1', status: 'queued' }));
            const fullUrl =
                'vrchat://launch?ref=vrcx.app&id=wrld_12345678-1234-1234-1234-1234567890ab:99999~region(jp)&shortName=xyz789';
            expect(await appApi.StartGame(`${fullUrl} --no-vr`)).toBe(true);
            expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
                action: 'launch_vrc',
                params: { launchUrl: fullUrl, desktopMode: true }
            });

            // TryOpenInstanceInVrc appends &attach=1 automatically
            fetchSpy.mockResolvedValueOnce(mockOk({ cmdId: 'cmd_launch_2', status: 'queued' }));
            expect(await appApi.TryOpenInstanceInVrc(fullUrl)).toBe(true);
            expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
                action: 'launch_vrc',
                params: { launchUrl: `${fullUrl}&attach=1` }
            });
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });

    it('aggregates earliest real VRChat & SteamVR process start times across online PCs and syncs them to bridge', () => {
        const nowMs = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        cloudState.deviceStates = {};

        const vrcEarly = nowMs - 90 * 60_000;
        const vrcLate = nowMs - 10 * 60_000;
        const steamEarly = nowMs - 120 * 60_000;
        const startTimesSpy = vi.fn();
        const updateSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({
            $bridge: {
                updateCloudGameStartTimes: startTimesSpy,
                updateIsGameRunning: updateSpy
            }
        });

        try {
            applyCloudPresenceUpdate({
                deviceLastSeen: {
                    pc_early: nowMs - 5_000,
                    pc_late: nowMs - 5_000,
                    pc_offline: nowMs - 600_000
                },
                deviceStates: {
                    pc_early: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(vrcEarly).toISOString(),
                            steamVrRunning: true,
                            steamVrStartedAt: new Date(steamEarly).toISOString()
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_late: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(vrcLate).toISOString(),
                            steamVrRunning: false
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_offline: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(nowMs - 500 * 60_000).toISOString()
                        },
                        updatedAt: new Date(nowMs - 600_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });

            expect(getAggregatedGameStartTimes(nowMs)).toEqual({
                vrcStartedAtMs: vrcEarly,
                steamVrStartedAtMs: steamEarly
            });
            expect(startTimesSpy).toHaveBeenCalledWith({
                vrcStartedAtMs: vrcEarly,
                steamVrStartedAtMs: steamEarly
            });
            expect(updateSpy).toHaveBeenCalledWith(true, true);
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });

    it('loads chronological current-instance player list and triggers refreshCloudPlayerList on room/player updates', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    type: 'Location',
                    created_at: '2026-11-24T02:00:00.000Z',
                    location: 'wrld_room1:100',
                    worldId: 'wrld_room1',
                    worldName: 'Sakura Shrine'
                },
                {
                    type: 'OnPlayerJoined',
                    created_at: '2026-11-24T02:00:05.000Z',
                    displayName: 'Alice',
                    userId: 'usr_alice',
                    location: 'wrld_room1:100'
                }
            ])
        );
        const rows = await db.getGamelogDatabase();
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/gamelog/current-instance');
        expect(rows).toHaveLength(2);
        expect(rows[0].type).toBe('Location');
        expect(rows[1].userId).toBe('usr_alice');

        const nowMs = Date.now();
        const refreshSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({
            $bridge: {
                updateCloudGameStartTimes: vi.fn(),
                updateIsGameRunning: vi.fn(),
                refreshCloudPlayerList: refreshSpy
            }
        });
        try {
            applyCloudPresenceUpdate({
                deviceLastSeen: { pc_1: nowMs - 2_000 },
                deviceStates: {
                    pc_1: {
                        state: {
                            vrcRunning: true,
                            currentLocation: 'wrld_room1:100',
                            currentWorldName: 'Sakura Shrine',
                            playerCount: 1,
                            currentPlayers: [{ displayName: 'Alice', userId: 'usr_alice' }]
                        },
                        updatedAt: new Date(nowMs - 2_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);

            // Identical snapshot does not spam refreshes
            applyCloudPresenceUpdate({
                deviceLastSeen: { pc_1: nowMs - 2_000 },
                replaceDeviceMap: false
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);

            // Player list change triggers immediate refresh
            applyCloudPresenceUpdate({
                deviceStates: {
                    pc_1: {
                        state: {
                            vrcRunning: true,
                            currentLocation: 'wrld_room1:100',
                            currentWorldName: 'Sakura Shrine',
                            playerCount: 2,
                            currentPlayers: [
                                { displayName: 'Alice', userId: 'usr_alice' },
                                { displayName: 'Bob', userId: 'usr_bob' }
                            ]
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    }
                }
            });
            expect(refreshSpy).toHaveBeenCalledTimes(2);
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });
});
