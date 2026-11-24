import { getMasterKey } from '../auth/auth';
import { decryptAesGcm, encryptAesGcm } from '../crypto/vault';
import type { Env } from '../env';

export const VRC_USER_AGENT = 'VRCX-Cloud/2026.11 (personal-self-hosted-vrcx)';

// Strict SSRF allowlist: only VRChat API/CDN/presigned upload hosts and known status/translation services VRCX calls.
const ALLOWED_HOST_SUFFIXES = [
    'api.vrchat.cloud',
    'vrchat.com',
    'files.vrchat.cloud',
    'assets.vrchat.com',
    'd348imysud55la.cloudfront.net',
    'status.vrchat.com',
    's3.amazonaws.com',
    's3.us-east-1.amazonaws.com',
    'r2.cloudflarestorage.com',
    'api.github.com'
];

interface WebApiExecutePayload {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    uploadImage?: boolean;
    uploadImageLegacy?: boolean;
    uploadFilePUT?: boolean;
    uploadPrintImage?: boolean;
    postData?: string;
    imageData?: string;
    fileData?: string;
    fileMIME?: string;
    fileMD5?: string;
    preferCloudDirect?: boolean;
}

function isAllowedTargetUrl(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function base64ToUint8Array(b64: string): Uint8Array {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export async function loadCookieJar(env: Env, accountKey = 'default'): Promise<Record<string, string>> {
    const row = await env.DB_CORE.prepare(
        'SELECT ciphertext_b64, iv_b64 FROM cloud_cookie_vault WHERE account_key = ? LIMIT 1'
    )
        .bind(accountKey)
        .first<{ ciphertext_b64: string; iv_b64: string }>();

    if (!row) {
        return {};
    }
    try {
        const plain = await decryptAesGcm(getMasterKey(env), row.ciphertext_b64, row.iv_b64);
        const parsed = JSON.parse(plain) as Record<string, unknown>;
        const jar: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') {
                jar[k] = v;
            }
        }
        return jar;
    } catch {
        return {};
    }
}

