# VRCX Cloud Hosting Technical Specification (v3.0)

- **Repository**: `https://github.com/nuomew/VRCX-Worker` (secondary development derived from `vrcx-team/VRCX`, baseline `2026.11.14`)
- **Scope**: Personal single-user cloud deployment on Cloudflare Free Tier (Pages + Workers + Sharded D1 + SQLite Durable Objects + optional R2) paired with a lightweight Windows companion tray agent (`VRCX.Agent`).
- **Non-Negotiables**:
  1. **100% Stateless Browser**: No primary data stored in OPFS/IndexedDB; clearing browser cache or using incognito mode preserves all data and loads cleanly from cloud.
  2. **Zero Desktop Regression**: Existing Windows CEF and Electron builds remain untouched in runtime behavior.
  3. **Cloudflare Free-Tier Safe**: Stay well below daily/storage free ceilings via multi-D1 sharding, entity-dictionary FTS5 (`trigram`), counter tables, bundled configs, and DO WebSocket Hibernation.

---

## 1. Cloudflare Free Tier Constraints (Verified Nov 2026)

| Service | Free Limit | Engineering Enforcement |
| :--- | :--- | :--- |
| **Pages** | Unlimited static bandwidth/requests | Hosts Vue SPA built with `--mode web` |
| **Workers** | 100,000 req/day; 10 ms CPU/req | Zero server-side image transcoding or log parsing; stream passthrough only |
| **D1** | **500 MB/DB** (max 10 DBs = 5 GB total); 5M rows read/day; 100K rows written/day; max 50 queries/invocation | Shard into `DB_CORE`, `DB_GAMELOG`, `DB_FEED` (+ up to 7 annual archives); Entity FTS5 + B-tree indexes; `stats_counters`; `db.batch()` |
| **Durable Objects (SQLite)** | 100,000 req/day; 13,000 GB-s/day; 5 GB total (1 GB/DO) | Mandatory WebSocket Hibernation (`ctx.acceptWebSocket` + `setWebSocketAutoResponse("ping","pong")`); never call `ws.accept()` |
| **R2 (Optional)** | 10 GB/mo; 1M Class A / 10M Class B; 0 egress | Private bucket for WebP thumbnails (<=120 KB) & cold archive dumps; feature-flagged |

---

## 2. Architecture Topology

1. **Browser (`src/` in `--mode web` on Cloudflare Pages)**:
   - Stateless Vue 3 SPA.
   - `src/ipc-web/` replaces desktop native bridge objects (`AppApi`, `WebApi`, `VRCXStorage`, `LogWatcher`, `Discord`, `AssetBundleManager`, `window.electron`).
   - `src/services/database/cloud/` implements structured cloud Repositories matching `src/services/database/index.js` without exposing arbitrary SQL over HTTP.
2. **Cloud Control Plane (`cloud/` on Cloudflare Workers)**:
   - `DB_CORE` (`vrcx-core`): `config_bundles`, `stats_counters`, `entity_users`/`entity_users_fts` (`trigram`), `entity_worlds`/`entity_worlds_fts` (`trigram`), `memos*`, `favorite_*`, `avatar_tags`, `friend_log_*`, `notifications*`, `moderation`, `cloud_devices`, `cloud_sync_cursors`, `cloud_screenshots`, `cloud_commands`, `cloud_cookie_vault`.
   - `DB_GAMELOG` (`vrcx-gamelog`): `gamelog_location`, `gamelog_join_leave`, `gamelog_portal_spawn`, `gamelog_video_play`, `gamelog_event`, `gamelog_external` (minimal indexes: `UNIQUE` dedup key + selective B-tree indexes).
   - `DB_FEED` (`vrcx-feed`): `feed_gps`, `feed_online_offline`, `feed_status`, `feed_bio`, `activity_sessions_v2`.
   - Excluded from D1: `gamelog_resource_load`, `cache_world`, `cache_avatar`, `activity_bucket_cache_v2`, `mutual_graph_*`, default `feed_avatar`.
   - `AgentHubDO`: Single-instance Durable Object (`"primary"`) managing Hibernatable WebSockets for both `agent` and `web` clients, live instance player snapshot, residential IP VRChat HTTP RPC relay, and allowlisted remote command dispatch.
