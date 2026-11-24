using System;
using System.Collections.Generic;
using System.Text;
using Newtonsoft.Json.Linq;

namespace VRCX.Agent.Core;

/// <summary>
/// Parsed VMess node configuration supporting both standard v2rayN `vmess://<base64-json>`
/// links and Shadowrocket-style `vmess://<base64(sec:uuid@host:port)>?...` links.
/// </summary>
public sealed class VmessConfig
{
    public string Remarks { get; init; } = string.Empty;
    public string Server { get; init; } = string.Empty;
    public int Port { get; init; }
    public string UserId { get; init; } = string.Empty;
    public byte[] UserIdBytes { get; init; } = Array.Empty<byte>();
    public int AlterId { get; init; }
    public string Security { get; init; } = "auto";
    public string Network { get; init; } = "tcp";
    public string HeaderType { get; init; } = "none";
    public string Host { get; init; } = string.Empty;
    public string Path { get; init; } = "/";
    public bool UseTls { get; init; }
    public string Sni { get; init; } = string.Empty;
    public string Alpn { get; init; } = string.Empty;
    public bool AllowInsecure { get; init; }

    /// <summary>
    /// Extracts the first non-empty host when a node lists comma-separated obfuscation/CDN hosts.
    /// </summary>
    public string PrimaryHost => ExtractFirstCsvValue(Host);

    public string EffectiveSni =>
        !string.IsNullOrWhiteSpace(Sni) ? Sni.Trim()
        : !string.IsNullOrWhiteSpace(PrimaryHost) ? PrimaryHost
        : Server;

    public string EffectiveWsPath
    {
        get
        {
            string p = ExtractFirstCsvValue(Path);
            if (string.IsNullOrEmpty(p)) return "/";
            return p.StartsWith("/", StringComparison.Ordinal) ? p : "/" + p;
        }
    }

    public string EffectiveHttpHeaderHost =>
        !string.IsNullOrWhiteSpace(PrimaryHost) ? PrimaryHost : Server;

    /// <summary>
    /// Maps VMess security string to wire protocol Security byte.
    /// Xray/V2Ray servers require an explicit cipher byte (never 0x00 AUTO), so "auto" resolves to AES-128-GCM (0x03).
    /// </summary>
    public byte WireSecurityByte
    {
        get
        {
            return (Security ?? "auto").Trim().ToLowerInvariant() switch
            {
                "none" => 0x05,
                "zero" => 0x06,
                // Both "auto", "aes-128-gcm", and "chacha20-poly1305" negotiate AES-128-GCM (0x03),
                // which is universally supported by all V2Ray/Xray/sing-box servers with hardware AES acceleration.
                _ => 0x03
            };
        }
    }

