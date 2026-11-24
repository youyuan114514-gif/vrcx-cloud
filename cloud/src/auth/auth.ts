import {
    decryptAesGcm,
    hmacSha256Hex,
    randomHex,
    sha256Hex,
    signSessionCookie,
    timingSafeEqual,
    verifyPasscode,
    verifySessionCookie,
    verifyTotp
} from '../crypto/vault';
import type { Env } from '../env';

const SESSION_COOKIE_NAME = 'vrcx_cloud_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const AGENT_REPLAY_WINDOW_SEC = 60;

export type AuthMode = 'cloudflare_access' | 'passcode_session' | 'bearer_token' | 'open_setup';

export interface WebAuthResult {
    authenticated: boolean;
    authMode: AuthMode;
    requiresTotp: boolean;
    subject: string;
}

export interface AgentAuthResult {
    authenticated: boolean;
    deviceId?: string;
    deviceName?: string;
    reason?: string;
}

export function getMasterKey(env: Env): string {
    // Derive a deterministic signing/encryption key from configured secrets.
    // Production deployments should always configure COOKIE_MASTER_KEY via `wrangler secret put`.
    return (
        env.COOKIE_MASTER_KEY?.trim() ||
        env.ADMIN_PASSCODE?.trim() ||
        env.POC_ADMIN_TOKEN?.trim() ||
        'vrcx-cloud-dev-fallback-key-change-in-prod'
    );
}

export function detectAuthMode(env: Env): AuthMode {
    if (env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()) {
        return 'cloudflare_access';
    }
    if (env.ADMIN_PASSCODE?.trim()) {
        return 'passcode_session';
    }
    if (env.POC_ADMIN_TOKEN?.trim()) {
        return 'bearer_token';
    }
    return 'open_setup';
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) {
        return out;
    }
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        out[k] = decodeURIComponent(v);
    }
    return out;
}

function base64UrlDecode(str: string): Uint8Array {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

let cachedAccessJwks: { domain: string; fetchedAt: number; keys: JsonWebKey[] } | null = null;

async function verifyCloudflareAccessJwt(jwt: string, teamDomain: string, expectedAud: string): Promise<string | null> {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!))) as { kid?: string; alg?: string };
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as {
            aud?: string | string[];
            exp?: number;
            email?: string;
            sub?: string;
        };

        const audList = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
        if (!audList.includes(expectedAud)) return null;
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;

        const now = Date.now();
        if (!cachedAccessJwks || cachedAccessJwks.domain !== teamDomain || now - cachedAccessJwks.fetchedAt > 3_600_000) {
            const certsUrl = `https://${teamDomain.replace(/^https?:\/\//, '')}/cdn-cgi/access/certs`;
            const res = await fetch(certsUrl);
            if (!res.ok) return null;
            const json = (await res.json()) as { keys?: JsonWebKey[] };
            cachedAccessJwks = { domain: teamDomain, fetchedAt: now, keys: json.keys ?? [] };
        }

        const jwk = cachedAccessJwks.keys.find((k) => (k as { kid?: string }).kid === header.kid);
        if (!jwk) return null;

        const cryptoKey = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const signature = base64UrlDecode(parts[2]!);
        const valid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            cryptoKey,
            signature as BufferSource,
            signedData as BufferSource
        );
        return valid ? payload.email || payload.sub || 'access-user' : null;
    } catch {
        return null;
    }
}

export async function authenticateWeb(request: Request, env: Env): Promise<WebAuthResult> {
    const authMode = detectAuthMode(env);
    const requiresTotp = Boolean(env.ADMIN_TOTP_SECRET?.trim());

    // Optional bearer override when POC_ADMIN_TOKEN is also configured
    const bearer = env.POC_ADMIN_TOKEN?.trim();
    if (bearer) {
        const authHeader = request.headers.get('Authorization') ?? '';
        if (authHeader.startsWith('Bearer ') && timingSafeEqual(authHeader.slice(7).trim(), bearer)) {
            return { authenticated: true, authMode, requiresTotp, subject: 'bearer-admin' };
        }
    }

    if (authMode === 'open_setup') {
        return { authenticated: true, authMode, requiresTotp: false, subject: 'owner' };
    }

    if (authMode === 'cloudflare_access') {
        const jwt =
            request.headers.get('Cf-Access-Jwt-Assertion') ||
            parseCookies(request.headers.get('Cookie'))['CF_Authorization'] ||
            '';
        if (!jwt) {
            return { authenticated: false, authMode, requiresTotp: false, subject: '' };
        }
        const subject = await verifyCloudflareAccessJwt(
            jwt,
            env.CF_ACCESS_TEAM_DOMAIN!.trim(),
            env.CF_ACCESS_AUD!.trim()
        );
        return { authenticated: Boolean(subject), authMode, requiresTotp: false, subject: subject ?? '' };
    }

    if (authMode === 'passcode_session') {
        const cookies = parseCookies(request.headers.get('Cookie'));
        const token = cookies[SESSION_COOKIE_NAME];
        if (!token) {
            return { authenticated: false, authMode, requiresTotp, subject: '' };
        }
        const verified = await verifySessionCookie(getMasterKey(env), token);
        return {
            authenticated: verified.valid,
            authMode,
            requiresTotp,
            subject: verified.valid ? 'owner' : ''
        };
    }

    return { authenticated: false, authMode, requiresTotp, subject: '' };
}

/**
 * Verifies Windows VRCX.Agent requests using per-device Bearer token (SHA-256 hash stored in D1)
 * plus optional HMAC-SHA256 request signature with ±60s replay protection.
 */
