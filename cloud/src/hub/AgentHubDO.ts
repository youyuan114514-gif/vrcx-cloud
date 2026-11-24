import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

type ClientRole = 'agent' | 'web';

interface SocketAttachment {
    role: ClientRole;
    deviceId: string;
    connectedAt: string;
}

interface HubEnvelope {
    v?: number;
    id?: string;
    type: string;
    ts?: number;
    payload?: Record<string, unknown>;
}

interface PendingRpc {
    resolve: (payload: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const MAX_MESSAGE_BYTES = 524_288; // 512 KiB guardrail (supports VRChat JSON list responses)
const RPC_TIMEOUT_MS = 18_000;

/**
 * Single-instance SQLite-backed Durable Object coordinating real-time WebSocket
 * communication between Windows VRCX.Agent devices and stateless Web browsers.
 *
 * Uses WebSocket Hibernation + setWebSocketAutoResponse so idle connections
 * incur zero compute duration on the Cloudflare Workers Free tier.
 */
export class AgentHubDO extends DurableObject<Env> {
    private readonly pendingRpcs = new Map<string, PendingRpc>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // Zero-cost keepalive handled outside JS execution (no wakeup / 0 duration billing).
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS live_device_state (
                device_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/status' && request.method === 'GET') {
            return Response.json({
                ok: true,
                data: this.getLiveStatus()
            });
        }

        if (url.pathname === '/broadcast' && request.method === 'POST') {
            const body = (await request.json()) as HubEnvelope & { messages?: HubEnvelope[] };
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const list = Array.isArray(body?.messages) ? body.messages : body?.type ? [body] : [];
            for (const msg of list) {
                if (msg && typeof msg.type === 'string') {
                    if (msg.type === 'agent.state' && typeof msg.payload?.deviceId === 'string' && msg.payload.deviceId) {
                        const { deviceId, ...statePayload } = msg.payload;
                        this.ctx.storage.sql.exec(
                            `INSERT INTO live_device_state (device_id, state_json, updated_at)
                             VALUES (?, ?, ?)
                             ON CONFLICT(device_id) DO UPDATE SET
                                state_json = excluded.state_json,
                                updated_at = excluded.updated_at`,
                            deviceId,
                            JSON.stringify(statePayload),
                            nowIso
                        );
                    }
                    this.broadcastToRole('web', { ...msg, v: 1, ts: now });
                }
            }
            return Response.json({ ok: true });
        }

        if (url.pathname === '/rpc/vrc-http' && request.method === 'POST') {
            return this.handleVrcHttpRpc(request);
        }

        if (url.pathname === '/dispatch-command' && request.method === 'POST') {
            return this.handleDispatchCommand(request);
        }

        if (url.pathname === '/ws/agent' || url.pathname === '/ws/web') {
            if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
                return new Response('Expected WebSocket Upgrade', { status: 426 });
            }

            const role: ClientRole = url.pathname === '/ws/agent' ? 'agent' : 'web';
            const deviceId =
                role === 'agent'
                    ? (url.searchParams.get('deviceId')?.trim() || 'default-win-agent').slice(0, 64)
                    : `web-${crypto.randomUUID().slice(0, 8)}`;

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

            const attachment: SocketAttachment = {
                role,
                deviceId,
                connectedAt: new Date().toISOString()
            };

            // Mandatory hibernation acceptance; never call server.accept().
            this.ctx.acceptWebSocket(server, [role, deviceId]);
            server.serializeAttachment(attachment);

            if (role === 'agent') {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'agent.online',
                    ts: Date.now(),
                    payload: { deviceId, connectedAt: attachment.connectedAt }
                });
            }