export async function saveCookieJar(env: Env, jar: Record<string, string>, accountKey = 'default'): Promise<void> {
    const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), JSON.stringify(jar));
    const now = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_cookie_vault (account_key, ciphertext_b64, iv_b64, source_device_id, updated_at)
         VALUES (?, ?, ?, 'cloud-worker', ?)
         ON CONFLICT(account_key) DO UPDATE SET
            ciphertext_b64 = excluded.ciphertext_b64,
            iv_b64 = excluded.iv_b64,
            updated_at = excluded.updated_at`
    )
        .bind(accountKey, ciphertextB64, ivB64, now)
        .run();
}

export function mergeSetCookies(jar: Record<string, string>, headers: Headers): boolean {
    let changed = false;
    const rawList: string[] = [];
    const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headersWithGetSetCookie.getSetCookie === 'function') {
        rawList.push(...headersWithGetSetCookie.getSetCookie());
    } else {
        const single = headers.get('set-cookie');
        if (single) {
            rawList.push(single);
        }
    }

    for (const raw of rawList) {
        const firstPart = raw.split(';')[0]?.trim();
        if (!firstPart) continue;
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        if (!val || /max-age=0/i.test(raw)) {
            if (name in jar) {
                delete jar[name];
                changed = true;
            }
        } else if (jar[name] !== val) {
            jar[name] = val;
            changed = true;
        }
    }
    return changed;
}

export function buildCookieHeader(jar: Record<string, string>): string {
    return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

function buildUpstreamRequestInit(payload: WebApiExecutePayload, cookieHeader: string): RequestInit {
    const method = (payload.method || 'GET').toUpperCase();
    const headers = new Headers();
    headers.set('User-Agent', VRC_USER_AGENT);

    if (payload.headers) {
        for (const [k, v] of Object.entries(payload.headers)) {
            if (k.toLowerCase() === 'host' || k.toLowerCase() === 'cookie') continue;
            headers.set(k, v);
        }
    }

    const parsedUrl = new URL(payload.url);
    const isVrchatDomain = parsedUrl.hostname.endsWith('vrchat.cloud') || parsedUrl.hostname.endsWith('vrchat.com');
    if (isVrchatDomain && cookieHeader) {
        headers.set('Cookie', cookieHeader);
    }

    if (payload.uploadFilePUT && payload.fileData) {
        const bytes = base64ToUint8Array(payload.fileData);
        if (payload.fileMIME) headers.set('Content-Type', payload.fileMIME);
        if (payload.fileMD5) headers.set('Content-MD5', payload.fileMD5);
        return { method: 'PUT', headers, body: bytes as BodyInit };
    }

    if ((payload.uploadImage || payload.uploadImageLegacy || payload.uploadPrintImage) && payload.imageData) {
        const form = new FormData();
        if (payload.postData) {
            if (payload.uploadImageLegacy) {
                form.append('data', payload.postData);
            } else {
                try {
                    const obj = JSON.parse(payload.postData) as Record<string, unknown>;
                    for (const [k, v] of Object.entries(obj)) {
                        form.append(k, v == null ? '' : String(v));
                    }
                } catch {
                    form.append('data', payload.postData);
                }
            }
        }
        const imgBytes = base64ToUint8Array(payload.imageData);
        const blob = new Blob([imgBytes.buffer as ArrayBuffer], { type: 'image/png' });
        if (payload.uploadImageLegacy) {
            form.append('image', blob, 'image.png');
        } else if (payload.uploadPrintImage) {
            form.append('image', blob, 'print.png');
        } else {
            form.append('file', blob, 'blob');
        }
        headers.delete('Content-Type');
        return { method: 'POST', headers, body: form };
    }

    if (method !== 'GET' && method !== 'HEAD' && payload.body !== undefined) {
        return { method, headers, body: payload.body };
    }

    return { method, headers };
}

export async function handleVrcProxyRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/vrc/cookies') {
        if (request.method === 'GET') {
            const jar = await loadCookieJar(env);
            const encoded = btoa(JSON.stringify(jar));
            return Response.json({ ok: true, data: { cookies: encoded, count: Object.keys(jar).length } });
        }
        if (request.method === 'PUT') {
            const body = (await request.json()) as { cookies?: string };
            if (!body.cookies) {
                await saveCookieJar(env, {});
                return Response.json({ ok: true });
            }
            try {
                const decoded = JSON.parse(atob(body.cookies)) as Record<string, unknown>;
                const jar: Record<string, string> = {};
                for (const [k, v] of Object.entries(decoded)) {
                    if (typeof v === 'string') jar[k] = v;
                }
                await saveCookieJar(env, jar);
                return Response.json({ ok: true });
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_COOKIES', message: 'Invalid encoded cookie payload' } },
                    { status: 400 }
                );
            }
        }
        if (request.method === 'DELETE') {
            await env.DB_CORE.prepare('DELETE FROM cloud_cookie_vault WHERE account_key = ?').bind('default').run();
            return Response.json({ ok: true });
        }
    }

    // Same-origin WebSocket passthrough to VRChat Pipeline using Worker egress IP + encrypted auth cookie.
    // Prevents VRChat's strict session-IP binding error ("authToken doesn't correspond with an active session")
    // caused by browser direct-connecting from a different IP than /api/vrc/execute.
    if (url.pathname === '/api/vrc/pipeline' && request.method === 'GET') {
        if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
            return Response.json(
                { ok: false, error: { code: 'UPGRADE_REQUIRED', message: 'Expected WebSocket upgrade' } },
                { status: 426 }
            );
        }
        const jar = await loadCookieJar(env);
        const authToken = jar.auth?.trim();
        if (!authToken) {
            return Response.json(
                { ok: false, error: { code: 'NO_VRC_SESSION', message: 'No active VRChat session cookie' } },
                { status: 401 }
            );
        }

        const upstreamUrl = `https://pipeline.vrchat.cloud/?authToken=${encodeURIComponent(authToken)}`;
        const upstreamHeaders = new Headers();
        upstreamHeaders.set('Upgrade', 'websocket');
        upstreamHeaders.set('User-Agent', VRC_USER_AGENT);
        const cookieHeader = buildCookieHeader(jar);
        if (cookieHeader) {
            upstreamHeaders.set('Cookie', cookieHeader);
        }
        return fetch(upstreamUrl, {
            method: 'GET',
            headers: upstreamHeaders
        });
    }

    if (url.pathname === '/api/vrc/execute' && request.method === 'POST') {
        let payload: WebApiExecutePayload;
        try {
            payload = (await request.json()) as WebApiExecutePayload;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                { status: 400 }
            );
        }

        if (!payload?.url || !isAllowedTargetUrl(payload.url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_TARGET', message: 'Target URL is not in VRChat allowlist' } },
                { status: 403 }
            );
        }

        // Strategy 1: Prefer online Windows VRCX.Agent residential-IP relay
        if (!payload.preferCloudDirect) {
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            const rpcRes = await hub.fetch(
                new Request('https://agent-hub.internal/rpc/vrc-http', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
            );
            if (rpcRes.ok) {
                const rpcJson = (await rpcRes.json()) as {
                    ok: boolean;
                    data?: { status?: number; data?: string; error?: string };
                };
                if (rpcJson.ok && rpcJson.data) {
                    if (rpcJson.data.error) {
                        return Response.json(
                            { ok: false, error: { code: 'AGENT_HTTP_ERROR', message: rpcJson.data.error } },
                            { status: 502 }
                        );
                    }
                    return Response.json({
                        ok: true,
                        data: {
                            status: rpcJson.data.status ?? 200,
                            data: rpcJson.data.data ?? '',
                            route: 'agent_residential_ip'
                        }
                    });
                }
            }
        }

        // Strategy 2: Cloud direct fallback (enabled unless explicitly disabled via VRC_ALLOW_CLOUD_FALLBACK=false)
        if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_OFFLINE_READONLY',
                        message: 'Windows companion agent is offline and cloud fallback is disabled'
                    }
                },
                { status: 503 }
            );
        }

        const isPublicUnauthTarget =
            payload.url.startsWith('https://status.vrchat.com/') ||
            payload.url === 'https://api.vrchat.cloud/api/1/config';
        const jar = isPublicUnauthTarget ? {} : await loadCookieJar(env);
        const init = buildUpstreamRequestInit(payload, isPublicUnauthTarget ? '' : buildCookieHeader(jar));

        try {
            const upstream = await fetch(payload.url, init);
            if (!isPublicUnauthTarget) {
                const cookieChanged = mergeSetCookies(jar, upstream.headers);
                if (cookieChanged) {
                    await saveCookieJar(env, jar);
                }
            }
            const text = await upstream.text();
            const wafBlocked =
                upstream.status === 403 && (upstream.headers.has('cf-mitigated') || text.includes('Just a moment'));

            return Response.json({
                ok: true,
                data: {
                    status: upstream.status,
                    data: text,
                    route: 'cloud_direct',
                    wafBlocked
                }
            });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'UPSTREAM_FETCH_ERROR',
                        message: err instanceof Error ? err.message : 'Failed to contact VRChat API'
                    }
                },
                { status: 502 }
            );
        }
    }

    // Batched read-only VRChat GET proxy: executes up to 12 concurrent GETs in a single Worker invocation
    // with only 1 D1 cookie vault read, dramatically reducing Cloudflare Workers Free-tier request usage.
    if (url.pathname === '/api/vrc/execute-batch' && request.method === 'POST') {
        if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_OFFLINE_READONLY',
                        message: 'Windows companion agent is offline and cloud fallback is disabled'
                    }
                },
                { status: 503 }
            );
        }

        let body: { requests?: WebApiExecutePayload[] };
        try {
            body = (await request.json()) as { requests?: WebApiExecutePayload[] };
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                { status: 400 }
            );
        }

        const items = Array.isArray(body?.requests) ? body.requests.slice(0, 12) : [];
        if (items.length === 0) {
            return Response.json({ ok: true, data: { results: [], route: 'cloud_direct' } });
        }

        const needsAuthCookie = items.some((item) => {
            const u = typeof item?.url === 'string' ? item.url : '';
            return (
                Boolean(u) &&
                !u.startsWith('https://status.vrchat.com/') &&
                u !== 'https://api.vrchat.cloud/api/1/config'
            );
        });
        const jar = needsAuthCookie ? await loadCookieJar(env) : {};
        const cookieHeader = needsAuthCookie ? buildCookieHeader(jar) : '';
        let cookieChanged = false;

        const results = await Promise.all(
            items.map(async (item) => {
                const method = (item?.method || 'GET').toUpperCase();
                if (method !== 'GET' || !item?.url || !isAllowedTargetUrl(item.url)) {
                    return {
                        status: 403,
                        data: '',
                        error: 'Batch only allows read-only GET requests on VRChat allowlist'
                    };
                }
                const isPublicTarget =
                    item.url.startsWith('https://status.vrchat.com/') ||
                    item.url === 'https://api.vrchat.cloud/api/1/config';
                const init = buildUpstreamRequestInit({ ...item, method: 'GET' }, isPublicTarget ? '' : cookieHeader);
                try {
                    const upstream = await fetch(item.url, init);
                    if (!isPublicTarget && mergeSetCookies(jar, upstream.headers)) {
                        cookieChanged = true;
                    }
                    const text = await upstream.text();
                    return {
                        status: upstream.status,
                        data: text
                    };
                } catch (err) {
                    return {
                        status: -1,
                        data: '',
                        error: err instanceof Error ? err.message : 'Failed to contact VRChat API'
                    };
                }
            })
        );

        if (cookieChanged) {
            await saveCookieJar(env, jar);
        }

        return Response.json({
            ok: true,
            data: {
                results,
                route: 'cloud_direct'
            }
        });
    }

    return null;
}
