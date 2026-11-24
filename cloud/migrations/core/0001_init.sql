-- DB_CORE (vrcx-core, 500 MB Free limit)
-- Permanent low-churn personal assets, deduplicated entity search dictionaries, and cloud control tables.

CREATE TABLE IF NOT EXISTS config_bundles (
    bundle_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_counters (
    counter_key TEXT PRIMARY KEY,
    row_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

-- Deduplicated user entity dictionary + external-content FTS5 trigram index
CREATE TABLE IF NOT EXISTS entity_users (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    aliases_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_users_fts USING fts5(
    display_name,
    aliases_text,
    content='entity_users',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entity_users_ai AFTER INSERT ON entity_users BEGIN
    INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
    VALUES (new.rowid, new.display_name, new.aliases_text);
END;

CREATE TRIGGER IF NOT EXISTS entity_users_ad AFTER DELETE ON entity_users BEGIN
    INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
    VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
END;

CREATE TRIGGER IF NOT EXISTS entity_users_au AFTER UPDATE ON entity_users BEGIN
    INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
    VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
    INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
    VALUES (new.rowid, new.display_name, new.aliases_text);
END;

-- Deduplicated world entity dictionary + external-content FTS5 trigram index
CREATE TABLE IF NOT EXISTS entity_worlds (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL UNIQUE,
    world_name TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_worlds_fts USING fts5(
    world_name,
    content='entity_worlds',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entity_worlds_ai AFTER INSERT ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(rowid, world_name)
    VALUES (new.rowid, new.world_name);
END;

CREATE TRIGGER IF NOT EXISTS entity_worlds_ad AFTER DELETE ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
    VALUES ('delete', old.rowid, old.world_name);
END;

CREATE TRIGGER IF NOT EXISTS entity_worlds_au AFTER UPDATE ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
    VALUES ('delete', old.rowid, old.world_name);
    INSERT INTO entity_worlds_fts(rowid, world_name)
    VALUES (new.rowid, new.world_name);
END;

-- VRCX permanent user asset tables
CREATE TABLE IF NOT EXISTS memos (
    user_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_memos (
    world_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS avatar_memos (
    avatar_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_friend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (user_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_world (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    world_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (world_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_avatar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    avatar_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (avatar_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_print (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS avatar_tags (
    avatar_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (avatar_id, tag)
);

CREATE TABLE IF NOT EXISTS avatar_history (
    avatar_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    time INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS friend_log_current (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    trust_level TEXT NOT NULL DEFAULT '',
    friend_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS friend_log_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    previous_display_name TEXT NOT NULL DEFAULT '',
    trust_level TEXT NOT NULL DEFAULT '',
    previous_trust_level TEXT NOT NULL DEFAULT '',
    friend_number INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_friend_log_history_user ON friend_log_history (user_id, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
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
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS notifications_v2 (
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
);
CREATE INDEX IF NOT EXISTS idx_notifications_v2_created ON notifications_v2 (created_at DESC);

CREATE TABLE IF NOT EXISTS moderation (
    user_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    block INTEGER NOT NULL DEFAULT 0,
    mute INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_profile (
    user_id TEXT PRIMARY KEY,
    bio TEXT NOT NULL DEFAULT '',
    bio_links TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

-- Cloud companion control & media index tables
CREATE TABLE IF NOT EXISTS cloud_pairing_codes (
    code TEXT PRIMARY KEY,
    device_label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cloud_devices (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    hmac_secret_enc TEXT NOT NULL,
    agent_version TEXT NOT NULL DEFAULT '',
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    last_seen_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_sync_cursors (
    device_id TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    byte_offset INTEGER NOT NULL DEFAULT 0,
    last_event_dt TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, stream_name)
);

CREATE TABLE IF NOT EXISTS cloud_screenshots (
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
);
CREATE INDEX IF NOT EXISTS idx_screenshots_taken ON cloud_screenshots (taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_world ON cloud_screenshots (world_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS cloud_commands (
    cmd_id TEXT PRIMARY KEY,
    target_device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_commands_created ON cloud_commands (created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_cookie_vault (
    account_key TEXT PRIMARY KEY,
    ciphertext_b64 TEXT NOT NULL,
    iv_b64 TEXT NOT NULL,
    source_device_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
