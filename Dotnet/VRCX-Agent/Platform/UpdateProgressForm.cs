using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Lightweight modal dialog showing new release details, streaming download progress,
/// and SHA-256 verification before handing off to the Inno Setup installer.
/// </summary>
public sealed class UpdateProgressForm : Form
{
    private readonly AgentReleaseInfo _release;
    private readonly AgentUpdater _updater;
    private readonly string _updatesDir;
    private readonly Label _statusLabel;
    private readonly ProgressBar _progressBar;
    private readonly Button _updateButton;
    private readonly Button _openPageButton;
    private readonly Button _cancelButton;

    private CancellationTokenSource? _downloadCts;

    /// <summary>
    /// Verified local path of the downloaded Setup executable when DialogResult == DialogResult.OK.
    /// </summary>
    public string? DownloadedInstallerPath { get; private set; }

    public UpdateProgressForm(
        AgentReleaseInfo release,
        AgentUpdater updater,
        string updatesDir,
        Icon? windowIcon = null,
        bool autoStart = false)
    {
        _release = release;
        _updater = updater;
        _updatesDir = updatesDir;

        Text = AgentStrings.UpdateDialogTitle;
        if (windowIcon != null)
        {
            Icon = windowIcon;
        }
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(468, 224);
        Font = new Font(AgentStrings.UiFontFamily, 9.5f);

        var headerLabel = new Label
        {
            Text = AgentStrings.FormatUpdateDialogHeader(AgentMetadata.Version, release.TagName),
            Location = new Point(20, 16),
            Size = new Size(428, 24),
            Font = new Font(AgentStrings.UiFontFamily, 10.5f, FontStyle.Bold)
        };

        string sizeText = release.FileSizeBytes > 0
            ? (AgentStrings.IsChinese
                ? $"，约 {release.FileSizeBytes / (1024.0 * 1024.0):F1} MB"
                : $", ~{release.FileSizeBytes / (1024.0 * 1024.0):F1} MB")
            : string.Empty;

        _statusLabel = new Label
        {
            Text = AgentStrings.FormatUpdateDialogHint(sizeText),
            Location = new Point(20, 48),
            Size = new Size(428, 56),
            ForeColor = Color.DimGray
        };

        _progressBar = new ProgressBar
        {
            Location = new Point(20, 118),
            Size = new Size(428, 22),
            Minimum = 0,
            Maximum = 100,
            Style = ProgressBarStyle.Continuous
        };

        _openPageButton = new Button
        {
            Text = AgentStrings.OpenReleasesPageButton,
            Location = new Point(20, 166),
            Width = 132,
            Height = 34
        };
        _openPageButton.Click += (_, _) => OpenReleasesPage();

        _updateButton = new Button
        {
            Text = AgentStrings.UpdateNowButton,
            Location = new Point(214, 166),
            Width = 140,
            Height = 34
        };
        _updateButton.Click += async (_, _) => await StartDownloadAsync();

        _cancelButton = new Button
        {
            Text = AgentStrings.CancelButton,
            Location = new Point(364, 166),
            Width = 84,
            Height = 34
        };
        _cancelButton.Click += (_, _) =>
        {
            _downloadCts?.Cancel();
            DialogResult = DialogResult.Cancel;
            Close();
        };

        Controls.AddRange(new Control[]
        {
            headerLabel,
            _statusLabel,
            _progressBar,
            _openPageButton,
            _updateButton,
            _cancelButton
        });
        AcceptButton = _updateButton;
        CancelButton = _cancelButton;

        if (autoStart)
        {
            Shown += async (_, _) => await StartDownloadAsync();
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _downloadCts?.Cancel();
        base.OnFormClosing(e);
    }

    private void OpenReleasesPage()
    {
        string target = AgentUpdater.IsTrustedDownloadUrl(_release.HtmlUrl)
            ? _release.HtmlUrl
            : AgentUpdater.ReleasesPageUrl;
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                UseShellExecute = true
            });
        }
        catch
        {
            // Ignore browser launch errors
        }
    }

    private async Task StartDownloadAsync()
    {
        if (string.IsNullOrWhiteSpace(_release.SetupDownloadUrl))
        {
            OpenReleasesPage();
            return;
        }

        _updateButton.Enabled = false;
        _statusLabel.ForeColor = Color.SteelBlue;
        _statusLabel.Text = AgentStrings.UpdateStartingDownload;
        _progressBar.Style = ProgressBarStyle.Marquee;

        _downloadCts?.Dispose();
        _downloadCts = new CancellationTokenSource(TimeSpan.FromMinutes(10));

        var progress = new Progress<(long DownloadedBytes, long TotalBytes)>(report =>
        {
            if (IsDisposed) return;
            double downMb = report.DownloadedBytes / (1024.0 * 1024.0);
            if (report.TotalBytes > 0)
            {
                int pct = (int)Math.Clamp((report.DownloadedBytes * 100L) / report.TotalBytes, 0, 100);
                if (_progressBar.Style != ProgressBarStyle.Continuous)
                {
                    _progressBar.Style = ProgressBarStyle.Continuous;
                }
                _progressBar.Value = pct;
                double totalMb = report.TotalBytes / (1024.0 * 1024.0);
                _statusLabel.Text = AgentStrings.FormatUpdateProgressKnown(pct, downMb, totalMb);
            }
            else
            {
                _statusLabel.Text = AgentStrings.FormatUpdateProgressUnknown(downMb);
            }
        });

        try
        {
            string installerPath = await _updater.DownloadAndVerifyInstallerAsync(
                _release,
                _updatesDir,
                progress,
                _downloadCts.Token);

            _progressBar.Style = ProgressBarStyle.Continuous;
            _progressBar.Value = 100;
            _statusLabel.ForeColor = Color.ForestGreen;
            _statusLabel.Text = AgentStrings.UpdateVerifyingAndLaunching;

            DownloadedInstallerPath = installerPath;
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (OperationCanceledException)
        {
            // Cancelled by user closing dialog
        }
        catch (Exception ex)
        {
            if (!IsDisposed)
            {
                _progressBar.Style = ProgressBarStyle.Continuous;
                _progressBar.Value = 0;
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = AgentStrings.FormatUpdateFailed(ex.Message);
                _updateButton.Enabled = true;
            }
        }
    }
}
