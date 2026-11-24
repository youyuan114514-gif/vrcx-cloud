import type { Env } from '../env';

let schemaInitialized = false;
let initPromise: Promise<void> | null = null;

// Static DDL mirrored from cloud/migrations/*/0001_init.sql.
// Uses a schema_meta version sentinel so upgrades from Phase 0 auto-add Phase 1 tables idempotently.
const SCHEMA_VERSION = 'v5-bg-feed-sync';

const CORE_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS schema_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS config_bundles (
        bundle_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stats_counters (
        counter_key TEXT PRIMARY KEY,
        row_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS entity_users (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        aliases_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_users_fts USING fts5(
        display_name,
        aliases_text,
        content='entity_users',
        content_rowid='rowid',
        tokenize='trigram'
    )`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_ai AFTER INSERT ON entity_users BEGIN
        INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
        VALUES (new.rowid, new.display_name, new.aliases_text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_ad AFTER DELETE ON entity_users BEGIN
        INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
        VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_au AFTER UPDATE ON entity_users BEGIN
        INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
        VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
        INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
        VALUES (new.rowid, new.display_name, new.aliases_text);
    END`,
    `CREATE TABLE IF NOT EXISTS entity_worlds (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        world_id TEXT NOT NULL UNIQUE,
        world_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_worlds_fts USING fts5(
        world_name,
        content='entity_worlds',
        content_rowid='rowid',
        tokenize='trigram'
    )`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_ai AFTER INSERT ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(rowid, world_name)
        VALUES (new.rowid, new.world_name);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_ad AFTER DELETE ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
        VALUES ('delete', old.rowid, old.world_name);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_au AFTER UPDATE ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
        VALUES ('delete', old.rowid, old.world_name);
        INSERT INTO entity_worlds_fts(rowid, world_name)
        VALUES (new.rowid, new.world_name);
    END`,
    `CREATE TABLE IF NOT EXISTS memos (
        user_id TEXT PRIMARY KEY,
        edited_at TEXT NOT NULL,
        memo TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS world_memos (
        world_id TEXT PRIMARY KEY,
        edited_at TEXT NOT NULL,
        memo TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS avatar_memos (
        avatar_id TEXT PRIMARY KEY,
        edited_at TEXT NOT NULL,
        memo TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS favorite_friend (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        UNIQUE (user_id, group_name)
    )`,
    `CREATE TABLE IF NOT EXISTS favorite_world (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        world_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        UNIQUE (world_id, group_name)
    )`,
    `CREATE TABLE IF NOT EXISTS favorite_avatar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        avatar_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        UNIQUE (avatar_id, group_name)
    )`,
    `CREATE TABLE IF NOT EXISTS favorite_print (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        print_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS avatar_tags (
        avatar_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        color TEXT,
        PRIMARY KEY (avatar_id, tag)
    )`,
    `CREATE TABLE IF NOT EXISTS avatar_history (
        avatar_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        time INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS friend_log_current (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        trust_level TEXT NOT NULL DEFAULT '',
        friend_number INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS friend_log_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        previous_display_name TEXT NOT NULL DEFAULT '',
        trust_level TEXT NOT NULL DEFAULT '',
        previous_trust_level TEXT NOT NULL DEFAULT '',
        friend_number INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_friend_log_history_user ON friend_log_history (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT '',
        sender_user_id TEXT NOT NULL DEFAULT '',
        sender_username TEXT NOT NULL DEFAULT '',
        receiver_user_id TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        world_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        invite_message TEXT NOT NULL DEFAULT '',
        request_message TEXT NOT NULL DEFAULT '',
        response_message TEXT NOT NULL DEFAULT '',
        expired INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS notifications_v2 (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        link TEXT NOT NULL DEFAULT '',
        link_text TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        seen INTEGER NOT NULL DEFAULT 0,
        sender_user_id TEXT NOT NULL DEFAULT '',
        sender_username TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        responses TEXT NOT NULL DEFAULT '[]',
        details TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_v2_created ON notifications_v2 (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS moderation (
        user_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        block INTEGER NOT NULL DEFAULT 0,
        mute INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS user_profile (
        user_id TEXT PRIMARY KEY,
        bio TEXT NOT NULL DEFAULT '',
        bio_links TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_pairing_codes (
        code TEXT PRIMARY KEY,
        device_label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        hmac_secret_enc TEXT NOT NULL,
        agent_version TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_seen_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_device_states (
        device_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_sync_cursors (
        device_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_event_dt TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (device_id, stream_name)
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_screenshots (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        taken_at TEXT NOT NULL,
        local_filename TEXT NOT NULL,
        world_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        instance_id TEXT NOT NULL DEFAULT '',
        players_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        r2_thumb_key TEXT NOT NULL DEFAULT '',
        thumb_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_screenshots_taken ON cloud_screenshots (taken_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_screenshots_world ON cloud_screenshots (world_id, taken_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_screenshots_filename ON cloud_screenshots (local_filename COLLATE NOCASE)`,
    `CREATE TABLE IF NOT EXISTS cloud_commands (
        cmd_id TEXT PRIMARY KEY,
        target_device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_commands_created ON cloud_commands (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS cloud_cookie_vault (
        account_key TEXT PRIMARY KEY,
        ciphertext_b64 TEXT NOT NULL,
        iv_b64 TEXT NOT NULL,
        source_device_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_bg_sync_state (
        state_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
    )`
];

const GAMELOG_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS gamelog_location (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        location TEXT NOT NULL,
        world_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, location)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_loc_world_id ON gamelog_location (world_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS gamelog_join_leave (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        UNIQUE (created_at, type, display_name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_id ON gamelog_join_leave (user_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location, id DESC)`,
    `CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        instance_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, display_name)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_video_play (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        video_url TEXT NOT NULL,
        video_name TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, video_url)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (created_at, data)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_external (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        message TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, message)
    )`
];

const FEED_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS feed_gps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        previous_location TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, location)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_gps_user_id ON feed_gps (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_online_offline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_oo_user_id ON feed_online_offline (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        status_description TEXT NOT NULL DEFAULT '',
        previous_status TEXT NOT NULL DEFAULT '',
        previous_status_description TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, status, status_description)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_status_user_id ON feed_status (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_bio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        previous_bio TEXT NOT NULL DEFAULT '',
        bio_links TEXT NOT NULL DEFAULT '[]',
        previous_bio_links TEXT NOT NULL DEFAULT '[]',
        UNIQUE (created_at, user_id, bio)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_bio_user_id ON feed_bio (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS activity_sessions_v2 (
        session_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        is_open_tail INTEGER NOT NULL DEFAULT 0,
        source_revision TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_sessions_user_start ON activity_sessions_v2 (user_id, start_at DESC)`
];

async function initCoreIfNeeded(db: D1Database): Promise<void> {
    try {
        const meta = await db
            .prepare("SELECT meta_value FROM schema_meta WHERE meta_key = 'version' LIMIT 1")
            .first<{ meta_value: string }>();
        if (meta?.meta_value === SCHEMA_VERSION) {
            return;
        }
    } catch {
        // schema_meta does not exist yet
    }

    // Chunk under 25 statements per batch to stay well inside Free-tier D1 limits.
    for (let i = 0; i < CORE_STATEMENTS.length; i += 20) {
        await db.batch(CORE_STATEMENTS.slice(i, i + 20).map((sql) => db.prepare(sql)));
    }
    await db
        .prepare("INSERT OR REPLACE INTO schema_meta (meta_key, meta_value) VALUES ('version', ?)")
        .bind(SCHEMA_VERSION)
        .run();
}

async function initShardIfNeeded(db: D1Database, markerTable: string, statements: readonly string[]): Promise<void> {
    const existing = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .bind(markerTable)
        .first<{ name: string }>();

    if (existing?.name === markerTable) {
        return;
    }

    await db.batch(statements.map((sql) => db.prepare(sql)));
}

/**
 * Ensures all 3 sharded D1 databases have their latest schema applied idempotently.
 */
export async function ensureSchemaReady(env: Env): Promise<void> {
    if (schemaInitialized) {
        return;
    }
    if (!initPromise) {
        initPromise = Promise.all([
            initCoreIfNeeded(env.DB_CORE),
            initShardIfNeeded(env.DB_GAMELOG, 'gamelog_external', GAMELOG_STATEMENTS),
            initShardIfNeeded(env.DB_FEED, 'activity_sessions_v2', FEED_STATEMENTS)
        ])
            .then(() => {
                schemaInitialized = true;
            })
            .catch((err) => {
                initPromise = null;
                throw err;
            });
    }
    await initPromise;
}

export function resetSchemaBootstrapCacheForTest(): void {
    schemaInitialized = false;
    initPromise = null;
}
