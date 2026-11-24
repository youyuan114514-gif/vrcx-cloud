using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using NLog;
using NLog.Config;
using NLog.Targets;
using VRCX.Agent.Platform;

namespace VRCX.Agent;

internal static class Program
{
    private const string SingleInstanceMutexName = @"Local\VRCX.CloudAgent.SingleInstance";
    private const string ShowSettingsEventName = @"Local\VRCX.CloudAgent.ShowSettings";

    [STAThread]
    private static void Main(string[] args)
    {
        bool isAutoStart = false;
        foreach (string arg in args)
        {
            if (string.Equals(arg, "--autostart", StringComparison.OrdinalIgnoreCase))
            {
                isAutoStart = true;
                break;
            }
        }

        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out bool createdNew);
        if (!createdNew)
        {
            // When the user manually clicks the Desktop / Start Menu shortcut while already running
            // in the tray, wake the background instance so it brings the settings dialog to front.
            if (!isAutoStart && EventWaitHandle.TryOpenExisting(ShowSettingsEventName, out EventWaitHandle? showEvent))
            {
                using (showEvent)
                {
                    showEvent.Set();
                }
            }
            return;
        }

        using var showSettingsEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSettingsEventName);
        ConfigureLogging();
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext(isAutoStart, showSettingsEvent));
    }

    private static void ConfigureLogging()
    {
        string logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VRCX-Agent",
            "logs");
        Directory.CreateDirectory(logDir);

        var config = new LoggingConfiguration();
        var fileTarget = new FileTarget("logfile")
        {
            FileName = Path.Combine(logDir, "agent.log"),
            ArchiveAboveSize = 2 * 1024 * 1024,
            MaxArchiveFiles = 3,
            Layout = "${longdate}|${level:uppercase=true}|${logger}|${message} ${exception:format=tostring}"
        };
        config.AddRule(LogLevel.Info, LogLevel.Fatal, fileTarget);
        LogManager.Configuration = config;
    }
}
