using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace VRCX.Agent.Core;

/// <summary>
/// Defense-in-depth validator enforcing the remote command allowlist, strict vrchat://launch syntax,
/// and SSRF HTTPS host allowlist (R.A.I.L.G.U.A.R.D.).
/// </summary>
public static class CommandValidator
{
    public static readonly IReadOnlySet<string> AllowedActions = new HashSet<string>(StringComparer.Ordinal)
    {
        "launch_vrc",
        "quit_vrc",
        "clear_cache",
        "send_vr_notify",
        "discord_update",
        "sync_now"
    };

    private static readonly Regex VrcInstanceIdRegex = new(
        @"^wrld_[0-9a-f-]{36}:[A-Za-z0-9_~()\-]+$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VrcShortNameRegex = new(
        @"^[A-Za-z0-9_-]{1,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VrcRefRegex = new(
        @"^[A-Za-z0-9._-]{1,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly string[] AllowedVrcHostSuffixes =
    {
        "api.vrchat.cloud",
        "vrchat.com",
        "files.vrchat.cloud",
        "assets.vrchat.com",
        "d348imysud55la.cloudfront.net",
        "status.vrchat.com",
        "s3.amazonaws.com",
        "s3.us-east-1.amazonaws.com",
        "r2.cloudflarestorage.com",
        "api.github.com"
    };

    public static (bool Ok, string Error) ValidateRemoteCommand(string action, IDictionary<string, object?>? parameters)
    {
        if (string.IsNullOrWhiteSpace(action) || !AllowedActions.Contains(action))
        {
            return (false, $"Action '{action}' is not permitted by the agent allowlist.");
        }

        if (action == "launch_vrc")
        {
            string launchUrl = parameters != null && parameters.TryGetValue("launchUrl", out var raw)
                ? Convert.ToString(raw)?.Trim() ?? string.Empty
                : string.Empty;

            if (!IsValidLaunchUrl(launchUrl))
            {
                return (false, "launchUrl must be a valid vrchat://launch?id=wrld_<uuid>:<instance> link.");
            }
        }

        return (true, string.Empty);
    }

    public static bool IsValidLaunchUrl(string? launchUrl)
    {
        if (string.IsNullOrWhiteSpace(launchUrl) || launchUrl.Length > 512)
        {
            return false;
        }
        string trimmed = launchUrl.Trim();
        if (!trimmed.StartsWith("vrchat://launch?", StringComparison.Ordinal))
        {
            return false;
        }
        foreach (char ch in trimmed)
        {
            if (char.IsWhiteSpace(ch) || char.IsControl(ch))
            {
                return false;
            }
        }

        string query = trimmed["vrchat://launch?".Length..];
        if (string.IsNullOrEmpty(query))
        {
            return false;
        }

        bool hasId = false;
        string[] pairs = query.Split('&', StringSplitOptions.None);
        foreach (string pair in pairs)
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0) return false;
            string key = Uri.UnescapeDataString(pair[..eq]);
            string val = Uri.UnescapeDataString(pair[(eq + 1)..]);
            switch (key)
            {
                case "id":
                    if (!VrcInstanceIdRegex.IsMatch(val)) return false;
                    hasId = true;
                    break;
                case "shortName":
                    if (!VrcShortNameRegex.IsMatch(val)) return false;
                    break;
                case "ref":
                    if (!VrcRefRegex.IsMatch(val)) return false;
                    break;
                case "attach":
                    if (val != "1" && val != "0") return false;
                    break;
                default:
                    return false;
            }
        }
        return hasId;
    }

    public static bool IsAllowedVrcUrl(string? rawUrl)
    {
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return false;
        }
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out Uri? uri))
        {
            return false;
        }
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        string host = uri.Host.ToLowerInvariant();
        foreach (string suffix in AllowedVrcHostSuffixes)
        {
            if (host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }
}
