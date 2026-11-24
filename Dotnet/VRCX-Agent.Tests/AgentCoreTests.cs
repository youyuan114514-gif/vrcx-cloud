using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using VRCX.Agent.Core;
using Xunit;

namespace VRCX.Agent.Tests;

public sealed class AgentCoreTests
{
    [Fact]
    public void CommandValidator_EnforcesAllowlistAndBlocksInjectionAndSsrf()
    {
        Assert.True(CommandValidator.ValidateRemoteCommand("sync_now", null).Ok);
        Assert.True(CommandValidator.ValidateRemoteCommand("quit_vrc", null).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("run_powershell", null).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("exec_shell", null).Ok);

        // Valid vrchat://launch URL
        string validUrl = "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)";
        Assert.True(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = validUrl }).Ok);

        // Shell injection / protocol abuse rejected
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = validUrl + " & calc.exe" }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = "cmd.exe /c whoami" }).Ok);
        Assert.False(CommandValidator.ValidateRemoteCommand("launch_vrc", new Dictionary<string, object?> { ["launchUrl"] = "http://evil.example/payload" }).Ok);

        // SSRF allowlist
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://api.vrchat.cloud/api/1/auth/user"));
        Assert.True(CommandValidator.IsAllowedVrcUrl("https://files.vrchat.cloud/file_1/1/file"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("http://api.vrchat.cloud/api/1/auth/user")); // non-HTTPS
        Assert.False(CommandValidator.IsAllowedVrcUrl("https://169.254.169.254/latest/meta-data/"));
        Assert.False(CommandValidator.IsAllowedVrcUrl("https://evil-vrchat.com.attacker.net/api"));
    }

    [Fact]
    public void VrcLogParser_ParsesCjkWorldsPlayersVideosFiltersNoiseAndFoldsFloods()
    {
        var parser = new VrcLogParser();

        // Noise line should be ignored
        Assert.Null(parser.ParseLine("2026.11.24 12:00:00 Log        -  [AssetBundleDownloadManager] Downloading asset avtr_123"));

        // Joining + Entering Room emits Location with CJK world name
        Assert.Null(parser.ParseLine("2026.11.24 12:00:01 Log        -  [Behaviour] Joining wrld_12345678-1234-1234-1234-1234567890ab:99999~region(jp)"));
        GameLogEventItem? locEv = parser.ParseLine("2026.11.24 12:00:02 Log        -  [Behaviour] Entering Room: 日本語ワールド 中文吧");
        Assert.NotNull(locEv);
        Assert.Equal("Location", locEv!.Type);
        Assert.Equal("wrld_12345678-1234-1234-1234-1234567890ab", locEv.WorldId);
        Assert.Equal("日本語ワールド 中文吧", locEv.WorldName);

        // Duplicate within flood window folded
        Assert.Null(parser.ParseLine("2026.11.24 12:00:03 Log        -  [Behaviour] Entering Room: 日本語ワールド 中文吧"));

        // Player joined & left
        GameLogEventItem? joinEv = parser.ParseLine("2026.11.24 12:00:04 Log        -  [Behaviour] OnPlayerJoined 桜ちゃん (usr_11111111-1111-1111-1111-111111111111)");
        Assert.NotNull(joinEv);
        Assert.Equal("OnPlayerJoined", joinEv!.Type);
        Assert.Equal("桜ちゃん", joinEv.DisplayName);
        Assert.Equal("usr_11111111-1111-1111-1111-111111111111", joinEv.UserId);
        Assert.Equal(1, parser.CurrentPlayerCount);

        GameLogEventItem? leftEv = parser.ParseLine("2026.11.24 12:00:10 Log        -  [Behaviour] OnPlayerLeft 桜ちゃん (usr_11111111-1111-1111-1111-111111111111)");
        Assert.NotNull(leftEv);
        Assert.Equal("OnPlayerLeft", leftEv!.Type);
        Assert.Equal(0, parser.CurrentPlayerCount);

        // Video playback
        GameLogEventItem? vidEv = parser.ParseLine("2026.11.24 12:00:12 Log        -  [Video Playback] Attempting to resolve URL 'https://youtu.be/dQw4w9WgXcQ'");
        Assert.NotNull(vidEv);
        Assert.Equal("VideoPlay", vidEv!.Type);
        Assert.Equal("https://youtu.be/dQw4w9WgXcQ", vidEv.VideoUrl);
    }

    [Fact]
    public async Task PeriodicHttpSync_TailsCursorUploadsWithBearerSecretPullsCommandsAndReportsResult()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-agent-test-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-24_01-00-00.txt");
            await File.WriteAllTextAsync(
                logFile,
                "2026.11.24 12:00:01 Log        -  [Behaviour] Joining wrld_12345678-1234-1234-1234-1234567890ab:100\n" +
                "2026.11.24 12:00:02 Log        -  [Behaviour] Entering Room: Test Shrine\n",
                Encoding.UTF8);

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx-cloud.example.workers.dev",
                SyncSecret = "vrcx_sync_secret_token_123",
                DeviceName = "公主的台式机",
                SyncIntervalSeconds = 45
            };
            Assert.True(cfg.IsConfigured);
            Assert.Equal(45, cfg.EffectiveSyncIntervalSeconds);

            var collector = new LogTailCollector(stateDir);
            int parsed = collector.PollLogDirectory(logDir);
            Assert.Equal(1, parsed);
            Assert.Equal(1, collector.OfflineQueueCount);

            // Second poll without new lines reads 0 bytes
            Assert.Equal(0, collector.PollLogDirectory(logDir));

            string? capturedSyncPath = null;
            string? capturedAuth = null;
            string? capturedBody = null;
            string? capturedResultPath = null;

            using var handler = new StubHttpHandler(async (req) =>
            {
                string path = req.RequestUri!.AbsolutePath;
                if (path == "/api/agent/sync")
                {
                    capturedSyncPath = path;
                    capturedAuth = req.Headers.Authorization?.ToString();
                    capturedBody = await req.Content!.ReadAsStringAsync();
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"ok\":true,\"data\":{\"deviceId\":\"win-srv-01\",\"deviceName\":\"公主的台式机\",\"syncedAt\":\"2026-11-24T01:05:00Z\",\"ingest\":{\"inserted\":1,\"skipped\":0},\"pendingCommands\":[{\"cmdId\":\"cmd_abc123\",\"action\":\"quit_vrc\",\"params\":{},\"expiresAt\":\"2026-11-24T01:15:00Z\"}]}}",
                            Encoding.UTF8,
                            "application/json")
                    };
                }
                if (path == "/api/agent/commands/cmd_abc123/result")
                {
                    capturedResultPath = path;
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("{\"ok\":true}", Encoding.UTF8, "application/json")
                    };
                }
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            });
            using var http = new HttpClient(handler);
            var syncClient = new HttpSyncClient(http);

            var batch = collector.PeekBatch(50);
            Assert.Single(batch);

            AgentSyncResponse res = await syncClient.SyncOnceAsync(
                cfg,
                batch,
                collector.SnapshotCursor(),
                new LiveAgentState { VrcRunning = true, CurrentWorldName = "Test Shrine" },
                CancellationToken.None);

            collector.AcknowledgeBatch(batch.Count);

            Assert.Equal("/api/agent/sync", capturedSyncPath);
            Assert.Equal("Bearer vrcx_sync_secret_token_123", capturedAuth);
            Assert.Contains("Test Shrine", capturedBody);
            Assert.Contains("公主的台式机", capturedBody);
            Assert.Equal(0, collector.OfflineQueueCount);
            Assert.Equal(1, res.Ingest.Inserted);
            Assert.Single(res.PendingCommands);
            Assert.Equal("cmd_abc123", res.PendingCommands[0].CmdId);

            bool reported = await syncClient.ReportCommandResultAsync(
                cfg,
                new CommandExecutionResult { CmdId = "cmd_abc123", Status = "succeeded", Message = "Done" },
                CancellationToken.None);
            Assert.True(reported);
            Assert.Equal("/api/agent/commands/cmd_abc123/result", capturedResultPath);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ScreenshotPipeline_EmbedsUpstreamPngMetadataAndEncodesBoundedWebpThumbnail()
    {
        string tempPng = Path.Combine(Path.GetTempPath(), $"vrcx-shot-{Guid.NewGuid():N}.png");
        try
        {
            // Create a real 2400x1200 PNG to test both upstream PNGFile metadata write and <= 1600px WebP downscale
            using (var img = new Image<Rgba32>(2400, 1200, new Rgba32(40, 120, 200, 255)))
            {
                img.SaveAsPng(tempPng);
            }

            var meta = new ScreenshotMetaPayload
            {
                TakenAt = "2026-11-24T01:00:00Z",
                LocalFilename = Path.GetFileName(tempPng),
                WorldId = "wrld_12345678-1234-1234-1234-1234567890ab",
                WorldName = "Sakura Garden 桜庭",
                InstanceId = "12345~region(jp)",
                Players = new List<Dictionary<string, string>>
                {
                    new() { ["displayName"] = "Alice", ["userId"] = "usr_1" }
                }
            };

            bool written = ScreenshotPipeline.WriteVrcxPngMetadata(tempPng, meta);
            Assert.True(written);

            // Read back using upstream PNGFile + PNGHelper
            using (var readPng = new VRCX.PNGFile(tempPng, writeAccess: false))
            {
                string? desc = VRCX.PNGHelper.ReadTextChunk("Description", readPng);
                Assert.NotNull(desc);
                Assert.Contains("Sakura Garden 桜庭", desc);
                Assert.Contains("wrld_12345678-1234-1234-1234-1234567890ab", desc);
            }

            // Encode WebP thumbnail and confirm resize ceiling <= 1600px
            byte[] webp = ScreenshotPipeline.EncodeWebpThumbnail(tempPng, maxDim: 1600, quality: 80);
            Assert.NotEmpty(webp);
            using Image decoded = Image.Load(webp);
            Assert.Equal(1600, decoded.Width);
            Assert.Equal(800, decoded.Height);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
        }
    }

    [Fact]
    public void ProxyHttpClientFactory_SwitchesOverseasDirectAndMainlandProxyModes()
    {
        // 1. Overseas mode (ProxyEnabled = false) disables proxy completely even if an old address is present
        using (var directHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: false, "http://127.0.0.1:7890"))
        {
            Assert.False(directHandler.UseProxy);
            Assert.Null(directHandler.Proxy);
        }

        // 2. Mainland China mode with empty address follows Windows system proxy
        using (var sysHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, ""))
        {
            Assert.True(sysHandler.UseProxy);
            Assert.NotNull(sysHandler.Proxy);
        }

        // 3. Mainland China mode with shorthand host:port normalizes to http://
        var (okHttp, httpUri, _) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri("127.0.0.1:7890");
        Assert.True(okHttp);
        Assert.Equal("http://127.0.0.1:7890/", httpUri!.ToString());

        // 4. Mainland China mode supports SOCKS5 and optional user:pass credentials
        var (okSocks, socksUri, _) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri("socks5://alice:secret@127.0.0.1:7891");
        Assert.True(okSocks);
        Assert.Equal("socks5", socksUri!.Scheme);

        using (var socksHandler = ProxyHttpClientFactory.CreateHandler(proxyEnabled: true, "socks5://alice:secret@127.0.0.1:7891"))
        {
            Assert.True(socksHandler.UseProxy);
            var webProxy = Assert.IsType<WebProxy>(socksHandler.Proxy);
            Assert.Equal("socks5://127.0.0.1:7891/", webProxy.Address!.ToString());
            var creds = Assert.IsType<NetworkCredential>(webProxy.Credentials);
            Assert.Equal("alice", creds.UserName);
            Assert.Equal("secret", creds.Password);
        }

        // 5. Unsupported proxy schemes are rejected
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("ftp://127.0.0.1:21").Ok);
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("file:///etc/passwd").Ok);
    }

    [Fact]
    public void SyncScheduleGate_StrictlyFollowsWebIntervalAndBlocksEarlySync()
    {
        var gate = new SyncScheduleGate();
        var t0 = new DateTimeOffset(2026, 11, 24, 3, 0, 0, TimeSpan.Zero);

        // Initial handshake is due immediately upon startup
        Assert.True(gate.IsDue(t0));
        Assert.False(gate.HasSyncedWithWeb);

        // Web instructs a 120s (2 min) sync interval
        int applied = gate.ApplyServerSchedule(new AgentSyncResponse { SyncIntervalSeconds = 120 }, t0);
        Assert.Equal(120, applied);
        Assert.True(gate.HasSyncedWithWeb);
        Assert.Equal(t0.AddSeconds(120), gate.NextSyncAtUtc);

        // Strictly blocked during the entire 120s window (no early uploads even if local logs arrive)
        Assert.False(gate.IsDue(t0));
        Assert.False(gate.IsDue(t0.AddSeconds(30)));
        Assert.False(gate.IsDue(t0.AddSeconds(119)));

        // Permitted only once the scheduled Web sync timestamp arrives
        Assert.True(gate.IsDue(t0.AddSeconds(120)));

        // Web updates interval to 60s -> next cycle immediately follows 60s
        var t1 = t0.AddSeconds(120);
        Assert.Equal(60, gate.ApplyServerSchedule(new AgentSyncResponse { SyncIntervalSeconds = 60 }, t1));
        Assert.False(gate.IsDue(t1.AddSeconds(59)));
        Assert.True(gate.IsDue(t1.AddSeconds(60)));

        // Transient failure backoff never accelerates faster than the Web-configured interval
        gate.ApplyFailureBackoff(consecutiveFailures: 1, t1.AddSeconds(60));
        Assert.False(gate.IsDue(t1.AddSeconds(119)));
        Assert.True(gate.IsDue(t1.AddSeconds(120)));
    }

    [Fact]
    public async Task ScreenshotSync_DefaultsOff_AndSupportsOriginalOrCompressedUpload()
    {
        var defaultCfg = new AgentConfig
        {
            CloudUrl = "https://vrcx.example.workers.dev",
            SyncSecret = "secret"
        };
        Assert.False(defaultCfg.AutoUploadScreenshots);
        Assert.False(defaultCfg.CompressScreenshots);

        string tempPng = Path.Combine(Path.GetTempPath(), $"vrcx-test-shot-{Guid.NewGuid():N}.png");
        try
        {
            using (var img = new SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>(64, 64))
            {
                img.SaveAsPng(tempPng);
            }
            byte[] originalBytes = await File.ReadAllBytesAsync(tempPng);

            // Default (AutoUploadScreenshots = false) sends zero HTTP requests
            int requestCount = 0;
            using var http = new HttpClient(new StubHttpHandler(_ =>
            {
                requestCount++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
            }));
            var pipeline = new ScreenshotPipeline(() => defaultCfg, http);
            bool skipped = await pipeline.UploadQueuedTaskAsync(
                new PendingScreenshotTask { LocalPath = tempPng, TakenAtIso = "2026-11-24T04:00:00Z" },
                CancellationToken.None);
            Assert.True(skipped);
            Assert.Equal(0, requestCount);

            // compress = false preserves original PNG bytes & image/png MIME
            var (rawBytes, rawMime) = ScreenshotPipeline.PrepareUploadPayload(tempPng, compress: false);
            Assert.Equal("image/png", rawMime);
            Assert.Equal(originalBytes, rawBytes);

            // compress = true encodes WebP & image/webp MIME
            var (webpBytes, webpMime) = ScreenshotPipeline.PrepareUploadPayload(tempPng, compress: true);
            Assert.Equal("image/webp", webpMime);
            Assert.True(webpBytes.Length > 12);
            Assert.Equal((byte)'R', webpBytes[0]);
            Assert.Equal((byte)'I', webpBytes[1]);
            Assert.Equal((byte)'F', webpBytes[2]);
            Assert.Equal((byte)'F', webpBytes[3]);
        }
        finally
        {
            if (File.Exists(tempPng)) File.Delete(tempPng);
        }
    }

    [Fact]
    public void AgentStrings_SupportsSimplifiedChineseAndEnglishFallback()
    {
        string? previous = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "zh-CN";
            Assert.True(AgentStrings.IsChinese);
            Assert.Equal("Microsoft YaHei UI", AgentStrings.UiFontFamily);
            Assert.Equal("VRCX 云端伴侣", AgentStrings.AppTitle);
            Assert.Contains("同步与代理设置", AgentStrings.SettingsWindowTitle);
            Assert.Contains("开机自动后台运行", AgentStrings.AutoStartCheckbox);
            Assert.DoesNotContain("&", AgentStrings.NetworkGroupTitle);
            Assert.DoesNotContain("&", AgentStrings.SettingsDefaultHint);
            Assert.Equal("海外直连", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = false }));
            Assert.Equal("中国大陆 · 系统代理", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "" }));
            Assert.Equal("中国大陆 · 自定义代理", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "127.0.0.1:7890" }));

            AgentStrings.LanguageOverride = "en-US";
            Assert.False(AgentStrings.IsChinese);
            Assert.Equal("Segoe UI", AgentStrings.UiFontFamily);
            Assert.Equal("VRCX Cloud Agent", AgentStrings.AppTitle);
            // WinForms control labels must escape '&' as '&&' so no mnemonic underscore is rendered
            Assert.Contains("&&", AgentStrings.NetworkGroupTitle);
            Assert.Contains("&&", AgentStrings.SettingsDefaultHint);
            Assert.Equal("Overseas Direct", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = false }));
            Assert.Equal("Mainland · System Proxy", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "" }));
            Assert.Equal("Mainland · Custom Proxy", ProxyHttpClientFactory.DescribeMode(new AgentConfig { ProxyEnabled = true, ProxyAddress = "127.0.0.1:7890" }));
        }
        finally
        {
            AgentStrings.LanguageOverride = previous;
        }
    }

    [Fact]
    public async Task AgentUpdater_ParsesReleasesFallsBackOnRateLimitAndVerifiesSha256()
    {
        // 1. Semantic version comparisons
        Assert.True(AgentUpdater.IsNewerVersion("1.3.0", "v1.4.0"));
        Assert.True(AgentUpdater.IsNewerVersion("1.9.0", "v1.10.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.4.0", "v1.4.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.5.0", "v1.4.0"));
        Assert.False(AgentUpdater.IsNewerVersion("1.4.0", "not-a-tag"));

        // 2. Trusted GitHub download host allowlist (SSRF / supply-chain protection)
        Assert.True(AgentUpdater.IsTrustedDownloadUrl("https://github.com/nuomew/VRCX-Worker/releases/download/v1.4.0/VRCX.Agent-v1.4.0-Setup-win-x64.exe"));
        Assert.True(AgentUpdater.IsTrustedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/123"));
        Assert.False(AgentUpdater.IsTrustedDownloadUrl("http://github.com/nuomew/VRCX-Worker/releases/download/v1.4.0/a.exe"));
        Assert.False(AgentUpdater.IsTrustedDownloadUrl("https://evil-github.com.attacker.net/payload.exe"));

        // 3. API JSON parsing with GitHub native sha256 digest
        byte[] fakeInstallerBytes = new byte[4096];
        new Random(42).NextBytes(fakeInstallerBytes);
        string expectedSha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(fakeInstallerBytes)).ToLowerInvariant();

        string apiJson = $@"{{
            ""tag_name"": ""v1.5.0"",
            ""html_url"": ""https://github.com/nuomew/VRCX-Worker/releases/tag/v1.5.0"",
            ""body"": ""Release notes"",
            ""assets"": [
                {{
                    ""name"": ""VRCX.Agent-v1.5.0-Setup-win-x64.exe"",
                    ""size"": {fakeInstallerBytes.Length},
                    ""digest"": ""sha256:{expectedSha}"",
                    ""browser_download_url"": ""https://github.com/nuomew/VRCX-Worker/releases/download/v1.5.0/VRCX.Agent-v1.5.0-Setup-win-x64.exe""
                }}
            ]
        }}";
        AgentReleaseInfo? parsed = AgentUpdater.ParseReleaseApiJson(apiJson, "1.4.0");
        Assert.NotNull(parsed);
        Assert.True(parsed!.IsUpdateAvailable);
        Assert.Equal("v1.5.0", parsed.TagName);
        Assert.Equal(expectedSha, parsed.ExpectedSha256);

        // 4. Rate-limit (HTTP 403) fallback to github.com/releases/latest redirect + HTML checksum extraction
        using var fallbackHttp = new HttpClient(new StubHttpHandler(req =>
        {
            string url = req.RequestUri!.AbsoluteUri;
            if (url == AgentUpdater.LatestApiUrl)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)
                {
                    Content = new StringContent("{\"message\":\"API rate limit exceeded\"}")
                });
            }
            if (url == AgentUpdater.LatestWebRedirectUrl)
            {
                var res = new HttpResponseMessage(HttpStatusCode.OK)
                {
                    RequestMessage = new HttpRequestMessage(HttpMethod.Get, "https://github.com/nuomew/VRCX-Worker/releases/tag/v1.5.0"),
                    Content = new StringContent($"<code>VRCX.Agent-v1.5.0-Setup-win-x64.exe</code>: <code>{expectedSha}</code>")
                };
                return Task.FromResult(res);
            }
            if (url.EndsWith("VRCX.Agent-v1.5.0-Setup-win-x64.exe", StringComparison.Ordinal))
            {
                var content = new ByteArrayContent(fakeInstallerBytes);
                content.Headers.ContentLength = fakeInstallerBytes.Length;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
        }));

        var updater = new AgentUpdater(fallbackHttp);
        AgentReleaseInfo fallbackRelease = await updater.CheckForUpdateAsync("1.4.0", CancellationToken.None);
        Assert.True(fallbackRelease.UsedFallbackRedirect);
        Assert.True(fallbackRelease.IsUpdateAvailable);
        Assert.Equal("v1.5.0", fallbackRelease.TagName);
        Assert.Equal(expectedSha, fallbackRelease.ExpectedSha256);

        // 5. Streaming download + SHA-256 verification succeeds and writes exact file
        string tempDir = Path.Combine(Path.GetTempPath(), "vrcx-update-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            string savedPath = await updater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None);
            Assert.True(File.Exists(savedPath));
            Assert.Equal(fakeInstallerBytes, await File.ReadAllBytesAsync(savedPath));

            // 6. Tampered checksum is rejected and temporary .part file is removed
            fallbackRelease.ExpectedSha256 = new string('0', 64);
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                updater.DownloadAndVerifyInstallerAsync(fallbackRelease, tempDir, null, CancellationToken.None));
            Assert.False(File.Exists(savedPath + ".part"));
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task VmessAead_MatchesXrayCoreGoldenVectors_ParsesLinks_AndTunnelsHttpEndToEnd()
    {
        // 1. Verify exact byte-for-byte parity with Xray-core Go reference vectors (aead/kdf.go & authid.go)
        Assert.True(VmessConfig.TryParseUuidBigEndian("de305d54-75b4-431b-adb2-eb6b9e546014", out byte[] uuidBytes));
        byte[] cmdKey = VmessAeadClient.ComputeCmdKey(uuidBytes);
        Assert.Equal("cec646f87c62b6dba283881bc99c68d7", Convert.ToHexString(cmdKey).ToLowerInvariant());

        byte[] authKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("AES Auth ID Encryption"));
        Assert.Equal("bd22928503ab58c8acb9447e2ffcf573", Convert.ToHexString(authKey).ToLowerInvariant());

        byte[] rand4 = { 0x11, 0x22, 0x33, 0x44 };
        byte[] authId = VmessAeadClient.CreateAuthId(cmdKey, 1700000000L, rand4);
        Assert.Equal("33d6d6abd11fdca3aa72c4ab08f49eb7", Convert.ToHexString(authId).ToLowerInvariant());

        byte[] nonce8 = { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 };
        byte[] lenKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), authId, nonce8);
        byte[] lenIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), authId, nonce8)[..12];
        byte[] hdrKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), authId, nonce8);
        byte[] hdrIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), authId, nonce8)[..12];

        Assert.Equal("fcca660effd25d4d0de16cf79773d917", Convert.ToHexString(lenKey).ToLowerInvariant());
        Assert.Equal("824675708e90699854a6d202", Convert.ToHexString(lenIv).ToLowerInvariant());
        Assert.Equal("9875e8ff998b6b63b598ab0e962a4094", Convert.ToHexString(hdrKey).ToLowerInvariant());
        Assert.Equal("7b29291b1db539251f2d4713", Convert.ToHexString(hdrIv).ToLowerInvariant());

        // 2. Parse v2rayN standard JSON vmess:// (WS + TLS + custom SNI/Host/Path) and Shadowrocket compact link
        string wsJson = "{\"v\":\"2\",\"ps\":\"香港节点\",\"add\":\"1.2.3.4\",\"port\":\"443\",\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"aid\":\"0\",\"scy\":\"auto\",\"net\":\"ws\",\"type\":\"none\",\"host\":\"cdn.example.com\",\"path\":\"/vrcx\",\"tls\":\"tls\",\"sni\":\"sni.example.com\"}";
        string wsLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(wsJson));
        Assert.True(ProxyHttpClientFactory.NormalizeAndValidateProxyUri(wsLink).Ok);
        Assert.True(VmessConfig.TryParse(wsLink, out VmessConfig? wsCfg, out _));
        Assert.Equal("香港节点", wsCfg!.Remarks);
        Assert.Equal("ws", wsCfg.Network);
        Assert.True(wsCfg.UseTls);
        Assert.Equal("sni.example.com", wsCfg.EffectiveSni);
        Assert.Equal("/vrcx", wsCfg.EffectiveWsPath);
        Assert.Equal(0x03, wsCfg.WireSecurityByte);

        string compactPayload = Convert.ToBase64String(Encoding.UTF8.GetBytes("aes-128-gcm:de305d54-75b4-431b-adb2-eb6b9e546014@10.0.0.1:8443"));
        string compactLink = $"vmess://{compactPayload}?remarks=Tokyo&obfs=websocket&path=/ray&obfsParam=ws.example.com&tls=1";
        Assert.True(VmessConfig.TryParse(compactLink, out VmessConfig? compactCfg, out _));
        Assert.Equal("Tokyo", compactCfg!.Remarks);
        Assert.Equal("ws", compactCfg.Network);
        Assert.Equal("ws.example.com", compactCfg.Host);
        Assert.True(compactCfg.UseTls);

        // Unsupported transport (e.g. grpc) is rejected cleanly with explanation
        string grpcJson = "{\"add\":\"1.2.3.4\",\"port\":443,\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"net\":\"grpc\"}";
        Assert.False(ProxyHttpClientFactory.NormalizeAndValidateProxyUri("vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(grpcJson))).Ok);

        // 3. End-to-end real HttpClient -> ProxyHttpClientFactory(vmess://) -> loopback VMess AEAD Server
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int serverPort = ((IPEndPoint)listener.LocalEndpoint).Port;

        string tcpJson = $"{{\"v\":\"2\",\"ps\":\"LocalTest\",\"add\":\"127.0.0.1\",\"port\":{serverPort},\"id\":\"de305d54-75b4-431b-adb2-eb6b9e546014\",\"aid\":0,\"scy\":\"aes-128-gcm\",\"net\":\"tcp\",\"tls\":\"\"}}";
        string tcpVmessLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(tcpJson));

        string? capturedTargetHost = null;
        int capturedTargetPort = 0;
        string? capturedHttpReq = null;

        Task serverTask = Task.Run(async () =>
        {
            using var tcpClient = await listener.AcceptTcpClientAsync();
            using var net = tcpClient.GetStream();

            static async Task<byte[]> ReadExact(Stream s, int n)
            {
                byte[] buf = new byte[n];
                int total = 0;
                while (total < n)
                {
                    int r = await s.ReadAsync(buf.AsMemory(total, n - total));
                    if (r == 0) throw new EndOfStreamException();
                    total += r;
                }
                return buf;
            }

            // Read & decrypt VMess AEAD Request Header
            byte[] reqAuthId = await ReadExact(net, 16);
            byte[] encLen = await ReadExact(net, 18);
            byte[] reqNonce = await ReadExact(net, 8);

            // Decrypt AuthID and validate CRC32
            using (var aes = System.Security.Cryptography.Aes.Create())
            {
                aes.Key = authKey;
                byte[] decAuth = aes.DecryptEcb(reqAuthId, System.Security.Cryptography.PaddingMode.None);
                uint crcActual = VmessAeadClient.ComputeCrc32Ieee(decAuth.AsSpan(0, 12));
                uint crcExpected = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(decAuth.AsSpan(12, 4));
                Assert.Equal(crcExpected, crcActual);
            }

            byte[] lKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), reqAuthId, reqNonce);
            byte[] lIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), reqAuthId, reqNonce)[..12];
            byte[] plainLenBytes = VmessAeadClient.AesGcmOpen(lKey, lIv, encLen, reqAuthId);
            ushort headerLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(plainLenBytes);

            byte[] encHdr = await ReadExact(net, headerLen + 16);
            byte[] hKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), reqAuthId, reqNonce);
            byte[] hIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), reqAuthId, reqNonce)[..12];
            byte[] hdr = VmessAeadClient.AesGcmOpen(hKey, hIv, encHdr, reqAuthId);

            // Verify FNV-1a32 checksum and parse fields
            uint fnvActual = VmessAeadClient.ComputeFnv1a32(hdr.AsSpan(0, hdr.Length - 4));
            uint fnvExpected = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(hdr.AsSpan(hdr.Length - 4, 4));
            Assert.Equal(fnvExpected, fnvActual);

            byte[] reqBodyIv = hdr[1..17];
            byte[] reqBodyKey = hdr[17..33];
            byte respAuthV = hdr[33];
            capturedTargetPort = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(38, 2));
            byte addrType = hdr[40];
            Assert.Equal(0x02, addrType);
            int domainLen = hdr[41];
            capturedTargetHost = Encoding.ASCII.GetString(hdr, 42, domainLen);

            // Read first encrypted data chunk (HTTP request)
            byte[] chunkLenBytes = await ReadExact(net, 2);
            ushort chunkLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(chunkLenBytes);
            byte[] chunkEnc = await ReadExact(net, chunkLen);
            byte[] chunkIv = new byte[12];
            Buffer.BlockCopy(reqBodyIv, 2, chunkIv, 2, 10); // count = 0
            byte[] plainReq = VmessAeadClient.AesGcmOpen(reqBodyKey, chunkIv, chunkEnc, ReadOnlySpan<byte>.Empty);
            capturedHttpReq = Encoding.ASCII.GetString(plainReq);

            // Encode AEAD Response Header + encrypted HTTP 200 response chunk + EOF chunk
            byte[] respBodyKey = System.Security.Cryptography.SHA256.HashData(reqBodyKey)[..16];
            byte[] respBodyIv = System.Security.Cryptography.SHA256.HashData(reqBodyIv)[..16];
            byte[] respHdrPlain = { respAuthV, 0x00, 0x00, 0x00 };
            byte[] respHdrLenPlain = { 0x00, 0x04 };
            byte[] rLenKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Len Key"));
            byte[] rLenIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header Len IV"))[..12];
            byte[] rHdrKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Key"));
            byte[] rHdrIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header IV"))[..12];

            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rLenKey, rLenIv, respHdrLenPlain, ReadOnlySpan<byte>.Empty));
            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rHdrKey, rHdrIv, respHdrPlain, ReadOnlySpan<byte>.Empty));

            byte[] httpBody = Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nVMESS_PONG");
            byte[] respChunkIv0 = new byte[12];
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv0, 2, 10);
            byte[] sealedResp = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv0, httpBody, ReadOnlySpan<byte>.Empty);
            byte[] respFrame = new byte[2 + sealedResp.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(respFrame.AsSpan(0, 2), (ushort)sealedResp.Length);
            Buffer.BlockCopy(sealedResp, 0, respFrame, 2, sealedResp.Length);
            await net.WriteAsync(respFrame);

            // Send AEAD EOF chunk (count = 1, empty plaintext -> 16B tag)
            byte[] respChunkIv1 = new byte[12];
            respChunkIv1[1] = 1;
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv1, 2, 10);
            byte[] sealedEof = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv1, ReadOnlySpan<byte>.Empty, ReadOnlySpan<byte>.Empty);
            byte[] eofFrame = new byte[2 + sealedEof.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(eofFrame.AsSpan(0, 2), (ushort)sealedEof.Length);
            Buffer.BlockCopy(sealedEof, 0, eofFrame, 2, sealedEof.Length);
            await net.WriteAsync(eofFrame);
            await net.FlushAsync();
        });

        using HttpClient vmessHttp = ProxyHttpClientFactory.CreateHttpClient(new AgentConfig
        {
            ProxyEnabled = true,
            ProxyAddress = tcpVmessLink
        }, TimeSpan.FromSeconds(10));

        string responseText = await vmessHttp.GetStringAsync("http://vrcx-test.internal:8080/ping");
        await serverTask;

        Assert.Equal("VMESS_PONG", responseText);
        Assert.Equal("vrcx-test.internal", capturedTargetHost);
        Assert.Equal(8080, capturedTargetPort);
        Assert.Contains("GET /ping HTTP/1.1", capturedHttpReq);
    }

    [Fact]
    public async Task HttpSyncClient_OmitsDeviceNameWhenBlank_AndUsesWebAuthoritativeDeviceName()
    {
        var defaultCfg = new AgentConfig();
        Assert.Equal(string.Empty, defaultCfg.DeviceName);

        string? capturedBody = null;
        using var handler = new StubHttpHandler(async (req) =>
        {
            capturedBody = await req.Content!.ReadAsStringAsync();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"ok\":true,\"data\":{\"deviceId\":\"win-web-01\",\"deviceName\":\"网页端设置的电脑\",\"syncIntervalSeconds\":90,\"syncedAt\":\"2026-11-24T01:05:00Z\",\"ingest\":{\"inserted\":0,\"skipped\":0},\"pendingCommands\":[]}}",
                    Encoding.UTF8,
                    "application/json")
            };
        });
        using var http = new HttpClient(handler);
        var client = new HttpSyncClient(http);

        var (ok, _, res) = await client.TestConnectionAsync(
            "https://vrcx-cloud.example.workers.dev",
            "vrcx_sync_key_abc",
            "win-local-id",
            string.Empty,
            proxyEnabled: false,
            proxyAddress: string.Empty,
            CancellationToken.None);

        Assert.True(ok);
        Assert.NotNull(res);
        Assert.Equal("网页端设置的电脑", res!.DeviceName);
        Assert.NotNull(capturedBody);
        Assert.DoesNotContain("\"deviceName\"", capturedBody);

        string? prevLang = AgentStrings.LanguageOverride;
        try
        {
            AgentStrings.LanguageOverride = "zh-CN";
            Assert.Contains("网页端设置的电脑", AgentStrings.FormatWebDeviceAndScheduleHint(res.DeviceName, 90));
            Assert.Contains("网页端统一控制", AgentStrings.FormatWebDeviceAndScheduleHint(string.Empty, 60));
            // Verify UI labels contain no parenthetical descriptions
            Assert.DoesNotContain("（", AgentStrings.CloudUrlLabel);
            Assert.DoesNotContain("（", AgentStrings.SyncSecretLabel);
            Assert.DoesNotContain("（", AgentStrings.NetworkGroupTitle);
            Assert.DoesNotContain("（", AgentStrings.OverseasDirectRadio);
            Assert.DoesNotContain("（", AgentStrings.MainlandProxyRadio);
            Assert.DoesNotContain("（", AgentStrings.ProxyAddressLabel);
            Assert.DoesNotContain("（", AgentStrings.SyncScreenshotsCheckbox);
            Assert.DoesNotContain("（", AgentStrings.CompressScreenshotsCheckbox);
            Assert.DoesNotContain("（", AgentStrings.AutoStartCheckbox);
            Assert.DoesNotContain("（", AgentStrings.AutoCheckUpdatesCheckbox);
        }
        finally
        {
            AgentStrings.LanguageOverride = prevLang;
        }
    }

    [Fact]
    public async Task VmessTcpHttpObfuscation_TunnelsHttpEndToEnd_AndInstallerCleanupRemovesOldExes()
    {
        // 1. Parse VMess tcp/http with comma-separated obfuscation hosts + Shadowrocket obfs=http
        string uuid = "de305d54-75b4-431b-adb2-eb6b9e546014";
        Assert.True(VmessConfig.TryParseUuidBigEndian(uuid, out byte[] uuidBytes));
        byte[] cmdKey = VmessAeadClient.ComputeCmdKey(uuidBytes);
        byte[] authKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("AES Auth ID Encryption"));

        string compactHttp = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes($"auto:{uuid}@127.0.0.1:80"))
            + "?obfs=http&obfsParam=a.cdn.test,b.cdn.test&path=/obfs";
        Assert.True(VmessConfig.TryParse(compactHttp, out VmessConfig? compactCfg, out _));
        Assert.Equal("tcp", compactCfg!.Network);
        Assert.Equal("http", compactCfg.HeaderType);
        Assert.Equal("a.cdn.test", compactCfg.EffectiveHttpHeaderHost);
        Assert.Equal("/obfs", compactCfg.EffectiveWsPath);

        // 2. End-to-end loopback VMess tcp/http server verifying HTTP request obfuscation + response header stripping
        using var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int serverPort = ((IPEndPoint)listener.LocalEndpoint).Port;

        string tcpHttpJson = $"{{\"v\":\"2\",\"ps\":\"AirportTcpHttp\",\"add\":\"127.0.0.1\",\"port\":{serverPort},\"id\":\"{uuid}\",\"aid\":0,\"scy\":\"auto\",\"net\":\"tcp\",\"type\":\"http\",\"host\":\"a.obfs.example,b.obfs.example\",\"path\":\"/ray\",\"tls\":\"\"}}";
        string tcpHttpLink = "vmess://" + Convert.ToBase64String(Encoding.UTF8.GetBytes(tcpHttpJson));
        Assert.True(ProxyHttpClientFactory.NormalizeAndValidateProxyUri(tcpHttpLink).Ok);

        string? capturedObfsHeader = null;
        Task serverTask = Task.Run(async () =>
        {
            using var tcpClient = await listener.AcceptTcpClientAsync();
            using var net = tcpClient.GetStream();

            // Read until CRLFCRLF (HTTP obfuscation request header)
            using var hdrMs = new MemoryStream();
            byte[] one = new byte[1];
            byte[] tail = new byte[4];
            int matched = 0;
            while (matched < 4)
            {
                int r = await net.ReadAsync(one.AsMemory(0, 1));
                if (r == 0) throw new EndOfStreamException();
                hdrMs.WriteByte(one[0]);
                tail[0] = tail[1]; tail[1] = tail[2]; tail[2] = tail[3]; tail[3] = one[0];
                if (tail[0] == '\r' && tail[1] == '\n' && tail[2] == '\r' && tail[3] == '\n') matched = 4;
            }
            capturedObfsHeader = Encoding.ASCII.GetString(hdrMs.ToArray());

            static async Task<byte[]> ReadExact(Stream s, int n)
            {
                byte[] buf = new byte[n];
                int total = 0;
                while (total < n)
                {
                    int r = await s.ReadAsync(buf.AsMemory(total, n - total));
                    if (r == 0) throw new EndOfStreamException();
                    total += r;
                }
                return buf;
            }

            byte[] reqAuthId = await ReadExact(net, 16);
            byte[] encLen = await ReadExact(net, 18);
            byte[] reqNonce = await ReadExact(net, 8);

            byte[] lKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key_Length"), reqAuthId, reqNonce);
            byte[] lIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce_Length"), reqAuthId, reqNonce)[..12];
            ushort headerLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(
                VmessAeadClient.AesGcmOpen(lKey, lIv, encLen, reqAuthId));

            byte[] encHdr = await ReadExact(net, headerLen + 16);
            byte[] hKey = VmessAeadClient.Kdf16(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Key"), reqAuthId, reqNonce);
            byte[] hIv = VmessAeadClient.Kdf(cmdKey, Encoding.ASCII.GetBytes("VMess Header AEAD Nonce"), reqAuthId, reqNonce)[..12];
            byte[] hdr = VmessAeadClient.AesGcmOpen(hKey, hIv, encHdr, reqAuthId);

            byte[] reqBodyIv = hdr[1..17];
            byte[] reqBodyKey = hdr[17..33];
            byte respAuthV = hdr[33];

            // Consume first encrypted HTTP request chunk
            ushort chunkLen = System.Buffers.Binary.BinaryPrimitives.ReadUInt16BigEndian(await ReadExact(net, 2));
            _ = await ReadExact(net, chunkLen);

            // Prefix response with fake HTTP/1.1 200 OK header just like Xray-core TCP/HTTP server
            byte[] fakeRespHeader = Encoding.ASCII.GetBytes(
                "HTTP/1.1 200 OK\r\nCache-Control: private\r\nContent-Type: application/octet-stream\r\n\r\n");
            await net.WriteAsync(fakeRespHeader);

            byte[] respBodyKey = System.Security.Cryptography.SHA256.HashData(reqBodyKey)[..16];
            byte[] respBodyIv = System.Security.Cryptography.SHA256.HashData(reqBodyIv)[..16];
            byte[] rLenKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Len Key"));
            byte[] rLenIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header Len IV"))[..12];
            byte[] rHdrKey = VmessAeadClient.Kdf16(respBodyKey, Encoding.ASCII.GetBytes("AEAD Resp Header Key"));
            byte[] rHdrIv = VmessAeadClient.Kdf(respBodyIv, Encoding.ASCII.GetBytes("AEAD Resp Header IV"))[..12];

            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rLenKey, rLenIv, new byte[] { 0x00, 0x04 }, ReadOnlySpan<byte>.Empty));
            await net.WriteAsync(VmessAeadClient.AesGcmSeal(rHdrKey, rHdrIv, new byte[] { respAuthV, 0x00, 0x00, 0x00 }, ReadOnlySpan<byte>.Empty));

            byte[] httpBody = Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\nVMESS_HTTP_OBFS_OK");
            byte[] respChunkIv0 = new byte[12];
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv0, 2, 10);
            byte[] sealedResp = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv0, httpBody, ReadOnlySpan<byte>.Empty);
            byte[] respFrame = new byte[2 + sealedResp.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(respFrame.AsSpan(0, 2), (ushort)sealedResp.Length);
            Buffer.BlockCopy(sealedResp, 0, respFrame, 2, sealedResp.Length);
            await net.WriteAsync(respFrame);

            byte[] respChunkIv1 = new byte[12];
            respChunkIv1[1] = 1;
            Buffer.BlockCopy(respBodyIv, 2, respChunkIv1, 2, 10);
            byte[] sealedEof = VmessAeadClient.AesGcmSeal(respBodyKey, respChunkIv1, ReadOnlySpan<byte>.Empty, ReadOnlySpan<byte>.Empty);
            byte[] eofFrame = new byte[2 + sealedEof.Length];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(eofFrame.AsSpan(0, 2), (ushort)sealedEof.Length);
            Buffer.BlockCopy(sealedEof, 0, eofFrame, 2, sealedEof.Length);
            await net.WriteAsync(eofFrame);
            await net.FlushAsync();
        });

        using HttpClient vmessHttp = ProxyHttpClientFactory.CreateHttpClient(new AgentConfig
        {
            ProxyEnabled = true,
            ProxyAddress = tcpHttpLink
        }, TimeSpan.FromSeconds(10));

        string responseText = await vmessHttp.GetStringAsync("http://vrcx-obfs.internal:80/test");
        await serverTask;

        Assert.Equal("VMESS_HTTP_OBFS_OK", responseText);
        Assert.NotNull(capturedObfsHeader);
        Assert.StartsWith("GET /ray HTTP/1.1\r\n", capturedObfsHeader);
        Assert.Contains("Host: a.obfs.example\r\n", capturedObfsHeader);

        // 3. Verify AgentUpdater.CleanupOldInstallers removes leftover .exe and .part files cleanly
        string tempUpdatesDir = Path.Combine(Path.GetTempPath(), "vrcx-cleanup-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempUpdatesDir);
        try
        {
            string oldExe = Path.Combine(tempUpdatesDir, "VRCX.Agent-v1.6.0-Setup-win-x64.exe");
            string stalePart = Path.Combine(tempUpdatesDir, "VRCX.Agent-v1.7.0-Setup-win-x64.exe.part");
            string keepNote = Path.Combine(tempUpdatesDir, "keep.txt");
            await File.WriteAllBytesAsync(oldExe, new byte[] { 1, 2, 3 });
            await File.WriteAllBytesAsync(stalePart, new byte[] { 4, 5, 6 });
            await File.WriteAllTextAsync(keepNote, "keep");

            int removed = AgentUpdater.CleanupOldInstallers(tempUpdatesDir);
            Assert.Equal(2, removed);
            Assert.False(File.Exists(oldExe));
            Assert.False(File.Exists(stalePart));
            Assert.True(File.Exists(keepNote));
        }
        finally
        {
            if (Directory.Exists(tempUpdatesDir)) Directory.Delete(tempUpdatesDir, recursive: true);
        }
    }

    [Fact]
    public async Task ScreenshotPipeline_UploadsEachPhotoStrictlyOnceAcrossRestartsAndCompressionSwitch()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), "vrcx-shot-dedupe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        try
        {
            string pngPath = Path.Combine(tempDir, "VRChat_2026-11-24_06-00-00.000_1920x1080.png");
            string copiedPath = Path.Combine(tempDir, "renamed_copy.png");
            using (var img = new Image<Rgba32>(16, 16, new Rgba32(120, 180, 240, 255)))
            {
                img.SaveAsPng(pngPath);
            }
            File.Copy(pngPath, copiedPath);

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_test_secret_key",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };

            int uploadCount = 0;
            string? firstUploadedUrl = null;
            using var http = new HttpClient(new StubHttpHandler(req =>
            {
                Interlocked.Increment(ref uploadCount);
                firstUploadedUrl ??= req.RequestUri?.AbsoluteUri;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"duplicate\":false}}", Encoding.UTF8, "application/json")
                });
            }));

            var task = new PendingScreenshotTask
            {
                LocalPath = pngPath,
                TakenAtIso = "2026-11-24T06:00:00.000Z",
                WorldId = "wrld_once",
                WorldName = "Once World"
            };

            // 1. First upload sends exactly 1 PUT request and persists ledger
            var pipeline1 = new ScreenshotPipeline(() => cfg, http, tempDir);
            Assert.False(pipeline1.HasAlreadyUploaded(pngPath));
            Assert.True(await pipeline1.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);
            Assert.True(pipeline1.HasAlreadyUploaded(pngPath));

            // 2. Immediate retry on same pipeline sends 0 extra PUT requests
            Assert.True(await pipeline1.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);

            // 3. New pipeline instance (simulating agent restart) + compression toggled ON still skips upload
            cfg.CompressScreenshots = true;
            var pipeline2 = new ScreenshotPipeline(() => cfg, http, tempDir);
            Assert.True(pipeline2.HasAlreadyUploaded(pngPath));
            Assert.True(await pipeline2.UploadQueuedTaskAsync(task, CancellationToken.None));
            Assert.Equal(1, uploadCount);

            // 4. Renamed copy with identical file bytes is caught by source-file SHA-256 deduplication -> 0 extra PUTs
            var renamedTask = new PendingScreenshotTask
            {
                LocalPath = copiedPath,
                TakenAtIso = "2026-11-24T06:00:00.000Z",
                WorldId = "wrld_once",
                WorldName = "Once World"
            };
            Assert.True(await pipeline2.UploadQueuedTaskAsync(renamedTask, CancellationToken.None));
            Assert.Equal(1, uploadCount);
            Assert.NotNull(firstUploadedUrl);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public async Task ScreenshotPipeline_ScansHistoricalPhotosReadsConfigAndExistingMetadataOnceOnly()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-hist-scan-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "vrc-log");
        string customPhotosDir = Path.Combine(tempRoot, "MyCustomPhotos");
        string monthDir = Path.Combine(customPhotosDir, "2026-11");
        string printsDir = Path.Combine(customPhotosDir, "Prints");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(monthDir);
        Directory.CreateDirectory(printsDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            // 1. VRChat config.json picture_output_folder takes precedence
            await File.WriteAllTextAsync(
                Path.Combine(logDir, "config.json"),
                Newtonsoft.Json.JsonConvert.SerializeObject(new { picture_output_folder = customPhotosDir }),
                Encoding.UTF8);
            Assert.Equal(customPhotosDir, ScreenshotPipeline.ResolveVrChatPhotosDirectory(logDir));

            // 2. Create two historical VRChat photos (one with embedded VRCX PNG metadata) + one Print that must be ignored
            string olderPhoto = Path.Combine(monthDir, "VRChat_2026-11-10_08-15-30.500_1920x1080.png");
            string newerPhoto = Path.Combine(monthDir, "VRChat_2026-11-24_21-35-00.000_1920x1080.png");
            string ignoredPrint = Path.Combine(printsDir, "VRChat_2026-11-24_22-00-00.000_1920x1080.png");

            using (var img = new Image<Rgba32>(20, 20, new Rgba32(10, 20, 30, 255)))
            {
                img.SaveAsPng(olderPhoto);
            }
            using (var img = new Image<Rgba32>(20, 20, new Rgba32(200, 100, 50, 255)))
            {
                img.SaveAsPng(newerPhoto);
            }
            using (var img = new Image<Rgba32>(20, 20, new Rgba32(99, 99, 99, 255)))
            {
                img.SaveAsPng(ignoredPrint);
            }

            ScreenshotPipeline.WriteVrcxPngMetadata(newerPhoto, new ScreenshotMetaPayload
            {
                WorldId = "wrld_sakura_123",
                WorldName = "Sakura Shrine",
                InstanceId = "12345"
            });

            var cfg = new AgentConfig
            {
                CloudUrl = "https://vrcx.example.workers.dev",
                SyncSecret = "vrcx_sync_test_secret_key",
                AutoUploadScreenshots = true,
                CompressScreenshots = false
            };

            int putCount = 0;
            using var http = new HttpClient(new StubHttpHandler(_ =>
            {
                Interlocked.Increment(ref putCount);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"ok\":true,\"data\":{\"duplicate\":false}}", Encoding.UTF8, "application/json")
                });
            }));

            var pipeline = new ScreenshotPipeline(() => cfg, http, stateDir);
            List<PendingScreenshotTask> scanned = pipeline.ScanUnsyncedScreenshots(customPhotosDir, maxResults: 50);

            // Must find both VRChat photos newest-first, ignore Prints/, parse exact timestamps, and extract WorldName
            Assert.Equal(2, scanned.Count);
            Assert.Equal(newerPhoto, scanned[0].LocalPath);
            Assert.Equal(olderPhoto, scanned[1].LocalPath);
            Assert.Equal("Sakura Shrine", scanned[0].WorldName);
            Assert.Equal("wrld_sakura_123", scanned[0].WorldId);

            DateTimeOffset parsedNewerLocal = DateTimeOffset.Parse(scanned[0].TakenAtIso).ToLocalTime();
            Assert.Equal(2026, parsedNewerLocal.Year);
            Assert.Equal(11, parsedNewerLocal.Month);
            Assert.Equal(24, parsedNewerLocal.Day);
            Assert.Equal(21, parsedNewerLocal.Hour);
            Assert.Equal(35, parsedNewerLocal.Minute);

            // Uploading both marks them persisted so a second scan returns 0 items
            foreach (PendingScreenshotTask t in scanned)
            {
                Assert.True(await pipeline.UploadQueuedTaskAsync(t, CancellationToken.None));
            }
            Assert.Equal(2, putCount);
            Assert.Empty(pipeline.ScanUnsyncedScreenshots(customPhotosDir, maxResults: 50));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CommandValidator_AcceptsFullVrChatInviteLaunchUrlsAndRejectsInjection()
    {
        Assert.True(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)"));
        Assert.True(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?ref=vrcx.app&id=wrld_12345678-1234-1234-1234-1234567890ab:12345~private(usr_abc)&shortName=abc123&attach=1"));

        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?ref=vrcx.app&shortName=abc123")); // missing id
        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345&evil=1")); // unknown param
        Assert.False(CommandValidator.IsValidLaunchUrl(
            "vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345 --no-vr")); // whitespace injection
    }

    [Fact]
    public void LogTailCollector_BackfillsHistoricalOutputLogsOnceWithoutPollutingLiveParser()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-hist-logs-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);

        try
        {
            string olderLog = Path.Combine(logDir, "output_log_2026-11-20_10-00-00.txt");
            string newerLog = Path.Combine(logDir, "output_log_2026-11-24_20-00-00.txt");

            File.WriteAllLines(olderLog, new[]
            {
                "2026.11.20 10:01:00 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:1001",
                "2026.11.20 10:01:02 Log        -  [Behaviour] Entering Room: Old Memory Shrine",
                "2026.11.20 10:02:00 Log        -  [Behaviour] OnPlayerJoined OldFriend (usr_11111111-1111-1111-1111-111111111111)",
                @"2026.11.20 10:03:00 Log        -  [VRC Camera] Took screenshot to: C:\old_shot.png"
            });
            File.SetLastWriteTimeUtc(olderLog, new DateTime(2026, 11, 20, 10, 5, 0, DateTimeKind.Utc));

            File.WriteAllLines(newerLog, new[]
            {
                "2026.11.24 20:01:00 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002",
                "2026.11.24 20:01:02 Log        -  [Behaviour] Entering Room: Live Current World"
            });
            File.SetLastWriteTimeUtc(newerLog, new DateTime(2026, 11, 24, 20, 5, 0, DateTimeKind.Utc));

            int liveScreenshotCallbacks = 0;
            var collector1 = new LogTailCollector(stateDir);
            collector1.ScreenshotCaptured += _ => liveScreenshotCallbacks++;

            int parsed = collector1.PollLogDirectory(logDir);
            Assert.Equal(4, parsed); // Old Memory Shrine + OldFriend + Screenshot event + Live Current World
            // Historical log screenshot must NOT trigger live ScreenshotCaptured callback
            Assert.Equal(0, liveScreenshotCallbacks);
            // Live parser must reflect ONLY the newest active log file, not polluted by older logs
            Assert.Equal("Live Current World", collector1.Parser.CurrentWorldName);
            Assert.Equal(0, collector1.Parser.CurrentPlayerCount);

            List<GameLogEventItem> queued = collector1.PeekBatch(20);
            Assert.Contains(queued, e => e.Type == "Location" && e.WorldName == "Old Memory Shrine");
            Assert.Contains(queued, e => e.Type == "OnPlayerJoined" && e.DisplayName == "OldFriend");
            Assert.Contains(queued, e => e.Type == "Location" && e.WorldName == "Live Current World");

            // Polling again (including after restart with a fresh LogTailCollector) must NOT re-read historical logs
            Assert.Equal(0, collector1.PollLogDirectory(logDir));
            var collector2 = new LogTailCollector(stateDir);
            Assert.Equal(0, collector2.PollLogDirectory(logDir));

            // Appending a new line to the latest log is still picked up cleanly
            File.AppendAllLines(newerLog, new[]
            {
                "2026.11.24 20:06:00 Log        -  [Behaviour] OnPlayerJoined LiveBuddy (usr_22222222-2222-2222-2222-222222222222)"
            });
            Assert.Equal(1, collector2.PollLogDirectory(logDir));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void LocalProcessMonitor_SelectsEarliestStartTimeAndSerializesStateTimestamps()
    {
        var older = new DateTimeOffset(2026, 11, 24, 1, 15, 0, TimeSpan.Zero);
        var newer = new DateTimeOffset(2026, 11, 24, 2, 30, 0, TimeSpan.Zero);
        var prev = new DateTimeOffset(2026, 11, 24, 2, 0, 0, TimeSpan.Zero);
        var fallbackNow = new DateTimeOffset(2026, 11, 24, 3, 0, 0, TimeSpan.Zero);

        // Prefers earliest valid OS process start timestamp
        Assert.Equal(older, LiveAgentState.SelectEarliestStartTimeUtc(new[] { newer, older }, prev, fallbackNow));
        // Falls back to previously observed start timestamp when Win32 handle permissions restrict reads
        Assert.Equal(prev, LiveAgentState.SelectEarliestStartTimeUtc(Array.Empty<DateTimeOffset>(), prev, fallbackNow));
        // Falls back to detection time only when no prior timestamp exists
        Assert.Equal(fallbackNow, LiveAgentState.SelectEarliestStartTimeUtc(Array.Empty<DateTimeOffset>(), null, fallbackNow));

        var liveState = new LiveAgentState
        {
            VrcRunning = true,
            VrcStartedAt = older.ToString("O"),
            SteamVrRunning = true,
            SteamVrStartedAt = prev.ToString("O")
        };
        string json = JsonConvert.SerializeObject(liveState);
        Assert.Contains("\"vrcStartedAt\":\"2026-11-24T01:15:00.0000000+00:00\"", json);
        Assert.Contains("\"steamVrStartedAt\":\"2026-11-24T02:00:00.0000000+00:00\"", json);
    }

    [Fact]
    public void VrcLogParser_HandlesRealVrChatEnteringBeforeJoiningOrder_OnLeftRoom_AndStartupWarmup()
    {
        var parser = new VrcLogParser();

        // Real VRChat output_log order: Entering Room precedes Joining (matching Dotnet/LogWatcher.cs)
        Assert.Null(parser.ParseLine("2026.11.24 14:00:01 Log        -  [Behaviour] Entering Room: VRChat Home"));
        GameLogEventItem? room1 = parser.ParseLine("2026.11.24 14:00:01 Log        -  [Behaviour] Joining wrld_11111111-1111-1111-1111-111111111111:1001~private(usr_self)");
        Assert.NotNull(room1);
        Assert.Equal("Location", room1!.Type);
        Assert.Equal("wrld_11111111-1111-1111-1111-111111111111:1001~private(usr_self)", room1.Location);
        Assert.Equal("VRChat Home", room1.WorldName);

        parser.ParseLine("2026.11.24 14:00:05 Log        -  [Behaviour] OnPlayerJoined Alice (usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)");
        parser.ParseLine("2026.11.24 14:00:06 Log        -  [Behaviour] OnPlayerJoined Bob (usr_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)");
        Assert.Equal(2, parser.CurrentPlayerCount);
        List<AgentPlayerSnapshot> details = parser.SnapshotCurrentPlayerDetails();
        Assert.Equal(2, details.Count);
        Assert.Contains(details, p => p.DisplayName == "Alice" && p.UserId == "usr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" && !string.IsNullOrEmpty(p.JoinedAt));

        // OnLeftRoom clears current room players cleanly
        Assert.Null(parser.ParseLine("2026.11.24 14:05:00 Debug      -  [Behaviour] OnLeftRoom"));
        Assert.Equal(0, parser.CurrentPlayerCount);

        // Entering second room must pair Room 2's name with Room 2's location (never Room 1's location)
        Assert.Null(parser.ParseLine("2026.11.24 14:05:05 Log        -  [Behaviour] Entering Room: Sakura Shrine"));
        GameLogEventItem? room2 = parser.ParseLine("2026.11.24 14:05:05 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)");
        Assert.NotNull(room2);
        Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)", room2!.Location);
        Assert.Equal("Sakura Shrine", room2.WorldName);

        // Verify LogTailCollector warms up live room & player state on Agent restart without re-enqueueing events
        string tempRoot = Path.Combine(Path.GetTempPath(), "vrcx-warmup-test-" + Guid.NewGuid().ToString("N"));
        string logDir = Path.Combine(tempRoot, "logs");
        string stateDir = Path.Combine(tempRoot, "state");
        Directory.CreateDirectory(logDir);
        Directory.CreateDirectory(stateDir);
        try
        {
            string logFile = Path.Combine(logDir, "output_log_2026-11-24_14-00-00.txt");
            File.WriteAllLines(logFile, new[]
            {
                "2026.11.24 14:05:05 Log        -  [Behaviour] Entering Room: Sakura Shrine",
                "2026.11.24 14:05:05 Log        -  [Behaviour] Joining wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)",
                "2026.11.24 14:05:08 Log        -  [Behaviour] OnPlayerJoined Charlie (usr_cccccccc-cccc-cccc-cccc-cccccccccccc)"
            });

            var c1 = new LogTailCollector(stateDir);
            Assert.Equal(2, c1.PollLogDirectory(logDir));
            c1.AcknowledgeBatch(2);

            // Simulate Agent restart: fresh collector sees cursor at EOF, warms up Parser state, enqueues 0 duplicates
            var c2 = new LogTailCollector(stateDir);
            Assert.Equal(0, c2.PollLogDirectory(logDir));
            Assert.Equal(0, c2.OfflineQueueCount);
            Assert.Equal("wrld_22222222-2222-2222-2222-222222222222:2002~region(jp)", c2.Parser.CurrentLocation);
            Assert.Equal("Sakura Shrine", c2.Parser.CurrentWorldName);
            Assert.Equal(1, c2.Parser.CurrentPlayerCount);
            Assert.Contains(c2.Parser.SnapshotCurrentPlayerDetails(), p => p.UserId == "usr_cccccccc-cccc-cccc-cccc-cccccccccccc");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    private sealed class StubHttpHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _responder;
        public StubHttpHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> responder) => _responder = responder;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            _responder(request);
    }
}
