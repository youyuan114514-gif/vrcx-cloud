using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace VRCX.Agent.Core;

/// <summary>
/// Metadata describing the latest VRCX.Agent release published on GitHub Releases.
/// </summary>
public sealed class AgentReleaseInfo
{
    public string TagName { get; set; } = string.Empty;
    public string VersionText { get; set; } = string.Empty;
    public string HtmlUrl { get; set; } = AgentUpdater.ReleasesPageUrl;
    public string SetupFileName { get; set; } = string.Empty;
    public string SetupDownloadUrl { get; set; } = string.Empty;
    public string ExpectedSha256 { get; set; } = string.Empty;
    public long FileSizeBytes { get; set; }
    public string ReleaseNotes { get; set; } = string.Empty;
    public bool IsUpdateAvailable { get; set; }
    public bool UsedFallbackRedirect { get; set; }
}

/// <summary>
/// Checks GitHub Releases (`nuomew/VRCX-Worker`) for newer VRCX.Agent versions, falls back cleanly
/// to the web `/releases/latest` redirect when anonymous `api.github.com` hits shared-IP rate limits,
/// and downloads + SHA-256-verifies the official Windows Setup installer from trusted GitHub hosts only.
/// </summary>
public sealed class AgentUpdater
{
    public const string RepoOwner = "nuomew";
    public const string RepoName = "VRCX-Worker";
    public const string ReleasesPageUrl = "https://github.com/nuomew/VRCX-Worker/releases";
    public const string LatestApiUrl = "https://api.github.com/repos/nuomew/VRCX-Worker/releases/latest";
    public const string LatestWebRedirectUrl = "https://github.com/nuomew/VRCX-Worker/releases/latest";