            return new Response(null, { status: 101, webSocket: client });
        }

        return Response.json(
            { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown hub route' } },
            { status: 404 }
        );
    }

    private pickAgentSocket(targetDeviceId?: string): WebSocket | null {
        const candidates = targetDeviceId
            ? this.ctx.getWebSockets(targetDeviceId).filter((s) => {
                  const a = s.deserializeAttachment() as SocketAttachment | null;
                  return a?.role === 'agent';
              })
            : this.ctx.getWebSockets('agent');
        return candidates[0] ?? null;
    }

    private async handleVrcHttpRpc(request: Request): Promise<Response> {
        const agentSocket = this.pickAgentSocket();
        if (!agentSocket) {
            return Response.json(
                { ok: false, error: { code: 'AGENT_OFFLINE', message: 'No Windows agent connected' } },
                { status: 503 }
            );
        }

        const payload = (await request.json()) as Record<string, unknown>;
        const reqId = crypto.randomUUID();

        const rpcPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpcs.delete(reqId);
                reject(new Error('Agent RPC timeout'));
            }, RPC_TIMEOUT_MS);
            this.pendingRpcs.set(reqId, { resolve, reject, timer });
        });

        try {
            agentSocket.send(
                JSON.stringify({
                    v: 1,
                    id: reqId,
                    type: 'rpc.request',
                    ts: Date.now(),
                    payload: { op: 'vrc_http', ...payload }
                })
            );
        } catch (err) {
            const pending = this.pendingRpcs.get(reqId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRpcs.delete(reqId);
            }
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_SEND_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to reach agent'
                    }
                },
                { status: 502 }
            );
        }

        try {
            const result = await rpcPromise;
            return Response.json({ ok: true, data: result });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_RPC_TIMEOUT',
                        message: err instanceof Error ? err.message : 'Agent RPC timed out'
                    }
                },
                { status: 504 }
            );
        }
    }

    private async handleDispatchCommand(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            cmdId: string;
            targetDeviceId?: string;
            action: string;
            params?: Record<string, unknown>;
            expiresAt?: string;
        };

        const agentSocket = this.pickAgentSocket(body.targetDeviceId);
        if (!agentSocket) {
            return Response.json(
                {
                    ok: false,
                    error: { code: 'AGENT_OFFLINE', message: 'Target Windows agent is offline' }
                },
                { status: 503 }
            );
        }

        const attachment = agentSocket.deserializeAttachment() as SocketAttachment | null;
        try {
            agentSocket.send(
                JSON.stringify({
                    v: 1,
                    id: body.cmdId,
                    type: 'cmd.dispatch',
                    ts: Date.now(),
                    payload: {
                        cmdId: body.cmdId,
                        action: body.action,
                        params: body.params ?? {},
                        expiresAt: body.expiresAt ?? ''
                    }
                })
            );
            return Response.json({
                ok: true,
                data: {
                    dispatched: true,
                    deviceId: attachment?.deviceId ?? body.targetDeviceId ?? 'default-win-agent'
                }
            });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'DISPATCH_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to dispatch command'
                    }
                },
                { status: 502 }
            );
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== 'string') {
            return;
        }
        if (message.length > MAX_MESSAGE_BYTES) {
            ws.send(JSON.stringify({ v: 1, type: 'error', payload: { code: 'PAYLOAD_TOO_LARGE' } }));
            return;
        }

        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        if (!attachment) {
            return;
        }

        let envelope: HubEnvelope;
        try {
            envelope = JSON.parse(message) as HubEnvelope;
        } catch {
            ws.send(JSON.stringify({ v: 1, type: 'error', payload: { code: 'INVALID_JSON' } }));
            return;
        }

        if (!envelope || typeof envelope.type !== 'string') {
            return;
        }

        if (attachment.role === 'agent') {
            if (envelope.type === 'agent.state' && envelope.payload) {
                const now = new Date().toISOString();
                this.ctx.storage.sql.exec(
                    `INSERT INTO live_device_state (device_id, state_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
                    attachment.deviceId,
                    JSON.stringify(envelope.payload),
                    now
                );
                this.broadcastToRole('web', {
                    v: 1,
                    id: envelope.id,
                    type: 'agent.state',
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, ...envelope.payload }
                });
                return;
            }

            if (envelope.type === 'rpc.response') {
                const reqId =
                    envelope.id || (typeof envelope.payload?.reqId === 'string' ? envelope.payload.reqId : '');
                const pending = reqId ? this.pendingRpcs.get(reqId) : undefined;
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRpcs.delete(reqId);
                    pending.resolve(envelope.payload ?? {});
                    return;
                }
                this.broadcastToRole('web', {
                    ...envelope,
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, ...(envelope.payload ?? {}) }
                });
                return;
            }

            if (envelope.type === 'cmd.result') {
                const cmdId =
                    envelope.id || (typeof envelope.payload?.cmdId === 'string' ? envelope.payload.cmdId : '');
                if (cmdId) {
                    const status = envelope.payload?.status === 'succeeded' ? 'succeeded' : 'failed';
                    const now = new Date().toISOString();
                    this.ctx.waitUntil(
                        this.env.DB_CORE.prepare(
                            'UPDATE cloud_commands SET status = ?, result_json = ?, finished_at = ? WHERE cmd_id = ?'
                        )
                            .bind(status, JSON.stringify(envelope.payload ?? {}), now, cmdId)
                            .run()
                            .catch(() => {})
                    );
                }
                this.broadcastToRole('web', {
                    ...envelope,
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, ...(envelope.payload ?? {}) }
                });
            }
            return;
        }

        // Messages from web clients routed to target or active agent
        if (envelope.type === 'cmd.dispatch' || envelope.type === 'rpc.request') {
            const targetDeviceId =
                typeof envelope.payload?.targetDeviceId === 'string' ? envelope.payload.targetDeviceId : undefined;
            const agentSocket = this.pickAgentSocket(targetDeviceId);

            if (!agentSocket) {
                ws.send(
                    JSON.stringify({
                        v: 1,
                        id: envelope.id,
                        type: 'cmd.result',
                        ts: Date.now(),
                        payload: { status: 'failed', code: 'AGENT_OFFLINE' }
                    })
                );
                return;
            }

            try {
                agentSocket.send(JSON.stringify({ ...envelope, ts: Date.now() }));
            } catch {
                // Socket cleanup handled on close/error.
            }
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        try {
            ws.close(code, reason);
        } catch {
            // Already closed.
        }
        if (attachment?.role === 'agent') {
            for (const [id, pending] of this.pendingRpcs.entries()) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Agent disconnected during RPC'));
                this.pendingRpcs.delete(id);
            }
            this.broadcastToRole('web', {
                v: 1,
                type: 'agent.offline',
                ts: Date.now(),
                payload: { deviceId: attachment.deviceId }
            });
        }
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        try {
            ws.close(1011, 'Socket error');
        } catch {
            // Ignore close errors.
        }
    }

    private getLiveStatus(): {
        agentsOnline: string[];
        webClientsCount: number;
        deviceStates: Record<string, { state: unknown; updatedAt: string }>;
    } {
        const agentSockets = this.ctx.getWebSockets('agent');
        const agentsOnline = Array.from(
            new Set(
                agentSockets
                    .map((s) => (s.deserializeAttachment() as SocketAttachment | null)?.deviceId)
                    .filter((id): id is string => Boolean(id))
            )
        );
        const webClientsCount = this.ctx.getWebSockets('web').length;

        const deviceStates: Record<string, { state: unknown; updatedAt: string }> = {};
        const cursor = this.ctx.storage.sql.exec<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>(`SELECT device_id, state_json, updated_at FROM live_device_state LIMIT 20`);

        for (const row of cursor) {
            try {
                deviceStates[row.device_id] = {
                    state: JSON.parse(row.state_json),
                    updatedAt: row.updated_at
                };
            } catch {
                // Skip malformed row.
            }
        }

        return { agentsOnline, webClientsCount, deviceStates };
    }

    private broadcastToRole(role: ClientRole, envelope: HubEnvelope): void {
        const sockets = this.ctx.getWebSockets(role);
        if (sockets.length === 0) {
            return;
        }
        const serialized = JSON.stringify(envelope);
        for (const sock of sockets) {
            try {
                sock.send(serialized);
            } catch {
                // Ignore broken sockets; lifecycle hook handles cleanup.
            }
        }
    }
}