3. **Windows Companion Agent (`Dotnet/VRCX-Agent/`, .NET 10 Tray App)**:
   - Reuses `Dotnet/LogWatcher.cs`, `ProcessMonitor.cs`, `WebApi.cs`, `Discord.cs`, `AutoAppLaunchManager.cs`, `AssetBundleManager.cs`, `ScreenshotMetadata/`, `XSOverlay.cs`, `OVRToolkit.cs`.
   - Batches log events every 5-10s (0 requests when idle), buffers offline in local queue, protects credentials with Windows DPAPI, and maintains full local backup archive.

---

## 3. Search & Quota Optimization Strategy

### Entity Dictionary FTS5 (`trigram`) + B-Tree Fact Lookup
- Instead of attaching heavy FTS5 indexes to 500K-row event tables or running full-scan `LIKE '%term%'`:
  1. Deduplicated `entity_users` and `entity_worlds` tables in `DB_CORE` maintain external-content FTS5 virtual tables with `tokenize='trigram'` (supports arbitrary CJK/Latin/symbol >= 3-char substrings).
  2. Search queries first match IDs in `entity_*_fts` (~10-50 rows read), then query `DB_GAMELOG` / `DB_FEED` via B-tree index `WHERE user_id IN (...) ORDER BY id DESC LIMIT ?` (~50 rows read).
  3. 1-2 character queries match in-memory friend lists or bounded recent time windows (never full-table scan).

### Hard Free-Tier Guardrails
- Max <= 20 D1 queries per Worker request (limit: 50).
- All list/search endpoints enforce `LIMIT <= 100`.
- `EXPLAIN QUERY PLAN` test assertions ban unintended `SCAN` on event tables.
- Per-DB size warning at 350 MB (70% of 500 MB Free limit) for annual shard rotation.
- Agent flood folding for high-frequency duplicate room events; Worker payload cap <= 256 KB.
- Daily row-usage telemetry with auto-backoff above 70% daily free limit.

---

## 4. Security Controls (R.A.I.L.G.U.A.R.D.)

- **Web Auth**: Prefer Cloudflare Access when custom domain is available; fallback to single-user PBKDF2 password + TOTP 2FA with `HttpOnly; Secure; SameSite=Strict` cookies.
- **No Raw SQL Endpoints**: All Worker DB operations use schema-validated, statically parameterized SQL.
- **Agent Auth**: Per-device Bearer token (SHA-256 hashed in D1) + `HMAC-SHA256(ts + method + path + sha256(body))` with `±60s` replay window; 6-digit 5-minute single-use pairing code.
- **Remote Command Allowlist**: Strict allowlist (`launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now`), strict regex on `vrchat://launch?...`, no shell invocation (`UseShellExecute = false`).
- **Encrypted Secrets & Private Media**: Optional offline fallback cookies encrypted via AES-256-GCM using Worker Secret `COOKIE_MASTER_KEY`; private R2 bucket only; redacted auth/cookie logs.

---

## 5. Phased Implementation Plan & Exit Criteria

- **Phase 0 (POC & Risk Validation)**: Minimal `cloud/` Worker, 3 D1 schemas + `FTS5 trigram`, `AgentHubDO` WebSocket Hibernation, VRChat API reachability probe endpoint, and automated Miniflare/Vitest benchmarks verifying `EXPLAIN QUERY PLAN`, `rows_read < 100`, and WS Hibernation routing.
- **Phase 1 (Cloud Core + Stateless Web Frontend)**: Full auth, `/api/bootstrap`, structured cloud repositories (`src/services/database/cloud/`), `src/ipc-web/`, `--mode web` build, and zero-regression desktop checks.
- **Phase 2 (`VRCX.Agent` Core Collector + R2 Gallery)**: Lightweight .NET 10 tray app reusing `Dotnet/` modules, pairing, offline queue, batch ingest, PNG metadata + optional R2 WebP thumbnail gallery.
- **Phase 3 (Residential IP Relay + Remote Commands)**: Bidirectional `AgentHubDO` RPC for VRChat HTTP relay and allowlisted remote command execution with audit log.
- **Phase 4 (Local Integrations & Mobile Polish)**: Discord RPC, AutoAppLaunch, XSOverlay/OVRToolkit wiring, D1 quota alerts, and mobile narrow-viewport fixes.
