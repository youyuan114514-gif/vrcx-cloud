using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Configuration dialog where users enter their VRCX Cloud URL, Sync Secret, Device Name,
/// and switch between Overseas (Direct / Proxy Off) and Mainland China (Proxy On) network modes.
/// Sync interval is controlled authoritatively by Web Cloud Settings and retrieved on connect.
/// </summary>
public sealed class SyncSettingsForm : Form
{
    private readonly AgentConfig _initialConfig;
    private readonly HttpSyncClient _syncClient;

    private readonly TextBox _urlBox;
    private readonly TextBox _secretBox;
    private readonly CheckBox _showSecretCheck;
    private readonly Label _webInfoLabel;
    private readonly RadioButton _overseasDirectRadio;
    private readonly RadioButton _mainlandProxyRadio;
    private readonly TextBox _proxyAddressBox;
    private readonly CheckBox _autoUploadScreenshotsCheck;
    private readonly CheckBox _compressScreenshotsCheck;
    private readonly CheckBox _autoStartCheck;
    private readonly CheckBox _autoCheckUpdatesCheck;
    private readonly Label _statusLabel;
    private readonly Button _saveButton;

    public AgentConfig? SavedConfig { get; private set; }
    public AgentSyncResponse? InitialSyncResponse { get; private set; }
    public bool AutoStartEnabled => _autoStartCheck.Checked;

    public SyncSettingsForm(AgentConfig currentConfig, HttpSyncClient syncClient, bool autoStartEnabled = false, Icon? windowIcon = null)
    {
        _initialConfig = currentConfig;
        _syncClient = syncClient;

        Text = AgentStrings.SettingsWindowTitle;
        if (windowIcon != null)
        {
            Icon = windowIcon;
        }
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(504, 532);
        Font = new Font(AgentStrings.UiFontFamily, 9.5f);

        var urlLabel = new Label
        {
            Text = AgentStrings.CloudUrlLabel,
            Location = new Point(20, 14),
            AutoSize = true
        };
        _urlBox = new TextBox
        {
            Location = new Point(20, 36),
            Width = 464,
            PlaceholderText = AgentStrings.CloudUrlPlaceholder,
            Text = string.IsNullOrWhiteSpace(currentConfig.CloudUrl) ? "https://" : currentConfig.CloudUrl
        };

        var secretLabel = new Label
        {
            Text = AgentStrings.SyncSecretLabel,
            Location = new Point(20, 72),
            AutoSize = true
        };
        _secretBox = new TextBox
        {
            Location = new Point(20, 94),
            Width = 388,
            UseSystemPasswordChar = true,
            Text = currentConfig.SyncSecret ?? string.Empty
        };
        _showSecretCheck = new CheckBox
        {
            Text = AgentStrings.ShowSecretCheckbox,
            Location = new Point(418, 96),
            AutoSize = true
        };
        _showSecretCheck.CheckedChanged += (_, _) =>
        {
            _secretBox.UseSystemPasswordChar = !_showSecretCheck.Checked;
        };

        // Device name & sync interval are both managed authoritatively on the Web Cloud Hub.
        _webInfoLabel = new Label
        {
            Text = AgentStrings.FormatWebDeviceAndScheduleHint(currentConfig.DeviceName, currentConfig.EffectiveSyncIntervalSeconds),
            Location = new Point(20, 128),
            Size = new Size(464, 22),
            ForeColor = Color.SteelBlue
        };

        var networkGroup = new GroupBox
        {
            Text = AgentStrings.NetworkGroupTitle,
            Location = new Point(20, 158),
            Size = new Size(464, 126)
        };

        _overseasDirectRadio = new RadioButton
        {
            Text = AgentStrings.OverseasDirectRadio,
            Location = new Point(14, 24),
            AutoSize = true,
            Checked = !currentConfig.ProxyEnabled
        };
        _mainlandProxyRadio = new RadioButton
        {
            Text = AgentStrings.MainlandProxyRadio,
            Location = new Point(230, 24),
            AutoSize = true,
            Checked = currentConfig.ProxyEnabled
        };

        var proxyLabel = new Label
        {
            Text = AgentStrings.ProxyAddressLabel,
            Location = new Point(14, 54),
            AutoSize = true
        };
        _proxyAddressBox = new TextBox
        {
            Location = new Point(14, 78),
            Width = 436,
            PlaceholderText = AgentStrings.ProxyAddressPlaceholder,
            Text = currentConfig.ProxyAddress ?? string.Empty,
            Enabled = currentConfig.ProxyEnabled
        };

        _overseasDirectRadio.CheckedChanged += (_, _) => UpdateProxyInputState();
        _mainlandProxyRadio.CheckedChanged += (_, _) => UpdateProxyInputState();

        networkGroup.Controls.AddRange(new Control[]
        {
            _overseasDirectRadio,
            _mainlandProxyRadio,
            proxyLabel,
            _proxyAddressBox
        });

        // Keep all option checkboxes strictly left-aligned at X = 20 with uniform 30px vertical rhythm.
        _autoUploadScreenshotsCheck = new CheckBox
        {
            Text = AgentStrings.SyncScreenshotsCheckbox,
            Location = new Point(20, 298),
            AutoSize = true,
            Checked = currentConfig.AutoUploadScreenshots
        };

        _compressScreenshotsCheck = new CheckBox
        {
            Text = AgentStrings.CompressScreenshotsCheckbox,
            Location = new Point(20, 328),
            AutoSize = true,
            Checked = currentConfig.CompressScreenshots,
            Enabled = currentConfig.AutoUploadScreenshots
        };
        _autoUploadScreenshotsCheck.CheckedChanged += (_, _) =>
        {
            _compressScreenshotsCheck.Enabled = _autoUploadScreenshotsCheck.Checked;
        };

        _autoStartCheck = new CheckBox
        {
            Text = AgentStrings.AutoStartCheckbox,
            Location = new Point(20, 358),
            AutoSize = true,
            Checked = autoStartEnabled
        };

        _autoCheckUpdatesCheck = new CheckBox
        {
            Text = AgentStrings.AutoCheckUpdatesCheckbox,
            Location = new Point(20, 388),
            AutoSize = true,
            Checked = currentConfig.AutoCheckUpdates
        };

        _statusLabel = new Label
        {
            Location = new Point(20, 422),
            Size = new Size(464, 48),
            ForeColor = Color.DimGray,
            Text = AgentStrings.SettingsDefaultHint
        };

        _saveButton = new Button
        {
            Text = AgentStrings.TestAndSaveButton,
            Location = new Point(252, 482),
            Width = 134,
            Height = 34
        };
        _saveButton.Click += async (_, _) => await TestAndSaveAsync();

        var cancelButton = new Button
        {
            Text = AgentStrings.CancelButton,
            Location = new Point(396, 482),
            Width = 88,
            Height = 34,
            DialogResult = DialogResult.Cancel
        };

        Controls.AddRange(new Control[]
        {
            urlLabel, _urlBox,
            secretLabel, _secretBox, _showSecretCheck,
            _webInfoLabel,
            networkGroup,
            _autoUploadScreenshotsCheck,
            _compressScreenshotsCheck,
            _autoStartCheck,
            _autoCheckUpdatesCheck,
            _statusLabel,
            _saveButton, cancelButton
        });
        AcceptButton = _saveButton;
        CancelButton = cancelButton;
    }

