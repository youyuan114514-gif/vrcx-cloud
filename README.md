<div align="center">

# <img src="./images/VRCX.png" width="64" height="64" alt="VRCX-Worker Logo" /> VRCX-Worker

**Pure Stateless Cloud-Hosted Edition of VRCX on Cloudflare Workers (Free Tier)**

*Derived from upstream [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (MIT License)*

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker)
[![GitHub Repository](https://img.shields.io/badge/GitHub-nuomew%2FVRCX--Worker-181717?logo=github)](https://github.com/nuomew/VRCX-Worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## About This Derivative Project

**VRCX-Worker** is a secondary development built on top of [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (baseline `2026.11.14`). It transforms the full VRCX Vue interface into a **100% stateless personal cloud web app** running on **Cloudflare Workers + Sharded D1 + SQLite Durable Objects (WebSocket Hibernation) + optional R2**, paired with an optional lightweight Windows system-tray companion (`Dotnet/VRCX-Agent/`).

- **True Cloud Hosting (Zero Browser Storage Dependency)**: No OPFS or IndexedDB primary database. Clearing browser cache, using incognito mode, or switching between desktop and mobile browsers recovers all settings, notes, memos, favorites, friend history, and encrypted VRChat sessions directly from Cloudflare D1.
- **Full Upstream VRCX Web Experience**: Reuses the original VRCX Vue 3 UI, stores, charts, search, feeds, notifications, and multi-language packs behind explicit `WEB` mode guards—showing only Web-applicable settings and tools in browser builds while preserving **100% zero regression** for original Windows (CEF) and Linux/macOS (Electron) desktop builds.
- **Cloudflare Free-Tier Architecture**:
  - **One-Click Deployment**: Single Worker (`wrangler.jsonc`) serves both the compiled Vue SPA (`./build/web`) and cloud APIs. Automatic Resource Provisioning creates all 3 D1 shards (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`) and `AgentHubDO` automatically, with idempotent cold-start DDL bootstrap (`cloud/src/db/schemaBootstrap.ts`).
  - **Sharded D1 + FTS5 `trigram` Entity Dictionary**: Avoids 500 MB single-DB caps, unindexed `LIKE '%term%'` scans, and full-table `COUNT(*)` queries to stay comfortably inside Free-tier `rows_read` / `rows_written` ceilings.
  - **WebSocket Hibernation**: `AgentHubDO` uses `ctx.acceptWebSocket` and zero-cost `ping`/`pong` auto-responses so idle connections consume zero compute duration.
- **Lightweight Windows Companion Agent (`Dotnet/VRCX-Agent/`, zero CEF/Electron)**:
  - Simple **Cloud URL + Sync Secret** configuration driven strictly by the **Web Cloud Sync Interval** setting (default `60s` / 1 min): local logs & screenshots stay buffered on disk outside the window and only upload on the next scheduled tick (no persistent WebSocket needed)
  - Built-in **Overseas (Direct / Proxy Off)** vs **Mainland China (Proxy On)** network switch supporting Windows system proxy and custom HTTP/HTTPS/SOCKS5 proxies (instant toggle from tray menu or settings dialog)
  - Incremental VRChat `output_log_*.txt` GameLog sync with persisted byte-offset cursor & durable offline JSONL queue (`POST /api/agent/sync`)
  - Local PNG metadata embedding (`Dotnet/ScreenshotMetadata`) + ≤1600px WebP thumbnail upload to optional private R2 gallery
  - Discord Rich Presence, VRChat/SteamVR process monitoring, AutoAppLaunch, XSOverlay / OVRToolkit VR notifications
  - Strict 6-action allowlisted remote commands queued in D1 and executed on the next periodic sync (`launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now`)

---

## One-Click Deployment (Cloudflare Workers Free Tier)

1. Click **Deploy to Cloudflare** above, or in the Cloudflare Dashboard go to **Workers & Pages -> Create -> Import a repository** and select **`nuomew/VRCX-Worker`**.
2. Keep the repository root (`.`) and default deploy command `npx wrangler deploy`.
   - Root [`wrangler.jsonc`](./wrangler.jsonc) includes `"build": { "command": "npm run build:web" }`, so the full Web SPA builds automatically even if the Dashboard Build command is left blank.
   - Cloudflare automatically provisions `vrcx-core`, `vrcx-gamelog`, `vrcx-feed` D1 databases and `AgentHubDO`, and initializes all tables on the first request.
3. For personal use, configure optional access protection and sync secrets (`ADMIN_PASSCODE`, `ADMIN_TOTP_SECRET`, `COOKIE_MASTER_KEY`, `AGENT_SYNC_KEY`, or Cloudflare Access) in **Worker -> Settings -> Variables and Secrets**.

See the full deployment, security secret, R2 gallery, and Windows companion sync guide in **[`docs/cloud-architecture/DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md)** and the architecture specification in **[`docs/cloud-architecture/Tech-Spec.md`](./docs/cloud-architecture/Tech-Spec.md)**.

---

## Repository Structure

| Path | Description |
|---|---|
| `src/` | Upstream VRCX Vue 3 frontend with guarded `WEB` mode adapters (`src/ipc-web/`, `src/services/database/cloud/`, `src/components/cloud/`) |
| `cloud/` | Cloudflare Worker backend (`src/auth/`, `src/crypto/`, `src/db/`, `src/hub/AgentHubDO.ts`, `src/routes/`, `src/search/`, `migrations/`, `test/`) |
| `Dotnet/VRCX-Agent/` | Lightweight .NET 10 Windows tray companion performing periodic HTTPS sync and reusing upstream `Dotnet/Discord.cs` & `Dotnet/ScreenshotMetadata/` |
| `Dotnet/VRCX-Agent.Tests/` | Cross-platform xUnit tests for periodic HTTP sync, command/SSRF allowlist, log parser, offline queue, and PNG/WebP pipeline |
| `Dotnet/` & `src-electron/` | Original upstream desktop CEF and Electron shells (preserved unmodified in behavior) |
| `docs/cloud-architecture/` | Technical specification (`Tech-Spec.md`) and deployment/sync guide (`DEPLOY.md`) |

---

## Local Development & Verification

```bash
# 1. Frontend Web build (outputs ./build/web)
npm ci
npm run build:web
npm run lint
npm run test

# 2. Cloudflare Worker backend typecheck & workerd tests
cd cloud
npm ci
npm run typecheck
npm test

# 3. Windows Companion Agent build & tests (.NET 10 SDK)
dotnet build Dotnet/VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64
dotnet test Dotnet/VRCX-Agent.Tests/VRCX-Agent.Tests.csproj

# 4. Upstream Desktop build (zero-regression check)
npm run prod
```

---

## Upstream Attribution & VRChat TOS Notice

- **Upstream Project**: This project is derived from **[vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)** (`© 2019-2026 pypy, Natsumi, Map1en & VRCX Contributors`), distributed under the [MIT License](./LICENSE).
- **VRChat TOS**: Like upstream VRCX, VRCX-Worker is an external companion tool that interacts exclusively with official VRChat APIs and local game logs. It does not modify the VRChat client.
- VRCX-Worker is not endorsed by VRChat and does not reflect the views or opinions of VRChat Inc. VRChat and all associated properties are trademarks or registered trademarks of VRChat Inc.
