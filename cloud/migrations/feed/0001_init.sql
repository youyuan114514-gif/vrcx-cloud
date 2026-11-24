-- DB_FEED (vrcx-feed, 500 MB Free limit)
-- Minimal-index social feed tables (feed_avatar excluded by default to avoid unbounded storage bloat).

CREATE TABLE IF NOT EXISTS feed_gps (
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
);
CREATE INDEX IF NOT EXISTS idx_feed_gps_user_id ON feed_gps (user_id, id DESC);

CREATE TABLE IF NOT EXISTS feed_online_offline (
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
);
CREATE INDEX IF NOT EXISTS idx_feed_oo_user_id ON feed_online_offline (user_id, id DESC);

CREATE TABLE IF NOT EXISTS feed_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    status_description TEXT NOT NULL DEFAULT '',
    previous_status TEXT NOT NULL DEFAULT '',
    previous_status_description TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, user_id, status, status_description)
);
CREATE INDEX IF NOT EXISTS idx_feed_status_user_id ON feed_status (user_id, id DESC);

CREATE TABLE IF NOT EXISTS feed_bio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    previous_bio TEXT NOT NULL DEFAULT '',
    bio_links TEXT NOT NULL DEFAULT '[]',
    previous_bio_links TEXT NOT NULL DEFAULT '[]',
    UNIQUE (created_at, user_id, bio)
);
CREATE INDEX IF NOT EXISTS idx_feed_bio_user_id ON feed_bio (user_id, id DESC);

CREATE TABLE IF NOT EXISTS activity_sessions_v2 (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    is_open_tail INTEGER NOT NULL DEFAULT 0,
    source_revision TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_activity_sessions_user_start ON activity_sessions_v2 (user_id, start_at DESC);