export async function authenticateAgent(
    request: Request,
    env: Env,
    rawBodyText = ''
): Promise<AgentAuthResult> {
    const authHeader = request.headers.get('Authorization') ?? '';
    const syncKeyHeader = request.headers.get('X-Sync-Key')?.trim() ?? '';
    const deviceIdHeader = request.headers.get('X-Device-Id')?.trim();
    const url = new URL(request.url);
    const tokenFromQuery = url.pathname.startsWith('/ws/') ? url.searchParams.get('token')?.trim() : undefined;

    const rawToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : syncKeyHeader || tokenFromQuery || '';

    // Allow open_setup / POC token fallback when no paired devices or AGENT_SYNC_KEY exist yet
    if (!rawToken) {
        if (detectAuthMode(env) === 'open_setup' && !env.AGENT_SYNC_KEY?.trim()) {
            return {
                authenticated: true,
                deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'default-win-agent',
                deviceName: 'Windows Sync Agent'
            };
        }
        return { authenticated: false, reason: 'Missing agent sync key' };
    }

    if (env.AGENT_SYNC_KEY?.trim() && timingSafeEqual(rawToken, env.AGENT_SYNC_KEY.trim())) {
        return {
            authenticated: true,
            deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'win-sync-agent',
            deviceName: request.headers.get('X-Device-Name')?.trim() || 'Windows PC'
        };
    }

    if (env.POC_ADMIN_TOKEN?.trim() && timingSafeEqual(rawToken, env.POC_ADMIN_TOKEN.trim())) {
        return {
            authenticated: true,
            deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'default-win-agent',
            deviceName: 'Admin Token Agent'
        };
    }

    const tokenHash = await sha256Hex(rawToken);
    const device = await env.DB_CORE.prepare(
        'SELECT device_id, device_name, token_hash, hmac_secret_enc FROM cloud_devices WHERE token_hash = ? LIMIT 1'
    )
        .bind(tokenHash)
        .first<{ device_id: string; device_name: string; token_hash: string; hmac_secret_enc: string }>();

    if (!device) {
        return { authenticated: false, reason: 'Unknown device token' };
    }

    // Verify HMAC signature when present (legacy paired devices sending X-Signature / X-Timestamp)
    const sigHeader = request.headers.get('X-Signature')?.trim();
    const tsHeader = request.headers.get('X-Timestamp')?.trim();
    if (sigHeader || tsHeader) {
        if (deviceIdHeader && deviceIdHeader !== device.device_id) {
            return { authenticated: false, reason: 'Device ID mismatch' };
        }
        const tsNum = Number(tsHeader);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > AGENT_REPLAY_WINDOW_SEC) {
            return { authenticated: false, reason: 'Timestamp outside replay window' };
        }
        const [ivB64, cipherB64] = device.hmac_secret_enc.split(':');
        if (!ivB64 || !cipherB64) {
            return { authenticated: false, reason: 'Corrupted device HMAC key' };
        }
        const hmacSecret = await decryptAesGcm(getMasterKey(env), cipherB64, ivB64);
        const bodyHash = await sha256Hex(rawBodyText);
        const canonical = `${tsHeader}\n${request.method.toUpperCase()}\n${url.pathname}\n${bodyHash}`;
        const expectedSig = await hmacSha256Hex(hmacSecret, canonical);
        if (!sigHeader || !timingSafeEqual(expectedSig, sigHeader.toLowerCase())) {
            return { authenticated: false, reason: 'Invalid HMAC signature' };
        }
    }

    return {
        authenticated: true,
        deviceId: device.device_id,
        deviceName: device.device_name
    };
}

export async function handleAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const result = await authenticateWeb(request, env);
        return Response.json({
            ok: true,
            data: {
                authenticated: result.authenticated,
                authMode: result.authMode,
                requiresTotp: result.requiresTotp,
                subject: result.subject,
                r2Enabled: Boolean(env.R2_MEDIA),
                cloudFallbackAllowed: env.VRC_ALLOW_CLOUD_FALLBACK !== 'false'
            }
        });
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        const configured = env.ADMIN_PASSCODE?.trim();
        if (!configured) {
            return Response.json({
                ok: true,
                data: { authenticated: true, authMode: detectAuthMode(env) }
            });
        }

        let body: { passcode?: string; totp?: string };
        try {
            body = (await request.json()) as { passcode?: string; totp?: string };
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const passcodeOk = typeof body.passcode === 'string' && (await verifyPasscode(configured, body.passcode));
        if (!passcodeOk) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid passcode' } },
                { status: 401 }
            );
        }

        const totpSecret = env.ADMIN_TOTP_SECRET?.trim();
        if (totpSecret) {
            const totpOk = typeof body.totp === 'string' && (await verifyTotp(totpSecret, body.totp));
            if (!totpOk) {
                return Response.json(
                    { ok: false, error: { code: 'INVALID_TOTP', message: 'Valid 6-digit TOTP code required' } },
                    { status: 401 }
                );
            }
        }

        const sessionId = randomHex(16);
        const expSec = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
        const signed = await signSessionCookie(getMasterKey(env), sessionId, expSec);
        const isSecure = url.protocol === 'https:';
        const cookieFlags = [
            `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
            'Path=/',
            `Max-Age=${SESSION_TTL_SECONDS}`,
            'HttpOnly',
            'SameSite=Strict',
            ...(isSecure ? ['Secure'] : [])
        ].join('; ');

        return Response.json(
            { ok: true, data: { authenticated: true, authMode: 'passcode_session' } },
            { headers: { 'Set-Cookie': cookieFlags } }
        );
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        const isSecure = url.protocol === 'https:';
        const clearCookie = [
            `${SESSION_COOKIE_NAME}=`,
            'Path=/',
            'Max-Age=0',
            'HttpOnly',
            'SameSite=Strict',
            ...(isSecure ? ['Secure'] : [])
        ].join('; ');
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
    }

    return null;
}
