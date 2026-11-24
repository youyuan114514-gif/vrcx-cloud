const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]!);
    }
    return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function randomHex(byteLength = 32): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

export function timingSafeEqual(a: string, b: string): boolean {
    const ab = encoder.encode(a);
    const bb = encoder.encode(b);
    if (ab.length !== bb.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < ab.length; i++) {
        diff |= ab[i]! ^ bb[i]!;
    }
    return diff === 0;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
    const data = typeof input === 'string' ? encoder.encode(input) : input;
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return bytesToHex(new Uint8Array(sig));
}

async function deriveAesKey(masterSecret: string): Promise<CryptoKey> {
    const rawHash = await crypto.subtle.digest('SHA-256', encoder.encode(masterSecret));
    return crypto.subtle.importKey('raw', rawHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAesGcm(
    masterSecret: string,
    plaintext: string
): Promise<{ ciphertextB64: string; ivB64: string }> {
    const key = await deriveAesKey(masterSecret);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
    return {
        ciphertextB64: bytesToBase64(new Uint8Array(cipherBuf)),
        ivB64: bytesToBase64(iv)
    };
}

export async function decryptAesGcm(masterSecret: string, ciphertextB64: string, ivB64: string): Promise<string> {
    const key = await deriveAesKey(masterSecret);
    const iv = base64ToBytes(ivB64);
    const cipher = base64ToBytes(ciphertextB64);
    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        cipher as BufferSource
    );
    return decoder.decode(plainBuf);
}

/**
 * Verifies either a raw secret passcode or a PBKDF2-SHA256 hash formatted as:
 * `pbkdf2$<iterations>$<saltHex>$<hashHex>`
 */
export async function verifyPasscode(configured: string, candidate: string): Promise<boolean> {
    if (!configured.startsWith('pbkdf2$')) {
        return timingSafeEqual(configured, candidate);
    }
    const parts = configured.split('$');
    if (parts.length !== 4) {
        return false;
    }
    const iterations = Number(parts[1]);
    const saltHex = parts[2] ?? '';
    const expectedHex = parts[3] ?? '';
    if (!Number.isFinite(iterations) || iterations < 10_000 || iterations > 600_000) {
        return false;
    }
    const saltBytes = new Uint8Array(saltHex.length / 2);
    for (let i = 0; i < saltBytes.length; i++) {
        saltBytes[i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
    }
    const baseKey = await crypto.subtle.importKey('raw', encoder.encode(candidate), 'PBKDF2', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes as BufferSource, iterations, hash: 'SHA-256' },
        baseKey,
        256
    );
    return timingSafeEqual(bytesToHex(new Uint8Array(derived)), expectedHex.toLowerCase());
}

function decodeBase32(input: string): Uint8Array {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx < 0) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

/** RFC 6238 SHA-1 6-digit TOTP verification (±1 step drift tolerance). */
export async function verifyTotp(base32Secret: string, code: string, nowMs = Date.now()): Promise<boolean> {
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
        return false;
    }
    const keyBytes = decodeBase32(base32Secret);
    if (keyBytes.length === 0) {
        return false;
    }
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const currentStep = Math.floor(nowMs / 30_000);
    for (const delta of [-1, 0, 1]) {
        const step = currentStep + delta;
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint32(0, Math.floor(step / 0x100000000));
        view.setUint32(4, step >>> 0);
        const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, buf));
        const offset = mac[mac.length - 1]! & 0x0f;
        const binary =
            ((mac[offset]! & 0x7f) << 24) |
            ((mac[offset + 1]! & 0xff) << 16) |
            ((mac[offset + 2]! & 0xff) << 8) |
            (mac[offset + 3]! & 0xff);
        const otp = String(binary % 1_000_000).padStart(6, '0');
        if (timingSafeEqual(otp, cleanCode)) {
            return true;
        }
    }
    return false;
}

export async function signSessionCookie(secret: string, sessionId: string, expEpochSec: number): Promise<string> {
    const payload = `${sessionId}.${expEpochSec}`;
    const sig = await hmacSha256Hex(secret, payload);
    return `${payload}.${sig}`;
}

export async function verifySessionCookie(
    secret: string,
    cookieVal: string
): Promise<{ valid: boolean; sessionId?: string }> {
    const parts = cookieVal.split('.');
    if (parts.length !== 3) {
        return { valid: false };
    }
    const [sessionId, expStr, sig] = parts as [string, string, string];
    const exp = Number(expStr);
    if (!sessionId || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
        return { valid: false };
    }
    const expected = await hmacSha256Hex(secret, `${sessionId}.${expStr}`);
    if (!timingSafeEqual(expected, sig)) {
        return { valid: false };
    }
    return { valid: true, sessionId };
}
