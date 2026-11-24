export interface Env {
    DB_CORE: D1Database;
    DB_GAMELOG: D1Database;
    DB_FEED: D1Database;
    AGENT_HUB: DurableObjectNamespace;
    R2_MEDIA?: R2Bucket;
    /** Optional bearer token for API/POC access. */
    POC_ADMIN_TOKEN?: string;
    /** Optional shared sync secret for Windows VRCX.Agent periodic HTTP uploads. */
    AGENT_SYNC_KEY?: string;
    /** Optional single-user admin passcode (plain secret or pbkdf2$<saltHex>$<hashHex>). */
    ADMIN_PASSCODE?: string;
    /** Optional Base32 RFC-6238 TOTP secret paired with ADMIN_PASSCODE. */
    ADMIN_TOTP_SECRET?: string;
    /** Optional Cloudflare Access team domain (e.g. myteam.cloudflareaccess.com). */
    CF_ACCESS_TEAM_DOMAIN?: string;
    /** Optional Cloudflare Access Application Audience (AUD) tag. */
    CF_ACCESS_AUD?: string;
    /** Optional 32+ char master secret for AES-256-GCM encryption of cookies & device HMAC keys. */
    COOKIE_MASTER_KEY?: string;
    /** Set to "false" to disallow direct Worker -> VRChat API calls when Win Agent is offline. */
    VRC_ALLOW_CLOUD_FALLBACK?: string;
}
