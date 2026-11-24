import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../src/crypto/vault';
import type { Env } from '../src/env';
import worker from '../src/index';
import { runBackgroundFeedSync } from '../src/sync/backgroundFeedSync';

const env = rawEnv as unknown as Env;
const exports = rawExports as unknown as { default: Fetcher };

function waitForMessage(ws: WebSocket, predicate: (data: string) => boolean, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMessage);
            reject(new Error(`WS timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
            const text = typeof event.data === 'string' ? event.data : '';
            if (predicate(text)) {
                clearTimeout(timer);
                ws.removeEventListener('message', onMessage);
                resolve(text);
            }
        };
        ws.addEventListener('message', onMessage);
    });
}

describe('VRCX Cloud Full Backend E2E (Core, Events, Agent Pairing/HMAC, Residential RPC, Remote Commands, Auth)', () => {
    beforeAll(async () => {
        const res = await exports.default.fetch('http://example.com/health');
        expect(res.status).toBe(200);
    });

    it('persists bundled config, memos, favorites, notifications, and loads everything in 1 /api/bootstrap call', async () => {
        // Save config bundle patch
        const cfgRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: { 'config:theme': 'dark', 'config:language': 'zh_CN' }
            })
        });
        expect(cfgRes.status).toBe(200);

        // Save user memo & local friend favorite
        await exports.default.fetch('http://example.com/api/memos', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'user', id: 'usr_friend_01', memo: 'Met at JP Shrine' })
        });
        await exports.default.fetch('http://example.com/api/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', targetId: 'usr_friend_01', groupName: 'Besties' })
        });
        await exports.default.fetch('http://example.com/api/avatar-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avtr_01', tag: 'Cute', color: '#ff88cc' })
        });

        // Single-request stateless bootstrap (survives cleared browser cache / incognito)
        const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
        expect(bootRes.status).toBe(200);
        const boot = (await bootRes.json()) as {
            ok: boolean;
            data: {
                configs: Record<string, string>;
                memos: Array<{ user_id: string; memo: string }>;
                favoriteFriends: Array<{ user_id: string; group_name: string }>;
                avatarTags: Array<{ avatar_id: string; tag: string }>;
            };
        };
        expect(boot.ok).toBe(true);
        expect(boot.data.configs['config:theme']).toBe('dark');
        expect(boot.data.memos.some((m) => m.user_id === 'usr_friend_01' && m.memo === 'Met at JP Shrine')).toBe(true);
        expect(boot.data.favoriteFriends.some((f) => f.user_id === 'usr_friend_01' && f.group_name === 'Besties')).toBe(
            true
        );
        expect(boot.data.avatarTags.some((t) => t.avatar_id === 'avtr_01' && t.tag === 'Cute')).toBe(true);
    });

    it('pairs a Windows agent with single-use 6-digit code, verifies HMAC ingest, broadcasts GameLog, and relays residential IP VRChat HTTP', async () => {
        // 1. Web generates pairing code
        const codeRes = await exports.default.fetch('http://example.com/api/agent/pair-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceLabel: 'Gaming-PC' })
        });
        const codeJson = (await codeRes.json()) as { ok: boolean; data: { code: string } };
        expect(codeJson.ok).toBe(true);
        expect(codeJson.data.code).toMatch(/^\d{6}$/);

        // 2. Agent redeems code
        const pairRes = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: codeJson.data.code,
                deviceName: 'Princess-PC',
                agentVersion: '1.0.0',
                capabilities: ['gamelog', 'vrc_relay', 'commands']
            })
        });
        expect(pairRes.status).toBe(200);
        const pairJson = (await pairRes.json()) as {
            ok: boolean;
            data: { deviceId: string; deviceToken: string; hmacSecret: string };
        };
        expect(pairJson.ok).toBe(true);
        const { deviceId, deviceToken, hmacSecret } = pairJson.data;

        // Reusing code must fail
        const reuseRes = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeJson.data.code })
        });
        expect(reuseRes.status).toBe(401);

        // 3. Connect Agent & Web WebSockets
        const agentUpgrade = await exports.default.fetch(
            `http://example.com/ws/agent?deviceId=${encodeURIComponent(deviceId)}`,
            {
                headers: {
                    Upgrade: 'websocket',
                    Authorization: `Bearer ${deviceToken}`
                }
            }
        );
        expect(agentUpgrade.status).toBe(101);
        const agentWs = agentUpgrade.webSocket!;
        agentWs.accept();

        const webUpgrade = await exports.default.fetch('http://example.com/ws/web', {
            headers: { Upgrade: 'websocket' }
        });
        expect(webUpgrade.status).toBe(101);
        const webWs = webUpgrade.webSocket!;
        webWs.accept();

        // 4. Signed HMAC batch GameLog ingest -> stored in D1 & broadcast to Web WS
        const ingestBody = JSON.stringify({
            cursor: { fileName: 'output_log_2026.txt', byteOffset: 4096, lastEventDt: '2026-11-23T22:00:00.000Z' },
            events: [
                {
                    type: 'Location',
                    created_at: '2026-11-23T22:00:00.000Z',
                    location: 'wrld_11111111-1111-1111-1111-111111111111:12345',
                    worldId: 'wrld_11111111-1111-1111-1111-111111111111',
                    worldName: 'Starlight Cafe'
                },
                {
                    type: 'OnPlayerJoined',
                    created_at: '2026-11-23T22:00:05.000Z',
                    location: 'wrld_11111111-1111-1111-1111-111111111111:12345',
                    userId: 'usr_star_99',
                    displayName: '星野光'
                }
            ]
        });
        const ts = String(Math.floor(Date.now() / 1000));
        const bodyHash = await sha256Hex(ingestBody);
        const sig = await hmacSha256Hex(hmacSecret, `${ts}\nPOST\n/api/agent/ingest/gamelog\n${bodyHash}`);

        const broadcastPromise = waitForMessage(webWs, (m) => m.includes('"gamelog.batch"'));
        const ingestRes = await exports.default.fetch('http://example.com/api/agent/ingest/gamelog', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${deviceToken}`,
                'X-Device-Id': deviceId,
                'X-Timestamp': ts,
                'X-Signature': sig
            },
            body: ingestBody
        });
        expect(ingestRes.status).toBe(200);
        const broadcastMsg = JSON.parse(await broadcastPromise) as { payload: { events: unknown[] } };
        expect(broadcastMsg.payload.events).toHaveLength(2);

        // Tampered HMAC must be rejected
        const badSigRes = await exports.default.fetch('http://example.com/api/agent/ingest/gamelog', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${deviceToken}`,
                'X-Device-Id': deviceId,
                'X-Timestamp': ts,
                'X-Signature': 'deadbeef'
            },
            body: ingestBody
        });
        expect(badSigRes.status).toBe(401);

        // 5. Residential-IP VRChat HTTP RPC relay through connected Agent
        agentWs.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return;
            const msg = JSON.parse(ev.data) as { id?: string; type: string; payload?: { url?: string } };
            if (msg.type === 'rpc.request' && msg.id) {
                agentWs.send(
                    JSON.stringify({
                        v: 1,
                        id: msg.id,
                        type: 'rpc.response',
                        payload: {
                            status: 200,
                            data: JSON.stringify({ displayName: 'ResidentialRelayOK', target: msg.payload?.url })
                        }
                    })
                );
            }
        });

        const proxyRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' })
        });
        expect(proxyRes.status).toBe(200);
        const proxyJson = (await proxyRes.json()) as { ok: boolean; data: { route: string; data: string } };
        expect(proxyJson.data.route).toBe('agent_residential_ip');
        expect(proxyJson.data.data).toContain('ResidentialRelayOK');

        // 6. Remote command allowlist + strict regex validation
        const badActionRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'exec_powershell', params: { cmd: 'calc.exe' } })
        });
        expect(badActionRes.status).toBe(400);

        const badLaunchUrlRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'launch_vrc', params: { launchUrl: 'vrchat://launch?id=wrld_x & calc' } })
        });
        expect(badLaunchUrlRes.status).toBe(400);

        const agentCmdPromise = waitForMessage(agentWs, (m) => m.includes('"cmd.dispatch"'));
        const okCmdRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                targetDeviceId: deviceId,
                params: { launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345' }
            })
        });
        expect(okCmdRes.status).toBe(200);
        expect(await agentCmdPromise).toContain('launch_vrc');

        // 7. Admin quota endpoint must succeed without forbidden PRAGMA calls
        const quotaRes = await exports.default.fetch('http://example.com/api/admin/quota');
        expect(quotaRes.status).toBe(200);
        const quotaJson = (await quotaRes.json()) as {
            ok: boolean;
            data: {
                healthy: boolean;
                databases: { core: { bytes: number }; gamelog: { bytes: number }; feed: { bytes: number } };
            };
        };
        expect(quotaJson.ok).toBe(true);
        expect(quotaJson.data.healthy).toBe(true);
        expect(typeof quotaJson.data.databases.core.bytes).toBe('number');

        agentWs.close(1000, 'done');
        webWs.close(1000, 'done');
    });

    it('blocks SSRF targets, encrypts VRChat cookies on cloud direct fallback, and enforces passcode login', async () => {
        // SSRF check
        const ssrfRes = await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' })
            }),
            env
        );
        expect(ssrfRes.status).toBe(403);

        // Cloud direct fallback stores Set-Cookie in encrypted vault and re-sends it on next request
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'set-cookie': 'auth=authcookie_secret_123; Path=/; HttpOnly'
                }
            })
        );
        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ id: 'usr_me' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );

        const loginProxy = await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    preferCloudDirect: true
                })
            }),
            env
        );
        expect(loginProxy.status).toBe(200);

        await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    preferCloudDirect: true
                })
            }),
            env
        );
        const secondInit = fetchSpy.mock.calls[1]?.[1];
        const sentHeaders = new Headers(secondInit?.headers);
        expect(sentHeaders.get('Cookie')).toContain('auth=authcookie_secret_123');

        // /api/vrc/pipeline requires WebSocket upgrade header and forwards encrypted authToken via Worker egress
        const nonWsRes = await worker.fetch(new Request('http://example.com/api/vrc/pipeline'), env);
        expect(nonWsRes.status).toBe(426);

        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
        await worker.fetch(
            new Request('http://example.com/api/vrc/pipeline', {
                headers: { Upgrade: 'websocket' }
            }),
            env
        );
        const wsTargetUrl = String(fetchSpy.mock.calls[2]?.[0] ?? '');
        const wsTargetHeaders = new Headers(fetchSpy.mock.calls[2]?.[1]?.headers);
        expect(wsTargetUrl).toBe('https://pipeline.vrchat.cloud/?authToken=authcookie_secret_123');
        expect(wsTargetHeaders.get('Upgrade')).toBe('websocket');
        expect(wsTargetHeaders.get('Cookie')).toContain('auth=authcookie_secret_123');

        fetchSpy.mockRestore();

        // Passcode session login flow
        const securedEnv: Env = { ...env, ADMIN_PASSCODE: 'princess-strong-pass-2026' };
        const blocked = await worker.fetch(new Request('http://example.com/api/bootstrap'), securedEnv);
        expect(blocked.status).toBe(401);

        const loginResp = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passcode: 'princess-strong-pass-2026' })
            }),
            securedEnv
        );
        expect(loginResp.status).toBe(200);
        const setCookie = loginResp.headers.get('Set-Cookie') ?? '';
        expect(setCookie).toContain('vrcx_cloud_session=');

        const sessionCookie = setCookie.split(';')[0]!;
        const authed = await worker.fetch(
            new Request('http://example.com/api/stats/table-sizes', {
                headers: { Cookie: sessionCookie }
            }),
            securedEnv
        );
        expect(authed.status).toBe(200);
    });

    it('supports periodic HTTP sync with URL + Sync Key, queued command pickup, and AGENT_SYNC_KEY secret', async () => {
        // 1. Web creates a persistent Sync Key
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Office-Win11' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as {
            ok: boolean;
            data: { deviceId: string; deviceName: string; syncKey: string };
        };
        expect(keyJson.ok).toBe(true);
        expect(keyJson.data.syncKey).toMatch(/^vrcx_sync_[0-9a-f]{48}$/);
        const { deviceId, syncKey } = keyJson.data;

        // Wrong Sync Key must be rejected with 401
        const badKeyRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer vrcx_sync_invalid_secret'
            },
            body: JSON.stringify({ events: [] })
        });
        expect(badKeyRes.status).toBe(401);

        // 2. Web queues a remote command while no WebSocket agent is online -> queued for HTTP sync
        const queueRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send_vr_notify',
                targetDeviceId: deviceId,
                params: { target: 'xsoverlay', title: 'Sync Test', content: 'Hello from HTTP queue' }
            })
        });
        expect(queueRes.status).toBe(200);
        const queueJson = (await queueRes.json()) as {
            ok: boolean;
            data: { cmdId: string; status: string; delivery: string };
        };
        expect(queueJson.data.status).toBe('queued');
        expect(queueJson.data.delivery).toBe('http_sync_queue');

        // 3. Windows Agent performs periodic HTTP upload using only URL + Sync Key (even with its own X-Device-Id)
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`,
                'X-Device-Id': 'local-pc-ignored-for-sync-key'
            },
            body: JSON.stringify({
                deviceName: 'Office-Win11-Renamed',
                agentVersion: '1.1.0',
                cursor: { fileName: 'output_log_http.txt', byteOffset: 2048, lastEventDt: '2026-11-24T01:00:00.000Z' },
                events: [
                    {
                        type: 'Location',
                        created_at: '2026-11-24T01:00:00.000Z',
                        location: 'wrld_22222222-2222-2222-2222-222222222222:99999',
                        worldId: 'wrld_22222222-2222-2222-2222-222222222222',
                        worldName: 'HTTP Sync Plaza'
                    }
                ],
                state: { isGameRunning: true, isVrRunning: false }
            })
        });
        expect(syncRes.status).toBe(200);
        const syncJson = (await syncRes.json()) as {
            ok: boolean;
            data: {
                deviceId: string;
                deviceName: string;
                ingest: { inserted: number };
                pendingCommands: Array<{ cmdId: string; action: string }>;
            };
        };
        expect(syncJson.data.deviceId).toBe(deviceId);
        // Web-configured Sync Key deviceName stays authoritative even if an older client sends another name.
        expect(syncJson.data.deviceName).toBe('Office-Win11');
        expect(syncJson.data.ingest.inserted).toBe(1);
        expect(syncJson.data.pendingCommands).toHaveLength(1);
        expect(syncJson.data.pendingCommands[0]!.cmdId).toBe(queueJson.data.cmdId);

        // 4. Agent reports command execution result via HTTP
        const resultRes = await exports.default.fetch(
            `http://example.com/api/agent/commands/${queueJson.data.cmdId}/result`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${syncKey}`
                },
                body: JSON.stringify({ status: 'succeeded', message: 'Sent via XSOverlay' })
            }
        );
        expect(resultRes.status).toBe(200);

        const historyRes = await exports.default.fetch('http://example.com/api/commands?limit=5');
        const historyJson = (await historyRes.json()) as {
            ok: boolean;
            data: Array<{ cmd_id: string; status: string }>;
        };
        expect(historyJson.data.some((c) => c.cmd_id === queueJson.data.cmdId && c.status === 'succeeded')).toBe(true);

        // 5. Shared env.AGENT_SYNC_KEY Bearer authentication works without pre-creating a device
        const envKeyEnv: Env = { ...env, AGENT_SYNC_KEY: 'princess-shared-secret-key' };
        const envBlocked = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        expect(envBlocked.status).toBe(401);

        const envOk = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer princess-shared-secret-key',
                    'X-Device-Id': 'win-home-pc',
                    'X-Device-Name': 'Home-Gaming-PC'
                },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        expect(envOk.status).toBe(200);
        const envOkJson = (await envOk.json()) as {
            ok: boolean;
            data: {
                deviceId: string;
                deviceName: string;
                syncIntervalSeconds: number;
                syncedAt: string;
                nextSyncAt: string;
            };
        };
        expect(envOkJson.data.deviceId).toBe('win-home-pc');
        expect(envOkJson.data.deviceName).toBe('Home-Gaming-PC');
        expect(envOkJson.data.syncIntervalSeconds).toBe(60);

        // 6. Updating cloud:syncIntervalSeconds on Web propagates immediately to /api/agent/sync schedule
        const setIntervalRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: { 'cloud:syncIntervalSeconds': '180' }
            })
        });
        expect(setIntervalRes.status).toBe(200);

        const nextSyncRes = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer princess-shared-secret-key',
                    'X-Device-Id': 'win-home-pc'
                },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        const nextSyncJson = (await nextSyncRes.json()) as {
            ok: boolean;
            data: { syncIntervalSeconds: number; syncedAt: string; nextSyncAt: string };
        };
        expect(nextSyncJson.data.syncIntervalSeconds).toBe(180);
        expect(Date.parse(nextSyncJson.data.nextSyncAt) - Date.parse(nextSyncJson.data.syncedAt)).toBe(180_000);
    });

    it('supports batched user-profiles, batched notifications, and SSRF-guarded /api/vrc/execute-batch', async () => {
        // 1. Batched user-profiles write
        const profRes = await exports.default.fetch('http://example.com/api/user-profiles', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    { userId: 'usr_batch_1', bio: 'hello 1', bioLinks: ['https://example.com'] },
                    { userId: 'usr_batch_2', bio: 'hello 2', bioLinks: [] }
                ]
            })
        });
        expect(profRes.status).toBe(200);
        const profJson = (await profRes.json()) as { ok: boolean; data: { count: number } };
        expect(profJson.data.count).toBe(2);

        // 2. Batched notifications v1 write
        const notyRes = await exports.default.fetch('http://example.com/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                entries: [
                    { id: 'not_b1', type: 'invite', senderUserId: 'usr_1', message: 'hi 1' },
                    { id: 'not_b2', type: 'invite', senderUserId: 'usr_2', message: 'hi 2' }
                ]
            })
        });
        expect(notyRes.status).toBe(200);
        const notyListRes = await exports.default.fetch('http://example.com/api/notifications?v=1&limit=10');
        const notyListJson = (await notyListRes.json()) as { ok: boolean; data: Array<{ id: string }> };
        expect(notyListJson.data.some((n) => n.id === 'not_b1')).toBe(true);
        expect(notyListJson.data.some((n) => n.id === 'not_b2')).toBe(true);

        // 3. /api/vrc/execute-batch enforces GET-only + VRChat SSRF allowlist
        const batchRes = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [
                    { url: 'https://evil.example.com/steal', method: 'GET' },
                    { url: 'https://api.vrchat.cloud/api/1/users/usr_1', method: 'POST' }
                ]
            })
        });
        expect(batchRes.status).toBe(200);
        const batchJson = (await batchRes.json()) as {
            ok: boolean;
            data: { results: Array<{ status: number; error?: string }> };
        };
        expect(batchJson.data.results).toHaveLength(2);
        expect(batchJson.data.results[0]!.status).toBe(403);
        expect(batchJson.data.results[1]!.status).toBe(403);
    });

    it('deduplicates screenshots by id or localFilename, exposes HTTP agents in bootstrap, and accrues total uptime monotonically', async () => {
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Dedupe-PC' })
        });
        const keyJson = (await keyRes.json()) as {
            ok: boolean;
            data: { deviceId: string; syncKey: string };
        };
        const { deviceId, syncKey } = keyJson.data;

        const metaB64 = btoa(
            JSON.stringify({
                takenAt: '2026-11-24T05:00:00.000Z',
                localFilename: 'VRChat_2026-11-24_05-00-00.000_1920x1080.png',
                worldId: 'wrld_dedupe',
                worldName: 'Dedupe World'
            })
        );

        // 1. First upload succeeds with duplicate: false
        const firstUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/aaaabbbbccccdddd1111222233334444',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': metaB64
                },
                body: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
            }
        );
        expect(firstUpload.status).toBe(200);
        const firstJson = (await firstUpload.json()) as { ok: boolean; data: { id: string; duplicate: boolean } };
        expect(firstJson.data.duplicate).toBe(false);

        // 2. Re-uploading same photo with a DIFFERENT id (e.g. compression toggle changed bytes) but same localFilename is deduplicated
        const secondUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/ffff0000eeee1111dddd2222cccc3333',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/webp',
                    'X-Screenshot-Meta': metaB64
                },
                body: new Uint8Array([82, 73, 70, 70, 9, 8, 7, 6])
            }
        );
        expect(secondUpload.status).toBe(200);
        const secondJson = (await secondUpload.json()) as { ok: boolean; data: { id: string; duplicate: boolean } };
        expect(secondJson.data.duplicate).toBe(true);
        expect(secondJson.data.id).toBe('aaaabbbbccccdddd1111222233334444');

        // Confirm only 1 row exists in cloud_screenshots for this filename
        const countRow = await env.DB_CORE.prepare(
            'SELECT COUNT(*) AS cnt FROM cloud_screenshots WHERE local_filename = ? COLLATE NOCASE'
        )
            .bind('VRChat_2026-11-24_05-00-00.000_1920x1080.png')
            .first<{ cnt: number }>();
        expect(countRow?.cnt).toBe(1);

        // 2b. Upload an older historical screenshot and verify keyset pagination on GET /api/screenshots
        const olderMetaB64 = btoa(
            JSON.stringify({
                takenAt: '2026-11-20T09:15:00.000Z',
                localFilename: 'VRChat_2026-11-20_09-15-00.000_1920x1080.png',
                worldId: 'wrld_older',
                worldName: 'Older World'
            })
        );
        const olderUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/1111222233334444aaaabbbbccccdddd',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': olderMetaB64
                },
                body: new Uint8Array([137, 80, 78, 71, 5, 6, 7, 8])
            }
        );
        expect(olderUpload.status).toBe(200);

        const page1Res = await exports.default.fetch('http://example.com/api/screenshots?limit=1');
        const page1Json = (await page1Res.json()) as {
            ok: boolean;
            data: Array<{ id: string; taken_at: string }>;
        };
        expect(page1Json.data).toHaveLength(1);
        const page2Res = await exports.default.fetch(
            `http://example.com/api/screenshots?limit=5&before=${encodeURIComponent(page1Json.data[0]!.taken_at)}&beforeId=${encodeURIComponent(page1Json.data[0]!.id)}`
        );
        const page2Json = (await page2Res.json()) as {
            ok: boolean;
            data: Array<{ id: string; taken_at: string }>;
        };
        expect(page2Json.data.some((s) => s.id === '1111222233334444aaaabbbbccccdddd')).toBe(true);
        expect(page2Json.data.some((s) => s.id === page1Json.data[0]!.id)).toBe(false);

        // 3. Agent performs HTTP sync with live VRChat + SteamVR state + real OS process start times -> bootstrap & uptime must persist and surface them
        const vrcStartedAt = new Date(Date.now() - 45 * 60_000).toISOString();
        const steamVrStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`
            },
            body: JSON.stringify({
                events: [],
                state: {
                    vrcRunning: true,
                    vrcStartedAt,
                    steamVrRunning: true,
                    steamVrStartedAt,
                    currentWorldName: 'Hanging Out'
                }
            })
        });
        expect(syncRes.status).toBe(200);

        // Subsequent sync omitting explicit timestamps (e.g. legacy agent fallback) must preserve the earlier startedAt timestamps
        const followSyncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`
            },
            body: JSON.stringify({
                events: [],
                state: { vrcRunning: true, steamVrRunning: true, currentWorldName: 'Hanging Out' }
            })
        });
        expect(followSyncRes.status).toBe(200);

        const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
        expect(bootRes.status).toBe(200);
        const bootJson = (await bootRes.json()) as {
            ok: boolean;
            data: {
                totalUptimeSeconds: number;
                agentStatus: {
                    agentsOnline: string[];
                    wsAgentsOnline: string[];
                    deviceLastSeen: Record<string, number>;
                    deviceStates: Record<
                        string,
                        {
                            state: {
                                vrcRunning?: boolean;
                                vrcStartedAt?: string;
                                steamVrRunning?: boolean;
                                steamVrStartedAt?: string;
                            };
                        }
                    >;
                };
            };
        };
        expect(bootJson.data.agentStatus.agentsOnline).toContain(deviceId);
        expect(bootJson.data.agentStatus.wsAgentsOnline).not.toContain(deviceId);
        expect(typeof bootJson.data.agentStatus.deviceLastSeen[deviceId]).toBe('number');
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.vrcRunning).toBe(true);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.vrcStartedAt).toBe(vrcStartedAt);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.steamVrRunning).toBe(true);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.steamVrStartedAt).toBe(steamVrStartedAt);
        expect(typeof bootJson.data.totalUptimeSeconds).toBe('number');

        // 3b. Upstream vrchat://launch invite/join URLs with ref, shortName, and attach=1 are accepted; arbitrary params are rejected
        const validLaunchCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                params: {
                    launchUrl:
                        'vrchat://launch?ref=vrcx.app&id=wrld_11111111-1111-1111-1111-111111111111:12345~region(jp)&shortName=abc123&attach=1'
                }
            })
        });
        expect(validLaunchCmd.status).toBe(200);

        const invalidLaunchCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                params: {
                    launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345&evil=cmd'
                }
            })
        });
        expect(invalidLaunchCmd.status).toBe(400);

        // 4. Simulate 90s elapsed since last watermark -> POST /api/stats/uptime accrues +90s cleanly and returns deviceStates
        const ninetySecondsAgo = new Date(Date.now() - 90_000).toISOString();
        await env.DB_CORE.prepare(
            "INSERT INTO stats_counters (counter_key, row_count, updated_at) VALUES ('cloud_total_uptime_seconds', 100, ?) ON CONFLICT(counter_key) DO UPDATE SET row_count = 100, updated_at = excluded.updated_at"
        )
            .bind(ninetySecondsAgo)
            .run();

        const uptimeRes = await exports.default.fetch('http://example.com/api/stats/uptime', { method: 'POST' });
        expect(uptimeRes.status).toBe(200);
        const uptimeJson = (await uptimeRes.json()) as {
            ok: boolean;
            data: {
                totalUptimeSeconds: number;
                httpAgentsOnline: string[];
                deviceStates: Record<string, { state: { vrcRunning?: boolean; steamVrRunning?: boolean } }>;
            };
        };
        expect(uptimeJson.data.totalUptimeSeconds).toBeGreaterThanOrEqual(189);
        expect(uptimeJson.data.totalUptimeSeconds).toBeLessThanOrEqual(195);
        expect(uptimeJson.data.httpAgentsOnline).toContain(deviceId);
        expect(uptimeJson.data.deviceStates[deviceId]?.state?.vrcRunning).toBe(true);
        expect(uptimeJson.data.deviceStates[deviceId]?.state?.steamVrRunning).toBe(true);

        // 5. Offline gap (> 360s) must NOT add offline hours to total uptime
        const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
        await env.DB_CORE.prepare(
            "UPDATE stats_counters SET row_count = 500, updated_at = ? WHERE counter_key = 'cloud_total_uptime_seconds'"
        )
            .bind(twoHoursAgo)
            .run();
        const afterOfflineRes = await exports.default.fetch('http://example.com/api/stats/uptime', { method: 'POST' });
        const afterOfflineJson = (await afterOfflineRes.json()) as {
            ok: boolean;
            data: { totalUptimeSeconds: number };
        };
        expect(afterOfflineJson.data.totalUptimeSeconds).toBe(500);
    });

    it('records friend Online/Offline/GPS/Status/Bio feeds and v1/v2 notifications via cloud Cron when Web tab is closed', async () => {
        // Store a VRChat auth cookie in the encrypted cloud cookie vault
        const encodedJar = btoa(JSON.stringify({ auth: 'authcookie_bg_sync_test' }));
        const putCookieRes = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: encodedJar })
        });
        expect(putCookieRes.status).toBe(200);

        const world1 = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const world2 = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        let round = 1;

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('/api/1/auth/user/friends')) {
                if (round === 1) {
                    return Response.json([
                        {
                            id: 'usr_friend_a',
                            displayName: 'Alice',
                            location: `${world1}:1001`,
                            status: 'active',
                            statusDescription: 'Chilling'
                        },
                        {
                            id: 'usr_friend_c',
                            displayName: 'Charlie',
                            location: `${world1}:1001`,
                            status: 'busy',
                            statusDescription: 'AFK'
                        }
                    ]);
                }
                return Response.json([
                    {
                        id: 'usr_friend_a',
                        displayName: 'Alice',
                        location: `${world2}:2002`,
                        status: 'join me',
                        statusDescription: 'Come hang out!'
                    },
                    {
                        id: 'usr_friend_b',
                        displayName: 'Bob',
                        location: 'private',
                        status: 'ask me',
                        statusDescription: 'Just hopped on'
                    }
                ]);
            }
            if (url.includes(`/api/1/worlds/${world1}`)) {
                return Response.json({ id: world1, name: 'Sakura Shrine' });
            }
            if (url.includes(`/api/1/worlds/${world2}`)) {
                return Response.json({ id: world2, name: 'Starlight Rooftop' });
            }
            if (url.includes('/api/1/users/usr_friend_a')) {
                return Response.json({
                    id: 'usr_friend_a',
                    displayName: 'Alice',
                    bio: round === 1 ? 'Old bio text' : 'New updated bio!',
                    bioLinks: round === 1 ? ['https://old.example'] : ['https://new.example']
                });
            }
            if (url.includes('/api/1/users/usr_friend_b')) {
                return Response.json({
                    id: 'usr_friend_b',
                    displayName: 'Bob',
                    bio: 'Bob bio',
                    bioLinks: []
                });
            }
            if (url.includes('/api/1/users/usr_friend_c')) {
                return Response.json({
                    id: 'usr_friend_c',
                    displayName: 'Charlie',
                    bio: 'Charlie bio',
                    bioLinks: []
                });
            }
            if (url.includes('/api/1/auth/user/notifications')) {
                return Response.json(
                    round === 1
                        ? []
                        : [
                              {
                                  id: 'not_bg_v1_1',
                                  created_at: new Date().toISOString(),
                                  type: 'invite',
                                  senderUserId: 'usr_friend_a',
                                  senderUsername: 'Alice',
                                  receiverUserId: 'usr_self',
                                  message: 'Join me!',
                                  details: JSON.stringify({
                                      worldId: `${world2}:2002`,
                                      worldName: 'Starlight Rooftop',
                                      inviteMessage: 'Come over'
                                  })
                              }
                          ]
                );
            }
            if (url.includes('/api/1/notifications')) {
                return Response.json(
                    round === 1
                        ? []
                        : [
                              {
                                  id: 'not_bg_v2_1',
                                  createdAt: new Date().toISOString(),
                                  type: 'boop',
                                  title: 'Boop!',
                                  message: 'Bob booped you',
                                  senderUserId: 'usr_friend_b',
                                  senderUsername: 'Bob',
                                  seen: false
                              }
                          ]
                );
            }
            return new Response('Not Found', { status: 404 });
        });

        try {
            // 1. While Web tab is active (bootstrap just ran), scheduled Cron defers cleanly without calling VRChat API
            // Also verify bootstrap reports independent webSyncIntervalSeconds (default 300s) even though agent syncIntervalSeconds is 180s
            const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
            const bootJson = (await bootRes.json()) as {
                ok: boolean;
                data: { syncIntervalSeconds: number; webSyncIntervalSeconds: number };
            };
            expect(bootJson.data.syncIntervalSeconds).toBe(180);
            expect(bootJson.data.webSyncIntervalSeconds).toBe(300);

            const deferred = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(deferred.ran).toBe(false);
            expect(deferred.status).toBe('skipped_web_active');

            // 2. Closing the Web tab (?closing=1) clears webLastActiveAt so Cron immediately takes over
            const closeRes = await exports.default.fetch('http://example.com/api/stats/uptime?closing=1', {
                method: 'POST'
            });
            expect(closeRes.status).toBe(200);

            // Round 1 establishes baseline snapshot & initial bios without emitting false Online events
            const r1 = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(r1.ran).toBe(true);
            expect(r1.status).toBe('baseline');
            expect(r1.onlineCount).toBe(2);
            expect(r1.feedInserted).toBe(0);
            expect(r1.bioChecked).toBe(2);

            // Immediate second cron tick before webSyncIntervalSeconds elapses is gated without VRChat calls
            const gated = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(gated.ran).toBe(false);
            expect(gated.status).toBe('skipped_interval');

            // Earlier test configured VRCX.Agent syncIntervalSeconds = 180s, while independent Cloud/Web webSyncIntervalSeconds defaults to 300s (5m):
            // backdating 240s (> 180s agent interval, < 300s cloud interval) MUST still gate!
            const fourMinAgo = new Date(Date.now() - 240_000).toISOString();
            const sixMinAgo = new Date(Date.now() - 360_000).toISOString();
            const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
            const metaRow = await env.DB_CORE.prepare(
                "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'poller_meta'"
            ).first<{ payload_json: string }>();
            const metaObj = JSON.parse(metaRow!.payload_json) as Record<string, unknown>;
            metaObj.lastRunAt = fourMinAgo;
            await env.DB_CORE.prepare("UPDATE cloud_bg_sync_state SET payload_json = ? WHERE state_key = 'poller_meta'")
                .bind(JSON.stringify(metaObj))
                .run();
            const stillGated = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(stillGated.ran).toBe(false);
            expect(stillGated.status).toBe('skipped_interval');

            // Backdate past 300s (360s) and Alice's cached profile past 10m (15m) -> next scheduled tick executes
            metaObj.lastRunAt = sixMinAgo;
            await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    "UPDATE cloud_bg_sync_state SET payload_json = ? WHERE state_key = 'poller_meta'"
                ).bind(JSON.stringify(metaObj)),
                env.DB_CORE.prepare("UPDATE user_profile SET updated_at = ? WHERE user_id = 'usr_friend_a'").bind(
                    fifteenMinAgo
                )
            ]);

            // Round 2: Alice changes world (GPS), status (Status), bio (Bio); Bob comes Online; Charlie goes Offline; v1 & v2 notifs arrive
            round = 2;
            const r2 = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(r2.ran).toBe(true);
            expect(r2.status).toBe('ok');
            expect(r2.onlineCount).toBe(2);
            expect(r2.feedInserted).toBe(5); // Online(Bob) + Offline(Charlie) + GPS(Alice) + Status(Alice) + Bio(Alice)
            expect(r2.notificationsInserted).toBe(2); // v1 invite + v2 boop

            // Verify all 5 Feed types and both notification versions are persisted and queryable via existing APIs
            const feedRes = await exports.default.fetch('http://example.com/api/feed?limit=50');
            const feedJson = (await feedRes.json()) as {
                ok: boolean;
                data: Array<Record<string, unknown>>;
            };
            expect(
                feedJson.data.some(
                    (f) => f.type === 'GPS' && f.userId === 'usr_friend_a' && f.worldName === 'Starlight Rooftop'
                )
            ).toBe(true);
            expect(
                feedJson.data.some((f) => f.type === 'Status' && f.userId === 'usr_friend_a' && f.status === 'join me')
            ).toBe(true);
            expect(
                feedJson.data.some(
                    (f) => f.type === 'Bio' && f.userId === 'usr_friend_a' && f.bio === 'New updated bio!'
                )
            ).toBe(true);
            expect(feedJson.data.some((f) => f.type === 'Online' && f.userId === 'usr_friend_b')).toBe(true);
            expect(
                feedJson.data.some(
                    (f) => f.type === 'Offline' && f.userId === 'usr_friend_c' && f.worldName === 'Sakura Shrine'
                )
            ).toBe(true);

            const n1Res = await exports.default.fetch('http://example.com/api/notifications?v=1&limit=20');
            const n1Json = (await n1Res.json()) as { ok: boolean; data: Array<{ id: string; world_name: string }> };
            expect(n1Json.data.some((n) => n.id === 'not_bg_v1_1' && n.world_name === 'Starlight Rooftop')).toBe(true);

            const n2Res = await exports.default.fetch('http://example.com/api/notifications?v=2&limit=20');
            const n2Json = (await n2Res.json()) as { ok: boolean; data: Array<{ id: string; type: string }> };
            expect(n2Json.data.some((n) => n.id === 'not_bg_v2_1' && n.type === 'boop')).toBe(true);

            // 3. Toggle disabled via PUT /api/bg-sync/config and verify Cron skips cleanly
            const disableRes = await exports.default.fetch('http://example.com/api/bg-sync/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            });
            expect(disableRes.status).toBe(200);
            const skippedDisabled = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(skippedDisabled.ran).toBe(false);
            expect(skippedDisabled.status).toBe('skipped_disabled');

            const statusRes = await exports.default.fetch('http://example.com/api/bg-sync/status');
            expect(statusRes.status).toBe(200);
            const statusJson = (await statusRes.json()) as {
                ok: boolean;
                data: { enabled: boolean; hasVrcSession: boolean; meta: { lastOnlineCount: number } };
            };
            expect(statusJson.data.enabled).toBe(false);
            expect(statusJson.data.hasVrcSession).toBe(true);
            expect(statusJson.data.meta.lastOnlineCount).toBe(2);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('reconstructs chronological /api/gamelog/current-instance via created_at index for both legacy v1.10.4 logs and v1.10.5 live snapshots', async () => {
        // Verify ORDER BY created_at DESC / ASC queries use UNIQUE(created_at, ...) indexes without temp B-tree sort
        const locPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT 1'
        ).all<{ detail: string }>();
        const jlPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT * FROM gamelog_join_leave WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500'
        )
            .bind('2026-01-01T00:00:00.000Z')
            .all<{ detail: string }>();
        const locDetails = (locPlan.results ?? []).map((r) => r.detail).join(' | ');
        const jlDetails = (jlPlan.results ?? []).map((r) => r.detail).join(' | ');
        expect(locDetails).not.toContain('USE TEMP B-TREE');
        expect(jlDetails).not.toContain('USE TEMP B-TREE');

        // 1. Simulate legacy v1.10.4 Agent: Location has empty location string (Entering Room arrived before Joining),
        // followed by chronological join/leave rows with real location, PLUS an older backfilled row inserted later (higher id!)
        const now = Date.now();
        const tLoc = new Date(now - 90_000).toISOString();
        const tJoinA = new Date(now - 85_000).toISOString();
        const tJoinB = new Date(now - 80_000).toISOString();
        const tLeftB = new Date(now - 60_000).toISOString();
        const tOldBackfill = new Date(now - 5 * 86400_000).toISOString();
        const realLoc = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:77777~region(jp)';

        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { type: 'Location', created_at: tLoc, location: '', worldId: '', worldName: 'Sakura Lounge' },
                    {
                        type: 'OnPlayerJoined',
                        created_at: tJoinA,
                        displayName: 'Alice',
                        userId: 'usr_alice_inst',
                        location: realLoc
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: tJoinB,
                        displayName: 'Bob',
                        userId: 'usr_bob_inst',
                        location: realLoc
                    },
                    {
                        type: 'OnPlayerLeft',
                        created_at: tLeftB,
                        displayName: 'Bob',
                        userId: 'usr_bob_inst',
                        location: realLoc
                    },
                    // Backfilled historical event inserted AFTER current room (higher SQLite autoincrement id!)
                    {
                        type: 'Location',
                        created_at: tOldBackfill,
                        location: 'wrld_old:1',
                        worldId: 'wrld_old',
                        worldName: 'Ancient Backfill Room'
                    }
                ]
            })
        });

        // Clear any existing device states so Path B (D1 replay) is exercised cleanly
        await env.DB_CORE.prepare('DELETE FROM cloud_device_states').run();

        const replayRes = await exports.default.fetch('http://example.com/api/gamelog/current-instance');
        expect(replayRes.status).toBe(200);
        const replayJson = (await replayRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; location: string; worldName?: string; displayName?: string; userId?: string }>;
        };
        expect(replayJson.ok).toBe(true);
        // Must be strictly chronological: index 0 is Location with resolved realLoc, followed by JoinA -> JoinB -> LeftB
        expect(replayJson.data.map((r) => r.type)).toEqual([
            'Location',
            'OnPlayerJoined',
            'OnPlayerJoined',
            'OnPlayerLeft'
        ]);
        expect(replayJson.data[0]?.location).toBe(realLoc);
        expect(replayJson.data[0]?.worldName).toBe('Sakura Lounge');
        expect(replayJson.data[1]?.userId).toBe('usr_alice_inst');
        expect(replayJson.data[2]?.userId).toBe('usr_bob_inst');
        expect(replayJson.data[3]?.userId).toBe('usr_bob_inst');

        // 2. Simulate v1.10.5 Agent uploading authoritative live currentPlayers snapshot via /api/agent/sync
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Test-PC-PlayerList' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as { ok: boolean; data: { syncKey: string; deviceId: string } };
        const v105Room = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:88888~region(jp)';
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${keyJson.data.syncKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                deviceId: keyJson.data.deviceId,
                deviceName: 'Test-PC-PlayerList',
                agentVersion: '1.10.5',
                state: {
                    vrcRunning: true,
                    currentLocation: v105Room,
                    currentWorldId: 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                    currentWorldName: 'Moonlight Cafe',
                    playerCount: 2,
                    currentPlayers: [
                        { displayName: 'Miku', userId: 'usr_miku', joinedAt: new Date(now - 30_000).toISOString() },
                        { displayName: 'Rin', userId: 'usr_rin', joinedAt: new Date(now - 10_000).toISOString() }
                    ]
                }
            })
        });
        expect(syncRes.status).toBe(200);

        const snapRes = await exports.default.fetch('http://example.com/api/gamelog/current-instance');
        expect(snapRes.status).toBe(200);
        const snapJson = (await snapRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; location: string; worldName?: string; displayName?: string; userId?: string }>;
        };
        expect(snapJson.data.map((r) => r.type)).toEqual(['Location', 'OnPlayerJoined', 'OnPlayerJoined']);
        expect(snapJson.data[0]?.location).toBe(v105Room);
        expect(snapJson.data[0]?.worldName).toBe('Moonlight Cafe');
        expect(snapJson.data.slice(1).map((r) => r.userId)).toEqual(['usr_miku', 'usr_rin']);
    });
});