    private void UpdateProxyInputState()
    {
        _proxyAddressBox.Enabled = _mainlandProxyRadio.Checked;
    }

    private async Task TestAndSaveAsync()
    {
        string cloudUrl = _urlBox.Text.Trim().TrimEnd('/');
        string syncSecret = _secretBox.Text.Trim();
        bool proxyEnabled = _mainlandProxyRadio.Checked;
        string proxyAddress = _proxyAddressBox.Text.Trim();

        if (!Uri.TryCreate(cloudUrl, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = AgentStrings.InvalidCloudUrlMessage;
            return;
        }

        if (proxyEnabled)
        {
            var (proxyOk, _, proxyErr) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri(proxyAddress);
            if (!proxyOk)
            {
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = proxyErr;
                return;
            }
        }

        _saveButton.Enabled = false;
        _statusLabel.ForeColor = Color.SteelBlue;
        _statusLabel.Text = proxyEnabled
            ? AgentStrings.TestingViaProxyMessage
            : AgentStrings.TestingDirectMessage;

        try
        {
            string localDeviceId = _initialConfig.EnsureDeviceId();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var (ok, message, syncResponse) = await _syncClient.TestConnectionAsync(
                cloudUrl,
                syncSecret,
                localDeviceId,
                string.Empty,
                proxyEnabled,
                proxyAddress,
                cts.Token);

            if (!ok || syncResponse == null)
            {
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = message;
                return;
            }

            int authoritativeInterval = SyncScheduleGate.ClampInterval(syncResponse.SyncIntervalSeconds);
            string authoritativeDeviceName = (syncResponse.DeviceName ?? string.Empty).Trim();
            _webInfoLabel.Text = AgentStrings.FormatWebDeviceAndScheduleHint(authoritativeDeviceName, authoritativeInterval);
            InitialSyncResponse = syncResponse;

            SavedConfig = new AgentConfig
            {
                CloudUrl = cloudUrl,
                SyncSecret = syncSecret,
                DeviceId = string.IsNullOrWhiteSpace(syncResponse.DeviceId) ? localDeviceId : syncResponse.DeviceId,
                DeviceName = authoritativeDeviceName,
                SyncIntervalSeconds = authoritativeInterval,
                ProxyEnabled = proxyEnabled,
                ProxyAddress = proxyAddress,
                AutoUploadScreenshots = _autoUploadScreenshotsCheck.Checked,
                CompressScreenshots = _compressScreenshotsCheck.Checked,
                AutoCheckUpdates = _autoCheckUpdatesCheck.Checked,
                WritePngMetadata = _initialConfig.WritePngMetadata,
                AutoLaunchAppsEnabled = _initialConfig.AutoLaunchAppsEnabled,
                VrChatLogDirectory = _initialConfig.VrChatLogDirectory,
                AutoLaunchDirectory = _initialConfig.AutoLaunchDirectory,
                VrChatExecutableOverride = _initialConfig.VrChatExecutableOverride
            };

            DialogResult = DialogResult.OK;
            Close();
        }
        finally
        {
            _saveButton.Enabled = true;
        }
    }
}
