# VRCX-Worker Deployment & Windows Agent Guide

> Based on upstream [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (MIT). Repository: [https://github.com/nuomew/VRCX-Worker](https://github.com/nuomew/VRCX-Worker).

## 1. One-Click Cloudflare Workers Deployment (Free Tier)

VRCX-Worker runs as a single Cloudflare Worker serving both the complete VRCX Vue SPA (`./build/web`) and the cloud API/WebSocket backend (`cloud/src/index.ts`), backed by 3 auto-provisioned D1 shards (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`) and a SQLite-backed Hibernation Durable Object (`AgentHubDO`).

### Option A: Cloudflare Dashboard Git Integration (Recommended)
1. Click [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker), or in the Cloudflare Dashboard go to **Workers & Pages -> Create -> Import a repository** and select **`nuomew/VRCX-Worker`**.
2. Keep the default root directory (`.`) and default **Deploy command** `npx wrangler deploy`:
   - Root `wrangler.jsonc` defines `"build": { "command": "npm run build:web" }`, so the frontend builds automatically even if the Dashboard **Build command** is left blank.
3. Deploy. Cloudflare Automatic Resource Provisioning creates `vrcx-core`, `vrcx-gamelog`, and `vrcx-feed` D1 databases and `AgentHubDO` automatically on first deploy.
4. On the first HTTP request, `cloud/src/db/schemaBootstrap.ts` automatically creates all tables, indexes, and FTS5 `trigram` dictionaries idempotently (no manual CLI migrations required).

### Option B: Local Wrangler CLI
```bash
npm run build:web
npx wrangler deploy
```

## 2. Optional Security & Storage Secrets (Cloudflare Dashboard -> Settings -> Variables and Secrets)

By default, a fresh deployment boots in `open_setup` mode so you can immediately verify access. **Before regular personal use, configure authentication:**

| Secret / Variable | Purpose | Required? |
|---|---|---|
| `ADMIN_PASSCODE` | Enables Passcode unlock screen + HMAC-signed `HttpOnly` session cookie | Recommended (or use Cloudflare Access) |
| `ADMIN_TOTP_SECRET` | Base32 RFC-6238 TOTP secret for 2FA on unlock | Optional |
| `COOKIE_MASTER_KEY` | 32+ char master key encrypting VRChat cookies (AES-256-GCM) | Recommended for production |
| `AGENT_SYNC_KEY` | Optional static Bearer sync secret for `VRCX.Agent` periodic HTTP upload (alternative to per-device keys generated in Cloud Hub) | Optional |
| `CF_ACCESS_TEAM_DOMAIN` & `CF_ACCESS_AUD` | Enables Cloudflare Access Zero Trust JWT verification | Optional (alternative to Passcode) |
| `VRC_ALLOW_CLOUD_FALLBACK` | Set `"false"` to disable direct Worker -> VRChat API requests | Optional (default `"true"`) |

### Optional Private Cloud Screenshot Gallery (R2)
To store compressed WebP screenshot thumbnails in Cloudflare R2 (10 GB/month Free Tier), attach an **R2 Bucket Binding** (not a plain text environment variable):

| Parameter | Value | Notes |
|---|---|---|
| Binding Type | `R2 bucket` | Configured under Worker **Bindings** (or `r2_buckets` in `wrangler.jsonc`) |
| Variable Name (`binding`) | `R2_MEDIA` | **Exact required name** read by `cloud/src/env.ts` (`env.R2_MEDIA`) |
| Bucket Name (`bucket_name`) | `vrcx-media` (recommended) | Any private R2 bucket created in your Cloudflare account |

**Setup (choose one):**
1. **Git Auto-Deploy (Recommended — preserved across redeploys):**
   Create a private R2 bucket (e.g. `vrcx-media`) in Cloudflare Dashboard -> **R2 Object Storage**, uncomment the `r2_buckets` block in root `wrangler.jsonc` (`"binding": "R2_MEDIA"`, `"bucket_name": "<your-bucket-name>"`), and push to redeploy.
2. **Cloudflare Dashboard Manual Binding:**
   Go to **Workers & Pages -> your Worker -> Settings -> Bindings -> Add -> R2 bucket**, set **Variable name** to `R2_MEDIA`, select your bucket, and save. *(Note: if your Worker deploys automatically via Git `npx wrangler deploy`, Dashboard-only bindings not declared in `wrangler.jsonc` may be overwritten on subsequent deploys.)*

Without `R2_MEDIA` bound, screenshot metadata still syncs to D1 cleanly.

## 3. Installing & Configuring the Windows Companion Tray Agent (`Dotnet/VRCX-Agent`)

`VRCX.Agent` is a lightweight .NET 10 Windows Forms system-tray companion (zero CEF, zero Electron) that auto-detects Simplified Chinese / English from Windows OS locale and runs silently in the background with optional Windows startup:
- **Recommended Windows Installer (`VRCX.Agent-v*-Setup-win-x64.exe`)**: Download from [GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases). Bundles .NET 10 Desktop Runtime, installs per-user into `%LocalAppData%\Programs\VRCX.Agent` (no admin elevation required), enables **Start with Windows in background** by default, supports in-place upgrades, and registers a standard Windows uninstaller.
- **Built-in Online Auto-Update**: Periodically checks `https://github.com/nuomew/VRCX-Worker/releases` (via GitHub Releases API with automatic `/releases/latest` redirect fallback on rate-limited proxy IPs), verifies the installer's SHA-256 digest, and runs `/SILENT /NORESTART` in-place upgrades with automatic tray relaunch.
- Incremental VRChat `output_log_*.txt` GameLog tailing with persisted byte-offset cursor & durable offline JSONL queue
- Periodic HTTPS upload (`POST /api/agent/sync`, default every 60 seconds, configurable 30–3600s) using only **Cloud URL + Sync Secret**
- Optional VRChat screenshot upload (default off) with original PNG or ≤1600px WebP compression toggle (`PUT /api/agent/media/screenshots/{sha256}`)
- Discord Rich Presence, VRChat/SteamVR process monitoring, AutoAppLaunch, XSOverlay/OVRToolkit notifications
- Strict 6-action allowlisted remote commands (`launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now`) queued in D1 and executed on the next sync interval

### Build from Source on Windows (requires .NET 10 SDK)
```powershell
dotnet publish Dotnet/VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false
```
The compiled executable is written to `build/VRCX-Agent/VRCX.Agent.exe`. To build the Windows installer locally, compile `Dotnet/VRCX-Agent/Installer/VRCX-Agent.iss` with Inno Setup 6 (`ISCC.exe`).

### Setup with Cloud URL, Sync Secret & Network Mode (Overseas / Mainland China)
1. Open your deployed VRCX Cloud Web URL and click **Cloud** in the bottom status bar to open **Cloud Hub -> Win Agent (HTTP Sync)** (or **Settings -> System -> Cloud Sync Interval**).
2. Configure your preferred **Cloud Sync Interval** (default `60s` / 1 min, range `30–3600s`). This single setting throttles Web `api.vrchat.cloud` sync requests and controls the exact upload schedule of connected `VRCX.Agent` instances.
3. Copy the **Cloud URL**, enter a device name, and click **Create Sync Secret** to generate a persistent `vrcx_sync_...` secret (stored SHA-256 hashed in D1, revocable anytime). Alternatively, set a static `AGENT_SYNC_KEY` in Cloudflare Worker Secrets.
4. Run `VRCX.Agent-v*-Setup-win-x64.exe` (or `VRCX.Agent.exe`). On first launch, the localized settings window opens automatically; paste the **Cloud URL** and **Sync Secret**, choose **Overseas (Direct)** or **Mainland China (Proxy On)** (leave proxy URL blank to follow Windows system proxy, or enter `http://127.0.0.1:7890`, `socks5://127.0.0.1:7891`, or a native **`vmess://...`** node share link supporting TCP/TLS/WS/WSS), confirm **Start with Windows**, and click **Test & Save**.
5. Once connected, `VRCX.Agent` stays minimized in the Windows system tray and strictly follows the Web sync interval. Re-opening the desktop/Start Menu shortcut brings the settings dialog back to front without launching duplicate tray instances.