    public static bool IsVmessUri(string? raw)
    {
        return !string.IsNullOrWhiteSpace(raw) &&
               raw.Trim().StartsWith("vmess://", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Parses and validates a `vmess://` share link.
    /// </summary>
    public static bool TryParse(string? rawUri, out VmessConfig? config, out string error)
    {
        config = null;
        error = string.Empty;

        string trimmed = (rawUri ?? string.Empty).Trim();
        if (!IsVmessUri(trimmed))
        {
            error = AgentStrings.InvalidVmessUrlMessage;
            return false;
        }

        string body = trimmed.Substring("vmess://".Length).Trim();
        if (string.IsNullOrEmpty(body))
        {
            error = AgentStrings.InvalidVmessUrlMessage;
            return false;
        }

        // Split optional query / fragment (used by Shadowrocket-style vmess://base64?remarks=...)
        string queryPart = string.Empty;
        string fragmentRemarks = string.Empty;
        int hashIdx = body.IndexOf('#');
        if (hashIdx >= 0)
        {
            fragmentRemarks = Uri.UnescapeDataString(body.Substring(hashIdx + 1));
            body = body.Substring(0, hashIdx);
        }
        int qIdx = body.IndexOf('?');
        if (qIdx >= 0)
        {
            queryPart = body.Substring(qIdx + 1);
            body = body.Substring(0, qIdx);
        }

        if (!TryDecodeBase64Utf8(body, out string decoded))
        {
            error = AgentStrings.InvalidVmessBase64Message;
            return false;
        }

        decoded = decoded.Trim();
        if (decoded.StartsWith("{", StringComparison.Ordinal))
        {
            return TryParseV2rayNJson(decoded, fragmentRemarks, out config, out error);
        }

        return TryParseCompactFormat(decoded, queryPart, fragmentRemarks, out config, out error);
    }

    private static bool TryParseV2rayNJson(string json, string fallbackRemarks, out VmessConfig? config, out string error)
    {
        config = null;
        error = string.Empty;
        JObject obj;
        try
        {
            obj = JObject.Parse(json);
        }
        catch
        {
            error = AgentStrings.InvalidVmessJsonMessage;
            return false;
        }

        string server = ReadString(obj, "add");
        int port = ReadInt(obj, "port", 0);
        string userId = ReadString(obj, "id");
        int aid = ReadInt(obj, "aid", 0);
        string scy = ReadString(obj, "scy");
        if (string.IsNullOrEmpty(scy)) scy = ReadString(obj, "security");
        if (string.IsNullOrEmpty(scy)) scy = "auto";

        string net = ReadString(obj, "net").ToLowerInvariant();
        if (string.IsNullOrEmpty(net)) net = "tcp";

        string headerType = ReadString(obj, "type").ToLowerInvariant();
        if (string.IsNullOrEmpty(headerType)) headerType = "none";

        string host = ReadString(obj, "host");
        string path = ReadString(obj, "path");
        string tlsStr = ReadString(obj, "tls").ToLowerInvariant();
        bool useTls = tlsStr == "tls" || tlsStr == "true" || tlsStr == "1" || tlsStr == "xtls";
        string sni = ReadString(obj, "sni");
        string alpn = ReadString(obj, "alpn");
        string insecureStr = ReadString(obj, "skip-cert-verify");
        if (string.IsNullOrEmpty(insecureStr)) insecureStr = ReadString(obj, "allowInsecure");
        if (string.IsNullOrEmpty(insecureStr)) insecureStr = ReadString(obj, "insecure");
        bool allowInsecure = IsTruthy(insecureStr);
        string remarks = ReadString(obj, "ps");
        if (string.IsNullOrEmpty(remarks)) remarks = fallbackRemarks;

        return ValidateAndBuild(
            remarks, server, port, userId, aid, scy, net, headerType, host, path, useTls, sni, alpn, allowInsecure,
            out config, out error);
    }

    private static bool TryParseCompactFormat(
        string decoded,
        string queryPart,
        string fallbackRemarks,
        out VmessConfig? config,
        out string error)
    {
        config = null;
        error = string.Empty;

        // Format: security:uuid@host:port
        int atIdx = decoded.LastIndexOf('@');
        if (atIdx <= 0 || atIdx >= decoded.Length - 1)
        {
            error = AgentStrings.InvalidVmessUrlMessage;
            return false;
        }

        string left = decoded.Substring(0, atIdx);
        string right = decoded.Substring(atIdx + 1);

        int colonUser = left.IndexOf(':');
        string scy = colonUser > 0 ? left.Substring(0, colonUser).Trim() : "auto";
        string userId = colonUser > 0 ? left.Substring(colonUser + 1).Trim() : left.Trim();

        string server;
        int port;
        if (right.StartsWith("[", StringComparison.Ordinal))
        {
            int closeBracket = right.IndexOf("]:", StringComparison.Ordinal);
            if (closeBracket <= 1 || !int.TryParse(right.Substring(closeBracket + 2), out port))
            {
                error = AgentStrings.InvalidProxyPortMessage;
                return false;
            }
            server = right.Substring(1, closeBracket - 1);
        }
        else
        {
            int lastColon = right.LastIndexOf(':');
            if (lastColon <= 0 || !int.TryParse(right.Substring(lastColon + 1), out port))
            {
                error = AgentStrings.InvalidProxyPortMessage;
                return false;
            }
            server = right.Substring(0, lastColon);
        }

        var query = ParseQueryString(queryPart);
        string remarks = query.TryGetValue("remarks", out string? r) && !string.IsNullOrEmpty(r) ? r : fallbackRemarks;
        string obfs = query.TryGetValue("obfs", out string? o) ? o.ToLowerInvariant() : string.Empty;
        string net;
        string headerType = "none";
        if (obfs == "websocket" || obfs == "ws")
        {
            net = "ws";
        }
        else if (obfs == "http")
        {
            net = "tcp";
            headerType = "http";
        }
        else
        {
            net = query.TryGetValue("net", out string? n) ? n.ToLowerInvariant() : "tcp";
            if (query.TryGetValue("type", out string? ht) && !string.IsNullOrWhiteSpace(ht))
            {
                headerType = ht.Trim().ToLowerInvariant();
            }
        }
        string host = query.TryGetValue("obfsParam", out string? op) ? op : (query.TryGetValue("host", out string? h) ? h : string.Empty);
        string path = query.TryGetValue("path", out string? p) ? p : "/";
        string tlsVal = query.TryGetValue("tls", out string? t) ? t.ToLowerInvariant() : string.Empty;
        bool useTls = IsTruthy(tlsVal) || tlsVal == "tls";
        string sni = query.TryGetValue("peer", out string? peer) ? peer : (query.TryGetValue("sni", out string? s) ? s : string.Empty);
        string alpn = query.TryGetValue("alpn", out string? a) ? a : string.Empty;
        bool allowInsecure =
            (query.TryGetValue("allowInsecure", out string? ai) && IsTruthy(ai)) ||
            (query.TryGetValue("insecure", out string? ins) && IsTruthy(ins));
        int aid = query.TryGetValue("alterId", out string? aidStr) && int.TryParse(aidStr, out int parsedAid) ? parsedAid : 0;

        return ValidateAndBuild(
            remarks, server, port, userId, aid, scy, net, headerType, host, path, useTls, sni, alpn, allowInsecure,
            out config, out error);
    }

    private static bool ValidateAndBuild(
        string remarks,
        string server,
        int port,
        string userId,
        int aid,
        string scy,
        string net,
        string headerType,
        string host,
        string path,
        bool useTls,
        string sni,
        string alpn,
        bool allowInsecure,
        out VmessConfig? config,
        out string error)
    {
        config = null;
        error = string.Empty;

        server = (server ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(server))
        {
            error = AgentStrings.InvalidVmessUrlMessage;
            return false;
        }
        if (port <= 0 || port > 65535)
        {
            error = AgentStrings.InvalidProxyPortMessage;
            return false;
        }
        if (!TryParseUuidBigEndian(userId, out byte[] uuidBytes))
        {
            error = AgentStrings.InvalidVmessUuidMessage;
            return false;
        }
        if (net != "tcp" && net != "ws")
        {
            error = AgentStrings.FormatUnsupportedVmessTransport(net);
            return false;
        }
        if (net == "tcp" && !string.IsNullOrEmpty(headerType) && headerType != "none" && headerType != "http")
        {
            error = AgentStrings.FormatUnsupportedVmessTransport($"tcp/{headerType}");
            return false;
        }

        config = new VmessConfig
        {
            Remarks = (remarks ?? string.Empty).Trim(),
            Server = server,
            Port = port,
            UserId = userId.Trim(),
            UserIdBytes = uuidBytes,
            AlterId = aid,
            Security = string.IsNullOrWhiteSpace(scy) ? "auto" : scy.Trim().ToLowerInvariant(),
            Network = net,
            HeaderType = string.IsNullOrWhiteSpace(headerType) ? "none" : headerType,
            Host = (host ?? string.Empty).Trim(),
            Path = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim(),
            UseTls = useTls,
            Sni = (sni ?? string.Empty).Trim(),
            Alpn = (alpn ?? string.Empty).Trim(),
            AllowInsecure = allowInsecure
        };
        return true;
    }

    private static string ExtractFirstCsvValue(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        foreach (string part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!string.IsNullOrEmpty(part)) return part;
        }
        return string.Empty;
    }

    private static bool IsTruthy(string? raw)
    {
        string s = (raw ?? string.Empty).Trim().ToLowerInvariant();
        return s == "1" || s == "true" || s == "yes";
    }

    /// <summary>
    /// Parses a UUID string into strict RFC 4122 big-endian 16-byte array (avoiding .NET Guid mixed-endian order).
    /// </summary>
    public static bool TryParseUuidBigEndian(string? rawUuid, out byte[] bytes)
    {
        bytes = Array.Empty<byte>();
        if (string.IsNullOrWhiteSpace(rawUuid))
        {
            return false;
        }
        if (!Guid.TryParse(rawUuid.Trim(), out Guid guid))
        {
            return false;
        }
        bytes = guid.ToByteArray(bigEndian: true);
        return bytes.Length == 16;
    }

    private static bool TryDecodeBase64Utf8(string input, out string decoded)
    {
        decoded = string.Empty;
        try
        {
            // Normalize URL-safe base64 and missing padding
            string s = input.Replace('-', '+').Replace('_', '/').Replace("\r", "").Replace("\n", "").Replace(" ", "");
            int mod = s.Length % 4;
            if (mod == 2) s += "==";
            else if (mod == 3) s += "=";
            else if (mod == 1) return false;

            byte[] raw = Convert.FromBase64String(s);
            decoded = Encoding.UTF8.GetString(raw);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static Dictionary<string, string> ParseQueryString(string query)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(query)) return dict;
        foreach (string pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            string key = Uri.UnescapeDataString(pair.Substring(0, eq));
            string val = Uri.UnescapeDataString(pair.Substring(eq + 1));
            dict[key] = val;
        }
        return dict;
    }

    private static string ReadString(JObject obj, string key)
    {
        JToken? tok = obj[key];
        if (tok == null || tok.Type == JTokenType.Null) return string.Empty;
        return tok.Type == JTokenType.String ? (tok.Value<string>() ?? string.Empty).Trim() : tok.ToString().Trim();
    }

    private static int ReadInt(JObject obj, string key, int fallback)
    {
        string s = ReadString(obj, key);
        return int.TryParse(s, out int val) ? val : fallback;
    }
}
