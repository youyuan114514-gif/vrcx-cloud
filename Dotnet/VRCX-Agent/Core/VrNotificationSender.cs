using System;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Dispatches VR headset notifications locally via XSOverlay UDP (127.0.0.1:42069)
/// and OVRToolkit WebSocket (ws://127.0.0.1:11450) when commanded from Cloud Web/Mobile.
/// </summary>
public static class VrNotificationSender
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    public static async Task<bool> SendXsOverlayAsync(
        string title,
        string content,
        float timeoutSec = 3.0f,
        float opacity = 1.0f,
        int port = 42069)
    {
        try
        {
            var payload = new
            {
                messageType = 1,
                index = 0,
                timeout = Math.Clamp(timeoutSec, 1.0f, 30.0f),
                height = 175.0f,
                opacity = Math.Clamp(opacity, 0.1f, 1.0f),
                volume = 0.7f,
                audioPath = "default",
                title = title ?? "VRCX",
                content = content ?? string.Empty,
                useBase64Icon = false,
                icon = "default",
                sourceApp = "VRCX.Agent"
            };
            byte[] bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(payload));
            using var udp = new UdpClient();
            await udp.SendAsync(bytes, bytes.Length, "127.0.0.1", port).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "XSOverlay UDP dispatch failed.");
            return false;
        }
    }

    public static async Task<bool> SendOvrToolkitAsync(
        string title,
        string body,
        CancellationToken ct,
        string wsEndpoint = "ws://127.0.0.1:11450")
    {
        try
        {
            using var ws = new ClientWebSocket();
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(3));
            await ws.ConnectAsync(new Uri(wsEndpoint), timeoutCts.Token).ConfigureAwait(false);

            var packet = new
            {
                messageType = "SendNotification",
                json = JsonConvert.SerializeObject(new
                {
                    title = title ?? "VRCX",
                    body = body ?? string.Empty
                })
            };
            byte[] bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(packet));
            await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, timeoutCts.Token).ConfigureAwait(false);
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "sent", timeoutCts.Token).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "OVRToolkit WS dispatch failed.");
            return false;
        }
    }
}
