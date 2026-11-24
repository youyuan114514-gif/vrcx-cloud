-- DB_GAMELOG (vrcx-gamelog, 500 MB Free limit)
-- Minimal-index game log tables (gamelog_resource_load intentionally excluded from cloud D1).

CREATE TABLE IF NOT EXISTS gamelog_location (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    location TEXT NOT NULL,
    world_id TEXT NOT NULL DEFAULT '',
    world_name TEXT NOT NULL DEFAULT '',
    time INTEGER NOT NULL DEFAULT 0,
    group_name TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, location)
);
CREATE INDEX IF NOT EXISTS idx_gamelog_loc_world_id ON gamelog_location (world_id, id DESC);

CREATE TABLE IF NOT EXISTS gamelog_join_leave (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    time INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_at, type, display_name)
);
CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_id ON gamelog_join_leave (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location, id DESC);

CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    display_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    instance_id TEXT NOT NULL DEFAULT '',
    world_name TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, display_name)
);

CREATE TABLE IF NOT EXISTS gamelog_video_play (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    video_url TEXT NOT NULL,
    video_name TEXT NOT NULL DEFAULT '',
    video_id TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, video_url)
);

CREATE TABLE IF NOT EXISTS gamelog_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (created_at, data)
);

CREATE TABLE IF NOT EXISTS gamelog_external (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    message TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, message)
);