    private static readonly Regex SemVerRegex = new(@"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TagInUrlRegex = new(@"/releases/tag/(v?\d+\.\d+\.\d+)(?:[/?#]|$)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex SafeAssetFileNameRegex = new(@"^[A-Za-z0-9._-]+\.exe$", RegexOptions.Compiled);
    private static readonly Regex Sha256HexRegex = new(@"^[0-9a-f]{64}$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly string[] TrustedDownloadHostSuffixes =
    {
        "github.com",
        "githubusercontent.com"
    };

    private readonly Func<HttpClient> _httpProvider;
    private readonly Func<HttpClient>? _downloadHttpFactory;

    public AgentUpdater(HttpClient httpClient)
    {
        _httpProvider = () => httpClient;
        _downloadHttpFactory = null;
    }

    public AgentUpdater(Func<HttpClient> httpProvider, Func<HttpClient> downloadHttpFactory)
    {
        _httpProvider = httpProvider;
        _downloadHttpFactory = downloadHttpFactory;
    }

    /// <summary>
    /// Parses a semantic version tag (e.g. "v1.4.0" or "1.4.0") into a 3-part System.Version.
    /// </summary>
    public static bool TryParseSemVer(string? raw, out Version? version)
    {
        version = null;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }
        Match m = SemVerRegex.Match(raw.Trim());
        if (!m.Success)
        {
            return false;
        }
        if (int.TryParse(m.Groups[1].Value, out int major) &&
            int.TryParse(m.Groups[2].Value, out int minor) &&
            int.TryParse(m.Groups[3].Value, out int patch))
        {
            version = new Version(major, minor, patch);
            return true;
        }
        return false;
    }

    /// <summary>
    /// Returns true strictly when latestTag represents a newer major.minor.patch than currentVersion.
    /// </summary>
    public static bool IsNewerVersion(string? currentVersion, string? latestTag)
    {
        if (!TryParseSemVer(currentVersion, out Version? cur) ||
            !TryParseSemVer(latestTag, out Version? latest) ||
            cur == null || latest == null)
        {
            return false;
        }
        return latest > cur;
    }

    /// <summary>
    /// Enforces HTTPS and a strict GitHub host allowlist for installer downloads.
    /// </summary>
    public static bool IsTrustedDownloadUrl(string? rawUrl)
    {
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return false;
        }
        if (!Uri.TryCreate(rawUrl.Trim(), UriKind.Absolute, out Uri? uri))
        {
            return false;
        }
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        string host = uri.Host.ToLowerInvariant();
        foreach (string suffix in TrustedDownloadHostSuffixes)
        {
            if (host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Extracts a 64-char SHA-256 hex digest associated with a specific asset filename from Release Notes or HTML.
    /// </summary>
    public static string ExtractSha256FromText(string? text, string assetFileName)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(assetFileName))
        {
            return string.Empty;
        }
        string escapedName = Regex.Escape(assetFileName);
        var pattern = new Regex(
            escapedName + @"[^\r\n]{0,80}?\b([0-9a-fA-F]{64})\b",
            RegexOptions.IgnoreCase);
        Match m = pattern.Match(text);
        return m.Success ? m.Groups[1].Value.ToLowerInvariant() : string.Empty;
    }

    /// <summary>
    /// Parses a tag such as "v1.4.0" from a GitHub release tag URL.
    /// </summary>
    public static string ParseTagFromReleaseUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return string.Empty;
        }
        Match m = TagInUrlRegex.Match(url.Trim());
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    /// <summary>
    /// Parses a GitHub Releases API `/releases/latest` JSON payload into AgentReleaseInfo.
    /// </summary>
    public static AgentReleaseInfo? ParseReleaseApiJson(string json, string currentVersion)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }
        JObject root = JObject.Parse(json);
        string tag = root["tag_name"]?.Value<string>()?.Trim() ?? string.Empty;
        if (!TryParseSemVer(tag, out Version? latestVer) || latestVer == null)
        {
            return null;
        }

        string htmlUrl = root["html_url"]?.Value<string>()?.Trim() ?? $"{ReleasesPageUrl}/tag/{tag}";
        if (!IsTrustedDownloadUrl(htmlUrl))
        {
            htmlUrl = $"{ReleasesPageUrl}/tag/{tag}";
        }
        string body = root["body"]?.Value<string>() ?? string.Empty;

        JToken? chosenAsset = null;
        if (root["assets"] is JArray assets)
        {
            foreach (JToken asset in assets)
            {
                string name = asset["name"]?.Value<string>() ?? string.Empty;
                if (name.EndsWith("-Setup-win-x64.exe", StringComparison.OrdinalIgnoreCase) &&
                    SafeAssetFileNameRegex.IsMatch(name))
                {
                    chosenAsset = asset;
                    break;
                }
            }
            if (chosenAsset == null)
            {
                foreach (JToken asset in assets)
                {
                    string name = asset["name"]?.Value<string>() ?? string.Empty;
                    if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
                        SafeAssetFileNameRegex.IsMatch(name))
                    {
                        chosenAsset = asset;
                        break;
                    }
                }
            }
        }

        string setupName = chosenAsset?["name"]?.Value<string>()?.Trim() ?? string.Empty;
        string setupUrl = chosenAsset?["browser_download_url"]?.Value<string>()?.Trim() ?? string.Empty;
        long size = chosenAsset?["size"]?.Value<long>() ?? 0;

        if (!IsTrustedDownloadUrl(setupUrl))
        {
            setupUrl = string.Empty;
        }

        // Prefer GitHub API's native asset digest ("sha256:..."), then fall back to Release Notes checksum.
        string expectedSha = string.Empty;
        string rawDigest = chosenAsset?["digest"]?.Value<string>()?.Trim() ?? string.Empty;
        if (rawDigest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            string candidate = rawDigest.Substring("sha256:".Length).Trim().ToLowerInvariant();
            if (Sha256HexRegex.IsMatch(candidate))
            {
                expectedSha = candidate;
            }
        }
        if (string.IsNullOrEmpty(expectedSha) && !string.IsNullOrEmpty(setupName))
        {
            expectedSha = ExtractSha256FromText(body, setupName);
        }

