import { authenticateAgent, authenticateWeb, handleAuthRoutes } from './auth/auth';
import { ensureSchemaReady } from './db/schemaBootstrap';
import type { Env } from './env';
import { AgentHubDO } from './hub/AgentHubDO';
import { handleAgentPublicRoutes, handleAgentWebRoutes } from './routes/agentRoutes';
import { handleCoreDataRoutes } from './routes/coreData';
import { handleEventsDataRoutes } from './routes/eventsData';
import { handleVrcProxyRoutes } from './routes/vrcProxy';
import { searchGameLogByEntity } from './search/entityFts';
import {
    getBackgroundFeedSyncStatus,
    runBackgroundFeedSync,
    setBackgroundFeedSyncEnabled
} from './sync/backgroundFeedSync';

export { AgentHubDO };

const VRC_PUBLIC_CONFIG_URL = 'https://api.vrchat.cloud/api/1/config';
const VRC_PROBE_USER_AGENT = 'VRCX-Cloud/2026.11 (connectivity-probe)';

function unauthorizedResponse(): Response {
    return Response.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
    );
}

/**
 * Probes VRChat's public read-only config endpoint (hardcoded URL to prevent SSRF)
 * to verify whether Cloudflare Workers egress IPs encounter WAF/403 challenges.
 */
async function probeVrchatApi(): Promise<Response> {
    const startedAt = Date.now();
    try {
        const res = await fetch(VRC_PUBLIC_CONFIG_URL, {
            method: 'GET',
            headers: {
                'User-Agent': VRC_PROBE_USER_AGENT,
                Accept: 'application/json'
            }
        });
        const latencyMs = Date.now() - startedAt;
        const contentType = res.headers.get('content-type') ?? '';
        const cfMitigated = res.headers.get('cf-mitigated') ?? null;
        const server = res.headers.get('server') ?? null;

        let parsedClientApiKeyPresent = false;
        let parsedJson = false;
        if (contentType.includes('application/json')) {
            const body = (await res.json()) as Record<string, unknown>;
            parsedJson = true;
            parsedClientApiKeyPresent = typeof body.clientApiKey === 'string' && body.clientApiKey.length > 0;
        } else {
            await res.text();
        }

        const blockedByWaf = res.status === 403 || cfMitigated !== null || (res.ok && !parsedJson);

        return Response.json({
            ok: true,
            data: {
                target: VRC_PUBLIC_CONFIG_URL,
                httpStatus: res.status,
                latencyMs,
                contentType,
                server,
                cfMitigated,
                parsedJson,
                parsedClientApiKeyPresent,
                blockedByWaf
            }
        });
    } catch (err) {
        return Response.json(
            {
                ok: false,
                error: {
                    code: 'PROBE_NETWORK_ERROR',
                    message: err instanceof Error ? err.message : 'Unknown network error'
                }
            },
            { status: 502 }
        );
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        try {
            // 1. Public health check (also triggers idempotent cold-start D1 schema bootstrap)
            if (url.pathname === '/health' && request.method === 'GET') {
                await ensureSchemaReady(env);
                return Response.json({
                    ok: true,
                    data: {
                        service: 'vrcx-cloud',
                        version: '2026.11',
                        schemaReady: true,
                        r2Enabled: Boolean(env.R2_MEDIA),
                        timestamp: new Date().toISOString()
                    }
                });
            }

            // 2. Auth endpoints (/api/auth/me, /api/auth/login, /api/auth/logout)
            const authResp = await handleAuthRoutes(request, env, url);
            if (authResp) {
                return authResp;
            }

            // Ensure D1 tables exist before handling any DB-backed route
            await ensureSchemaReady(env);

            // 3. Windows Agent routes (pairing redemption & Device Bearer+HMAC authenticated endpoints)
            const agentPublicResp = await handleAgentPublicRoutes(request, env, url);
            if (agentPublicResp) {
                return agentPublicResp;
            }

            // 4. Windows Agent WebSocket upgrade (Device Bearer auth)
            if (url.pathname === '/ws/agent') {
                const agentAuth = await authenticateAgent(request, env, '');
                if (!agentAuth.authenticated || !agentAuth.deviceId) {
                    return unauthorizedResponse();
                }
                const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
                const targetUrl = new URL(request.url);
                targetUrl.searchParams.set('deviceId', agentAuth.deviceId);
                return hub.fetch(new Request(targetUrl.toString(), request));
            }

            // 5. All remaining /api/*, /poc/*, /ws/web routes require Web user authentication
            const webAuth = await authenticateWeb(request, env);
            if (!webAuth.authenticated) {
                return unauthorizedResponse();
            }

            if (url.pathname === '/ws/web') {
                const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
                return hub.fetch(request);
            }

            if (url.pathname === '/api/agent/status' && request.method === 'GET') {
                const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
                return hub.fetch(new Request('https://agent-hub.internal/status'));
            }

            if (url.pathname === '/poc/vrc-probe' && request.method === 'GET') {
                return probeVrchatApi();
            }

            if (url.pathname === '/poc/search' && request.method === 'GET') {
                const q = url.searchParams.get('q') ?? '';
                const limit = Number(url.searchParams.get('limit') ?? '50');
                const includeExplain = url.searchParams.get('explain') === '1';
                const data = await searchGameLogByEntity(env, q, { limit, includeExplain });
                return Response.json({ ok: true, data });
            }

            if (url.pathname === '/api/bg-sync/status' && request.method === 'GET') {
                const data = await getBackgroundFeedSyncStatus(env);
                return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
            }

            if (url.pathname === '/api/bg-sync/run' && request.method === 'POST') {
                const data = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
                return Response.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
            }

            if (url.pathname === '/api/bg-sync/config' && request.method === 'PUT') {
                const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
                const enabled = await setBackgroundFeedSyncEnabled(env, body.enabled !== false);
                return Response.json({ ok: true, data: { enabled } });
            }

            const vrcResp = await handleVrcProxyRoutes(request, env, url);
            if (vrcResp) return vrcResp;

            const coreResp = await handleCoreDataRoutes(request, env, url);
            if (coreResp) return coreResp;

            const eventsResp = await handleEventsDataRoutes(request, env, url);
            if (eventsResp) return eventsResp;

            const agentWebResp = await handleAgentWebRoutes(request, env, url);
            if (agentWebResp) return agentWebResp;

            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } },
                { status: 404 }
            );
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'INTERNAL_ERROR',
                        message: err instanceof Error ? err.message : 'Unexpected server error'
                    }
                },
                { status: 500 }
            );
        }
    },

    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        const task = (async () => {
            await ensureSchemaReady(env);
            await runBackgroundFeedSync(env, { trigger: 'cron' });
        })();
        ctx.waitUntil(task);
        await task;
    }
} satisfies ExportedHandler<Env>;
