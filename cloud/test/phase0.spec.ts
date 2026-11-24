import { evictDurableObject } from 'cloudflare:test';
import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import type { EntitySearchResult } from '../src/search/entityFts';

const env = rawEnv as unknown as Env;
const exports = rawExports as unknown as { default: Fetcher };

function waitForMessage(ws: WebSocket, predicate: (data: string) => boolean, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMessage);
            reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
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

describe('Phase 0 POC: Sharded D1 FTS5 + AgentHubDO Hibernation + VRChat Probe', () => {
    beforeAll(async () => {
        // Trigger zero-CLI cold-start schema auto-bootstrap (mirrors one-click Cloudflare deployment)
        const bootRes = await exports.default.fetch('http://example.com/health');
        expect(bootRes.status).toBe(200);
        const bootJson = (await bootRes.json()) as { ok: boolean; data: { schemaReady: boolean } };
        expect(bootJson.ok).toBe(true);
        expect(bootJson.data.schemaReady).toBe(true);

        // Seed 500 deduplicated users (including CJK, Japanese, Latin, and FTS5 special characters)
        const now = '2026-11-23T12:00:00.000Z';
        const userStmts: D1PreparedStatement[] = [
            env.DB_CORE.prepare(
                'INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES (?, ?, ?, ?)'
            ).bind('usr_sakura_001', '木之本樱', 'Sakura_Knight Cardcaptor', now),
            env.DB_CORE.prepare(
                'INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES (?, ?, ?, ?)'
            ).bind('usr_ruby_002', '星野ルビー', 'HoshinoRuby', now),
            env.DB_CORE.prepare(
                'INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES (?, ?, ?, ?)'
            ).bind('usr_special_003', 'A"B-C:D*Test', '', now)
        ];
        for (let i = 4; i <= 500; i++) {
            userStmts.push(
                env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES (?, ?, ?, ?)'
                ).bind(`usr_bulk_${String(i).padStart(4, '0')}`, `PlayerNoise_${i}`, '', now)
            );
        }
        // Batch in chunks of 50 to honor Free-tier D1 query batching habits
        for (let i = 0; i < userStmts.length; i += 50) {
            await env.DB_CORE.batch(userStmts.slice(i, i + 50));
        }

        // Seed 100 deduplicated worlds
        const worldStmts: D1PreparedStatement[] = [
            env.DB_CORE.prepare(
                'INSERT OR IGNORE INTO entity_worlds (world_id, world_name, updated_at) VALUES (?, ?, ?)'
            ).bind('wrld_jp_hub_001', '日本語集会所 JP Shrine', now),
            env.DB_CORE.prepare(
                'INSERT OR IGNORE INTO entity_worlds (world_id, world_name, updated_at) VALUES (?, ?, ?)'
            ).bind('wrld_roof_002', 'Midnight Rooftop Lounge', now)
        ];
        for (let i = 3; i <= 100; i++) {
            worldStmts.push(
                env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO entity_worlds (world_id, world_name, updated_at) VALUES (?, ?, ?)'
                ).bind(`wrld_bulk_${String(i).padStart(4, '0')}`, `Random World ${i}`, now)
            );
        }
        for (let i = 0; i < worldStmts.length; i += 50) {
            await env.DB_CORE.batch(worldStmts.slice(i, i + 50));
        }

        // Seed 5,000 gamelog_join_leave rows (mostly noise + targeted rows)
        const jlInsertSql =
            'INSERT INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (?, ?, ?, ?, ?, ?)';
        const jlBatch: D1PreparedStatement[] = [];
        for (let i = 0; i < 4990; i++) {
            const uid = `usr_bulk_${String((i % 496) + 4).padStart(4, '0')}`;
            jlBatch.push(
                env.DB_GAMELOG.prepare(jlInsertSql).bind(
                    `2026-11-23T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
                    'OnPlayerJoined',
                    `PlayerNoise_${(i % 496) + 4}`,
                    'wrld_bulk_0003:12345',
                    uid,
                    60
                )
            );
            if (jlBatch.length === 50) {
                await env.DB_GAMELOG.batch(jlBatch.splice(0, 50));
            }
        }
        // Targeted join/leave rows for our test characters
        for (let i = 0; i < 5; i++) {
            jlBatch.push(
                env.DB_GAMELOG.prepare(jlInsertSql).bind(
                    `2026-11-23T20:00:0${i}.000Z`,
                    'OnPlayerJoined',
                    '木之本樱',
                    'wrld_jp_hub_001:99999',
                    'usr_sakura_001',
                    300
                )
            );
        }
        jlBatch.push(
            env.DB_GAMELOG.prepare(jlInsertSql).bind(
                '2026-11-23T21:00:00.000Z',
                'OnPlayerJoined',
                'A"B-C:D*Test',
                'wrld_roof_002:88888',
                'usr_special_003',
                120
            )
        );
        if (jlBatch.length > 0) {
            await env.DB_GAMELOG.batch(jlBatch);
        }

        // Seed 500 gamelog_location rows
        const locInsertSql =
            'INSERT INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?)';
        const locBatch: D1PreparedStatement[] = [];
        for (let i = 0; i < 497; i++) {
            const wid = `wrld_bulk_${String((i % 97) + 3).padStart(4, '0')}`;
            locBatch.push(
                env.DB_GAMELOG.prepare(locInsertSql).bind(
                    `2026-11-22T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
                    `${wid}:inst_${i}`,
                    wid,
                    `Random World ${(i % 97) + 3}`,
                    180,
                    ''
                )
            );
            if (locBatch.length === 50) {
                await env.DB_GAMELOG.batch(locBatch.splice(0, 50));
            }
        }
        locBatch.push(
            env.DB_GAMELOG.prepare(locInsertSql).bind(
                '2026-11-23T20:00:00.000Z',
                'wrld_jp_hub_001:99999',
                'wrld_jp_hub_001',
                '日本語集会所 JP Shrine',
                1800,
                'JP Friends'
            )
        );
        if (locBatch.length > 0) {
            await env.DB_GAMELOG.batch(locBatch);
        }
    });

    it('returns health status cleanly', async () => {
        const res = await exports.default.fetch('http://example.com/health');
        expect(res.status).toBe(200);
        const json = (await res.json()) as { ok: boolean; data: { service: string; phase: string } };
        expect(json.ok).toBe(true);
        expect(json.data.service).toBe('vrcx-cloud');
    });

    it('finds CJK (Chinese) 3-char substring via FTS5 trigram + B-tree index with rows_read < 100 and zero full-table scan', async () => {
        const res = await exports.default.fetch('http://example.com/poc/search?q=' + encodeURIComponent('木之本') + '&explain=1');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; data: EntitySearchResult };
        expect(body.ok).toBe(true);
        expect(body.data.strategy).toBe('trigram_fts');
        expect(body.data.matchedUserIds).toEqual(['usr_sakura_001']);
        expect(body.data.joinLeaveRows).toHaveLength(5);

        // Verify zero full-table scan in EXPLAIN QUERY PLAN
        const plans = body.data.queryPlans!;
        expect(plans.usersDictionary.join(' ')).toContain('VIRTUAL TABLE INDEX');
        expect(plans.joinLeaveLookup.join(' ')).toContain('idx_gamelog_jl_user_id');
        expect(plans.joinLeaveLookup.join(' ')).not.toContain('SCAN gamelog_join_leave');

        // Verify Free-tier budget: < 100 rows read out of 5,000+ total event rows
        console.log('[POC METRIC] Chinese FTS5 search rows_read:', body.data.metrics, 'plans:', plans);
        expect(body.data.metrics.totalRowsRead).toBeLessThan(100);
    });

    it('finds Japanese world substring via FTS5 trigram + B-tree index with rows_read < 100', async () => {
        const res = await exports.default.fetch('http://example.com/poc/search?q=' + encodeURIComponent('集会所') + '&explain=1');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; data: EntitySearchResult };
        expect(body.data.strategy).toBe('trigram_fts');
        expect(body.data.matchedWorldIds).toEqual(['wrld_jp_hub_001']);
        expect(body.data.locationRows).toHaveLength(1);
        expect(body.data.queryPlans!.locationLookup.join(' ')).toContain('idx_gamelog_loc_world_id');
        expect(body.data.queryPlans!.locationLookup.join(' ')).not.toContain('SCAN gamelog_location');
        console.log('[POC METRIC] Japanese world search rows_read:', body.data.metrics);
        expect(body.data.metrics.totalRowsRead).toBeLessThan(100);
    });

    it('safely handles FTS5 reserved characters (quotes, hyphens, colons, asterisks) without syntax error', async () => {
        const res = await exports.default.fetch(
            'http://example.com/poc/search?q=' + encodeURIComponent('A"B-C:D*') + '&explain=1'
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; data: EntitySearchResult };
        expect(body.data.matchedUserIds).toEqual(['usr_special_003']);
        expect(body.data.joinLeaveRows).toHaveLength(1);
        expect(body.data.metrics.totalRowsRead).toBeLessThan(100);
    });

    it('matches alias text and keeps short 1-2 char queries strictly bounded', async () => {
        const aliasRes = await exports.default.fetch('http://example.com/poc/search?q=Sakura');
        const aliasBody = (await aliasRes.json()) as { ok: boolean; data: EntitySearchResult };
        expect(aliasBody.data.matchedUserIds).toEqual(['usr_sakura_001']);
        expect(aliasBody.data.metrics.totalRowsRead).toBeLessThan(100);

        const shortRes = await exports.default.fetch('http://example.com/poc/search?q=' + encodeURIComponent('樱'));
        const shortBody = (await shortRes.json()) as { ok: boolean; data: EntitySearchResult };
        expect(shortBody.data.strategy).toBe('bounded_short_query');
        expect(shortBody.data.metrics.totalRowsRead).toBeLessThan(150);
    });

    it('maintains WebSocket Hibernation, auto-responds ping->pong, and resumes bidirectional routing after DO eviction', async () => {
        const agentUpgrade = await exports.default.fetch('http://example.com/ws/agent?deviceId=win-desktop-01', {
            headers: { Upgrade: 'websocket' }
        });
        expect(agentUpgrade.status).toBe(101);
        const agentWs = agentUpgrade.webSocket!;
        agentWs.accept();

        const webUpgrade = await exports.default.fetch('http://example.com/ws/web', {
            headers: { Upgrade: 'websocket' }
        });
        expect(webUpgrade.status).toBe(101);
        const webWs = webUpgrade.webSocket!;
        webWs.accept();

        // 1. Verify zero-cost ping -> pong AutoResponse
        const pongPromise = waitForMessage(agentWs, (msg) => msg === 'pong');
        agentWs.send('ping');
        expect(await pongPromise).toBe('pong');

        // 2. Agent reports live VRChat state -> persisted to DO SQLite and broadcast to web
        const stateBroadcastPromise = waitForMessage(webWs, (msg) => msg.includes('"agent.state"'));
        agentWs.send(
            JSON.stringify({
                v: 1,
                type: 'agent.state',
                payload: { vrcRunning: true, worldName: '日本語集会所 JP Shrine', playerCount: 12 }
            })
        );
        const stateBroadcast = JSON.parse(await stateBroadcastPromise) as { payload: { worldName: string } };
        expect(stateBroadcast.payload.worldName).toBe('日本語集会所 JP Shrine');

        // 3. Force-evict AgentHubDO instance while hibernating WebSockets (real hibernation lifecycle!)
        const stub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        await evictDurableObject(stub, { webSockets: 'hibernate' });

        // 4. After hibernation wakeup, status must still list online agent + persisted state
        const statusRes = await exports.default.fetch('http://example.com/api/agent/status');
        expect(statusRes.status).toBe(200);
        const statusJson = (await statusRes.json()) as {
            ok: boolean;
            data: {
                agentsOnline: string[];
                webClientsCount: number;
                deviceStates: Record<string, { state: { worldName: string } }>;
            };
        };
        expect(statusJson.data.agentsOnline).toContain('win-desktop-01');
        expect(statusJson.data.webClientsCount).toBeGreaterThanOrEqual(1);
        expect(statusJson.data.deviceStates['win-desktop-01']?.state.worldName).toBe('日本語集会所 JP Shrine');

        // 5. Web dispatches remote command after DO woke from hibernation -> Agent receives -> returns result
        const agentCmdPromise = waitForMessage(agentWs, (msg) => msg.includes('"cmd.dispatch"'));
        webWs.send(
            JSON.stringify({
                v: 1,
                id: 'cmd-001',
                type: 'cmd.dispatch',
                payload: {
                    targetDeviceId: 'win-desktop-01',
                    action: 'launch_vrc',
                    launchUrl: 'vrchat://launch?id=wrld_jp_hub_001:99999'
                }
            })
        );
        const receivedCmd = JSON.parse(await agentCmdPromise) as { id: string; payload: { action: string } };
        expect(receivedCmd.id).toBe('cmd-001');
        expect(receivedCmd.payload.action).toBe('launch_vrc');

        const webResultPromise = waitForMessage(webWs, (msg) => msg.includes('"cmd.result"'));
        agentWs.send(
            JSON.stringify({
                v: 1,
                id: 'cmd-001',
                type: 'cmd.result',
                payload: { status: 'succeeded' }
            })
        );
        const receivedResult = JSON.parse(await webResultPromise) as { payload: { status: string } };
        expect(receivedResult.payload.status).toBe('succeeded');

        agentWs.close(1000, 'test done');
        webWs.close(1000, 'test done');
    });

    it('enforces bearer authentication when POC_ADMIN_TOKEN is configured', async () => {
        const protectedEnv: Env = { ...env, POC_ADMIN_TOKEN: 'secret-phase0-token' };

        // /health stays accessible without auth
        const healthRes = await worker.fetch(new Request('http://example.com/health'), protectedEnv);
        expect(healthRes.status).toBe(200);

        // Protected routes reject missing or wrong bearer token
        const unauthRes = await worker.fetch(new Request('http://example.com/poc/search?q=Sakura'), protectedEnv);
        expect(unauthRes.status).toBe(401);

        const wrongRes = await worker.fetch(
            new Request('http://example.com/poc/search?q=Sakura', {
                headers: { Authorization: 'Bearer wrong-token' }
            }),
            protectedEnv
        );
        expect(wrongRes.status).toBe(401);

        const okRes = await worker.fetch(
            new Request('http://example.com/poc/search?q=Sakura', {
                headers: { Authorization: 'Bearer secret-phase0-token' }
            }),
            protectedEnv
        );
        expect(okRes.status).toBe(200);
    });

    it('detects both healthy JSON and Cloudflare WAF 403 challenge responses on /poc/vrc-probe', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ clientApiKey: 'JlE5Jldo5Jibnk5O5hTx6XVqsJu4WJ26' }), {
                status: 200,
                headers: { 'content-type': 'application/json; charset=utf-8', server: 'cloudflare' }
            })
        );
        const okRes = await worker.fetch(new Request('http://example.com/poc/vrc-probe'), env);
        const okJson = (await okRes.json()) as {
            ok: boolean;
            data: { httpStatus: number; blockedByWaf: boolean; parsedClientApiKeyPresent: boolean };
        };
        expect(okJson.ok).toBe(true);
        expect(okJson.data.httpStatus).toBe(200);
        expect(okJson.data.blockedByWaf).toBe(false);
        expect(okJson.data.parsedClientApiKeyPresent).toBe(true);

        fetchSpy.mockResolvedValueOnce(
            new Response('<html>Just a moment...</html>', {
                status: 403,
                headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' }
            })
        );
        const wafRes = await worker.fetch(new Request('http://example.com/poc/vrc-probe'), env);
        const wafJson = (await wafRes.json()) as {
            ok: boolean;
            data: { httpStatus: number; blockedByWaf: boolean; cfMitigated: string | null };
        };
        expect(wafJson.ok).toBe(true);
        expect(wafJson.data.httpStatus).toBe(403);
        expect(wafJson.data.blockedByWaf).toBe(true);
        expect(wafJson.data.cfMitigated).toBe('challenge');

        fetchSpy.mockRestore();
    });
});
