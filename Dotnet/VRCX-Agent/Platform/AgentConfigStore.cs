using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Newtonsoft.Json;
using NLog;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Persists VRCX.Agent sync URL and secret encrypted at rest with Windows DPAPI
/// (`DataProtectionScope.CurrentUser`) under `%LocalAppData%\VRCX-Agent\`.
/// </summary>
public sealed class AgentConfigStore
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const string RunRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunRegistryValueName = "VRCX.Agent";

    public string DataDirectory { get; }
    private readonly string _configPath;

    public AgentConfigStore(string? customDataDir = null)
    {
        DataDirectory = string.IsNullOrWhiteSpace(customDataDir)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCX-Agent")
            : customDataDir;
        Directory.CreateDirectory(DataDirectory);
        _configPath = Path.Combine(DataDirectory, "agent-config.dpapi");
    }

    public AgentConfig LoadConfig()
    {
        try
        {
            if (!File.Exists(_configPath))
            {
                return new AgentConfig();
            }
            byte[] raw = File.ReadAllBytes(_configPath);
            byte[] plain = UnprotectBytes(raw);
            return JsonConvert.DeserializeObject<AgentConfig>(Encoding.UTF8.GetString(plain)) ?? new AgentConfig();
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Could not decrypt agent config; returning default configuration.");
            return new AgentConfig();
        }
    }

    public void SaveConfig(AgentConfig config)
    {
        string json = JsonConvert.SerializeObject(config, Formatting.Indented);
        byte[] cipher = ProtectBytes(Encoding.UTF8.GetBytes(json));
        string tmp = _configPath + ".tmp";
        File.WriteAllBytes(tmp, cipher);
        File.Move(tmp, _configPath, overwrite: true);
    }

    public static bool IsAutoStartEnabled()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunRegistryPath, writable: false);
            return key?.GetValue(RunRegistryValueName) is string val && !string.IsNullOrWhiteSpace(val);
        }
        catch
        {
            return false;
        }
    }

    public static void SetAutoStartEnabled(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunRegistryPath, writable: true);
            if (key == null) return;
            if (enabled)
            {
                string? exePath = Environment.ProcessPath;
                if (!string.IsNullOrWhiteSpace(exePath))
                {
                    key.SetValue(RunRegistryValueName, $"\"{exePath}\" --autostart");
                }
            }
            else
            {
                key.DeleteValue(RunRegistryValueName, throwOnMissingValue: false);
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to update Windows startup registry entry.");
        }
    }

    private static byte[] ProtectBytes(byte[] plain)
    {
        if (OperatingSystem.IsWindows())
        {
            return ProtectedData.Protect(plain, optionalEntropy: null, DataProtectionScope.CurrentUser);
        }
        return plain;
    }

    private static byte[] UnprotectBytes(byte[] protectedBytes)
    {
        if (OperatingSystem.IsWindows())
        {
            return ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
        }
        return protectedBytes;
    }
}