        return new AgentReleaseInfo
        {
            TagName = tag,
            VersionText = latestVer.ToString(3),
            HtmlUrl = htmlUrl,
            SetupFileName = setupName,
            SetupDownloadUrl = setupUrl,
            ExpectedSha256 = expectedSha,
            FileSizeBytes = size,
            ReleaseNotes = body,
            IsUpdateAvailable = IsNewerVersion(currentVersion, tag),
            UsedFallbackRedirect = false
        };
    }

    /// <summary>
    /// Queries GitHub Releases for the latest version. Falls back to `/releases/latest` redirect
    /// when `api.github.com` is rate-limited (HTTP 403/429 on shared proxy exit IPs).
    /// </summary>
    public async Task<AgentReleaseInfo> CheckForUpdateAsync(string currentVersion, CancellationToken ct)
    {
        HttpClient http = _httpProvider();
        string userAgent = $"VRCX.Agent/{currentVersion} (+https://github.com/{RepoOwner}/{RepoName})";

        try
        {
            using var apiCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            apiCts.CancelAfter(TimeSpan.FromSeconds(10));
            using var apiReq = new HttpRequestMessage(HttpMethod.Get, LatestApiUrl);
            apiReq.Headers.TryAddWithoutValidation("User-Agent", userAgent);
            apiReq.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");

            using HttpResponseMessage apiRes = await http.SendAsync(apiReq, apiCts.Token).ConfigureAwait(false);
            if (apiRes.IsSuccessStatusCode)
            {
                string json = await apiRes.Content.ReadAsStringAsync(apiCts.Token).ConfigureAwait(false);
                AgentReleaseInfo? parsed = ParseReleaseApiJson(json, currentVersion);
                if (parsed != null)
                {
                    return parsed;
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // Fall through to web redirect check (handles shared proxy IP rate limits, slow API, or 403/429)
        }

        // Fallback: follow github.com/nuomew/VRCX-Worker/releases/latest -> /releases/tag/vX.Y.Z
        using var webReq = new HttpRequestMessage(HttpMethod.Get, LatestWebRedirectUrl);
        webReq.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        webReq.Headers.TryAddWithoutValidation("Accept", "text/html");

        using HttpResponseMessage webRes = await http.SendAsync(webReq, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        string resolvedUrl = webRes.Headers.Location?.ToString()
            ?? webRes.RequestMessage?.RequestUri?.AbsoluteUri
            ?? string.Empty;
        string tag = ParseTagFromReleaseUrl(resolvedUrl);

        string htmlBody = string.Empty;
        if (webRes.IsSuccessStatusCode)
        {
            htmlBody = await webRes.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (string.IsNullOrEmpty(tag))
            {
                tag = ParseTagFromReleaseUrl(htmlBody);
            }
        }

        if (!TryParseSemVer(tag, out Version? latestVer) || latestVer == null)
        {
            throw new InvalidOperationException(AgentStrings.UpdateCheckParseError);
        }

        string normalizedTag = tag.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? tag : "v" + tag;
        string setupFileName = $"VRCX.Agent-{normalizedTag}-Setup-win-x64.exe";
        string setupUrl = $"https://github.com/{RepoOwner}/{RepoName}/releases/download/{normalizedTag}/{setupFileName}";
        string sha = ExtractSha256FromText(htmlBody, setupFileName);

        return new AgentReleaseInfo
        {
            TagName = normalizedTag,
            VersionText = latestVer.ToString(3),
            HtmlUrl = $"{ReleasesPageUrl}/tag/{normalizedTag}",
            SetupFileName = setupFileName,
            SetupDownloadUrl = setupUrl,
            ExpectedSha256 = sha,
            FileSizeBytes = 0,
            ReleaseNotes = string.Empty,
            IsUpdateAvailable = IsNewerVersion(currentVersion, normalizedTag),
            UsedFallbackRedirect = true
        };
    }

    /// <summary>
    /// Streams the Setup installer to disk, verifies SHA-256 integrity if known, and returns the local .exe path.
    /// </summary>
    public async Task<string> DownloadAndVerifyInstallerAsync(
        AgentReleaseInfo release,
        string destinationDirectory,
        IProgress<(long DownloadedBytes, long TotalBytes)>? progress,
        CancellationToken ct)
    {
        if (!IsTrustedDownloadUrl(release.SetupDownloadUrl))
        {
            throw new InvalidOperationException(AgentStrings.UpdateUntrustedUrlError);
        }

        string fileName = string.IsNullOrWhiteSpace(release.SetupFileName)
            ? $"VRCX.Agent-{release.TagName}-Setup-win-x64.exe"
            : Path.GetFileName(release.SetupFileName);
        if (!SafeAssetFileNameRegex.IsMatch(fileName))
        {
            throw new InvalidOperationException(AgentStrings.UpdateInvalidFileNameError);
        }

        Directory.CreateDirectory(destinationDirectory);
        // Remove any previously downloaded installers or stale temporary files before downloading a new version.
        CleanupOldInstallers(destinationDirectory);
        string finalPath = Path.Combine(destinationDirectory, fileName);
        string partPath = finalPath + ".part";

        HttpClient? ownedClient = _downloadHttpFactory != null ? _downloadHttpFactory() : null;
        HttpClient client = ownedClient ?? _httpProvider();

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, release.SetupDownloadUrl);
            req.Headers.TryAddWithoutValidation("User-Agent", $"VRCX.Agent/{AgentMetadata.Version}");

            using HttpResponseMessage res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
            }

            // Re-validate final redirected host (e.g. objects.githubusercontent.com / release-assets.githubusercontent.com)
            string? finalRequestUrl = res.RequestMessage?.RequestUri?.AbsoluteUri;
            if (!string.IsNullOrEmpty(finalRequestUrl) && !IsTrustedDownloadUrl(finalRequestUrl))
            {
                throw new InvalidOperationException(AgentStrings.UpdateUntrustedUrlError);
            }

            long totalBytes = res.Content.Headers.ContentLength ?? release.FileSizeBytes;
            long downloadedBytes = 0;

            using (Stream netStream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            using (var fileStream = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            using (var sha256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                byte[] buffer = new byte[81920];
                int read;
                while ((read = await netStream.ReadAsync(buffer.AsMemory(0, buffer.Length), ct).ConfigureAwait(false)) > 0)
                {
                    await fileStream.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    sha256.AppendData(buffer, 0, read);
                    downloadedBytes += read;
                    progress?.Report((downloadedBytes, totalBytes));
                }

                string actualSha256 = Convert.ToHexString(sha256.GetHashAndReset()).ToLowerInvariant();
                if (!string.IsNullOrWhiteSpace(release.ExpectedSha256) &&
                    !string.Equals(actualSha256, release.ExpectedSha256.Trim(), StringComparison.OrdinalIgnoreCase))
                {
                    fileStream.Close();
                    TryDeleteFile(partPath);
                    throw new InvalidOperationException(AgentStrings.UpdateChecksumMismatchError);
                }
            }

            if (downloadedBytes < 1024)
            {
                TryDeleteFile(partPath);
                throw new InvalidOperationException(AgentStrings.UpdateDownloadedFileTooSmallError);
            }

            File.Move(partPath, finalPath, overwrite: true);
            return finalPath;
        }
        catch
        {
            TryDeleteFile(partPath);
            throw;
        }
        finally
        {
            ownedClient?.Dispose();
        }
    }

    /// <summary>
    /// Removes previously downloaded setup executables and partial files from the updates cache directory
    /// so completed upgrades never leave ~35MB installer files behind on disk.
    /// </summary>
    public static int CleanupOldInstallers(string updatesDirectory, string? keepFilePath = null)
    {
        if (string.IsNullOrWhiteSpace(updatesDirectory) || !Directory.Exists(updatesDirectory))
        {
            return 0;
        }

        string? keepFull = string.IsNullOrWhiteSpace(keepFilePath) ? null : Path.GetFullPath(keepFilePath);
        int deleted = 0;
        try
        {
            foreach (string file in Directory.EnumerateFiles(updatesDirectory))
            {
                string ext = Path.GetExtension(file);
                if (!string.Equals(ext, ".exe", StringComparison.OrdinalIgnoreCase) &&
                    !string.Equals(ext, ".part", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (keepFull != null &&
                    string.Equals(Path.GetFullPath(file), keepFull, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (TryDeleteFile(file))
                {
                    deleted++;
                }
            }
        }
        catch
        {
            // Directory enumeration failures are non-fatal
        }
        return deleted;
    }

    private static bool TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
                return true;
            }
        }
        catch
        {
            // Ignore cleanup failure (e.g., installer still exiting)
        }
        return false;
    }
}
