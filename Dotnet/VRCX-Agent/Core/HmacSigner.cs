using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace VRCX.Agent.Core;

/// <summary>
/// Provides SHA-256 hashing and Bearer Sync Secret header attachment for VRCX.Agent HTTP API calls.
/// </summary>
public static class HmacSigner
{
    public static string Sha256Hex(string input)
    {
        return Sha256Hex(Encoding.UTF8.GetBytes(input ?? string.Empty));
    }

    public static string Sha256Hex(byte[] bytes)
    {
        byte[] hash = SHA256.HashData(bytes ?? Array.Empty<byte>());
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// Attaches ASCII-safe Bearer Sync Secret and X-Device-Id headers to outgoing Worker API calls.
    /// Human-readable UTF-8 device names are sent in the JSON body to avoid non-ASCII HTTP header errors on Windows.
    /// </summary>
    public static void ApplySyncAuthHeaders(HttpRequestMessage request, AgentConfig config)
    {
        string secret = (config.SyncSecret ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(secret))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        }

        string deviceId = config.EnsureDeviceId();
        request.Headers.Remove("X-Device-Id");
        request.Headers.Add("X-Device-Id", deviceId);
    }
}
