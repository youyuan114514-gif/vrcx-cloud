using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace VRCX.Agent.Core;

/// <summary>
/// Pure .NET 10 VMess AEAD client (`alterId = 0`) byte-compatible with V2Ray, Xray-core, and sing-box.
/// Supports TCP, TLS-over-TCP, WebSocket (`ws`), and WebSocket-over-TLS (`wss`) transports
/// and exposes a standard bidirectional <see cref="Stream"/> for <see cref="SocketsHttpHandler.ConnectCallback"/>.
/// </summary>
public static class VmessAeadClient
{
    private const string CmdKeyMagic = "c48619fe-8f02-49e0-b9e9-edf763e17e21";
    private const string SaltVmessAeadKdf = "VMess AEAD KDF";
    private const string SaltAuthIdEncryptionKey = "AES Auth ID Encryption";
    private const string SaltHeaderLengthKey = "VMess Header AEAD Key_Length";
    private const string SaltHeaderLengthNonce = "VMess Header AEAD Nonce_Length";
    private const string SaltHeaderPayloadKey = "VMess Header AEAD Key";
    private const string SaltHeaderPayloadNonce = "VMess Header AEAD Nonce";
    private const string SaltRespHeaderLenKey = "AEAD Resp Header Len Key";
    private const string SaltRespHeaderLenIv = "AEAD Resp Header Len IV";
    private const string SaltRespHeaderPayloadKey = "AEAD Resp Header Key";
    private const string SaltRespHeaderPayloadIv = "AEAD Resp Header IV";

    private static readonly uint[] Crc32Table = BuildCrc32Table();

    /// <summary>
    /// Connects to the VMess server and returns a bidirectional encrypted VMess AEAD Stream
    /// targeting the specified destination host and port.
    /// </summary>
    public static async ValueTask<Stream> ConnectAsync(
        VmessConfig config,
        string destinationHost,
        int destinationPort,
        CancellationToken ct)
    {
        Stream transport = await OpenTransportStreamAsync(config, ct).ConfigureAwait(false);
        try
        {
            return CreateClientStream(transport, config, destinationHost, destinationPort);
        }
        catch
        {
            await transport.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>
    /// Wraps an already-connected transport stream in a VMess AEAD client stream (also used directly in unit tests).
    /// </summary>
    public static Stream CreateClientStream(
        Stream transport,
        VmessConfig config,
        string destinationHost,
        int destinationPort)
    {
        return new VmessAeadStream(transport, config, destinationHost, destinationPort);
    }

    /// <summary>
    /// Computes the 16-byte VMess CmdKey = MD5(uuid16 || ASCII("c48619fe-8f02-49e0-b9e9-edf763e17e21")).
    /// </summary>
    public static byte[] ComputeCmdKey(ReadOnlySpan<byte> uuidBigEndian16)
    {
        if (uuidBigEndian16.Length != 16)
        {
            throw new ArgumentException("UUID must be 16 bytes.", nameof(uuidBigEndian16));
        }
        byte[] magic = Encoding.ASCII.GetBytes(CmdKeyMagic);
        byte[] combined = new byte[16 + magic.Length];
        uuidBigEndian16.CopyTo(combined);
        magic.CopyTo(combined, 16);
        return MD5.HashData(combined);
    }

    /// <summary>
    /// Computes VMess AEAD nested HMAC-SHA256 KDF matching Xray-core `proxy/vmess/aead/kdf.go`.
    /// Each path component wraps the previous hash function as an HMAC with 64-byte block size.
    /// </summary>
    public static byte[] Kdf(byte[] key, params byte[][] path)
    {
        Func<byte[], byte[]> hashFunc = data =>
            HMACSHA256.HashData(Encoding.ASCII.GetBytes(SaltVmessAeadKdf), data);

        foreach (byte[] salt in path)
        {
            Func<byte[], byte[]> innerHash = hashFunc;
            byte[] capturedSalt = salt;
            hashFunc = data => ComputeNestedHmac(innerHash, capturedSalt, data);
        }

        return hashFunc(key);
    }

    public static byte[] Kdf16(byte[] key, params byte[][] path)
    {
        byte[] full = Kdf(key, path);
        byte[] result = new byte[16];
        Buffer.BlockCopy(full, 0, result, 0, 16);
        return result;
    }

    /// <summary>
    /// Creates the 16-byte AES-128-ECB encrypted AuthID (`[Timestamp 8B BE][Rand 4B][CRC32 4B BE]`).
    /// </summary>
    public static byte[] CreateAuthId(byte[] cmdKey16, long unixTimeSeconds, ReadOnlySpan<byte> rand4)
    {
        if (rand4.Length != 4) throw new ArgumentException("rand4 must be 4 bytes.", nameof(rand4));

        byte[] plain = new byte[16];
        BinaryPrimitives.WriteInt64BigEndian(plain.AsSpan(0, 8), unixTimeSeconds);
        rand4.CopyTo(plain.AsSpan(8, 4));
        uint crc = ComputeCrc32Ieee(plain.AsSpan(0, 12));
        BinaryPrimitives.WriteUInt32BigEndian(plain.AsSpan(12, 4), crc);

        byte[] authKey = Kdf16(cmdKey16, Encoding.ASCII.GetBytes(SaltAuthIdEncryptionKey));
        using var aes = Aes.Create();
        aes.Key = authKey;
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.None;
        return aes.EncryptEcb(plain, PaddingMode.None);
    }

    /// <summary>
    /// Seals a plaintext VMess Instruction Section into the AEAD wire header:
    /// `[EAuID 16B][ALength 2+16B][Nonce 8B][AHeader len+16B]`.
    /// </summary>
    public static byte[] SealAeadHeader(
        byte[] cmdKey16,
        byte[] instructionPlaintext,
        long? unixTimeSecondsOverride = null,
        byte[]? authRand4Override = null,
        byte[]? connectionNonce8Override = null)
    {
        long now = unixTimeSecondsOverride ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        byte[] rand4 = authRand4Override ?? RandomNumberGenerator.GetBytes(4);
        byte[] nonce8 = connectionNonce8Override ?? RandomNumberGenerator.GetBytes(8);
        if (nonce8.Length != 8) throw new ArgumentException("Connection nonce must be 8 bytes.");

        byte[] authId = CreateAuthId(cmdKey16, now, rand4);

        byte[] lenPlain = new byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(lenPlain, checked((ushort)instructionPlaintext.Length));

        byte[] lenKey = Kdf16(cmdKey16, Encoding.ASCII.GetBytes(SaltHeaderLengthKey), authId, nonce8);
        byte[] lenNonce = Kdf(cmdKey16, Encoding.ASCII.GetBytes(SaltHeaderLengthNonce), authId, nonce8)[..12];
        byte[] encryptedLen = AesGcmSeal(lenKey, lenNonce, lenPlain, authId);

        byte[] hdrKey = Kdf16(cmdKey16, Encoding.ASCII.GetBytes(SaltHeaderPayloadKey), authId, nonce8);
        byte[] hdrNonce = Kdf(cmdKey16, Encoding.ASCII.GetBytes(SaltHeaderPayloadNonce), authId, nonce8)[..12];
        byte[] encryptedHdr = AesGcmSeal(hdrKey, hdrNonce, instructionPlaintext, authId);

        byte[] output = new byte[16 + encryptedLen.Length + 8 + encryptedHdr.Length];
        int offset = 0;
        Buffer.BlockCopy(authId, 0, output, offset, 16); offset += 16;
        Buffer.BlockCopy(encryptedLen, 0, output, offset, encryptedLen.Length); offset += encryptedLen.Length;
        Buffer.BlockCopy(nonce8, 0, output, offset, 8); offset += 8;
        Buffer.BlockCopy(encryptedHdr, 0, output, offset, encryptedHdr.Length);
        return output;
    }

    /// <summary>
    /// Builds the unencrypted VMess Instruction Section ending with Big-Endian FNV-1a32 checksum.
    /// </summary>
    public static byte[] BuildInstructionSection(
        byte[] requestBodyIv16,
        byte[] requestBodyKey16,
        byte responseAuthV,
        byte optionByte,
        byte securityByte,
        string destinationHost,
        int destinationPort)
    {
        using var ms = new MemoryStream(128);
        ms.WriteByte(0x01); // Version = 1
        ms.Write(requestBodyIv16, 0, 16);
        ms.Write(requestBodyKey16, 0, 16);
        ms.WriteByte(responseAuthV);
        ms.WriteByte(optionByte);

        int paddingLen = RandomNumberGenerator.GetInt32(0, 16);
        byte secAndPad = (byte)((paddingLen << 4) | (securityByte & 0x0F));
        ms.WriteByte(secAndPad);
        ms.WriteByte(0x00); // Reserved
        ms.WriteByte(0x01); // Command = TCP

        Span<byte> portBytes = stackalloc byte[2];
        BinaryPrimitives.WriteUInt16BigEndian(portBytes, checked((ushort)destinationPort));
        ms.Write(portBytes);

        if (IPAddress.TryParse(destinationHost, out IPAddress? ip))
        {
            byte[] ipBytes = ip.GetAddressBytes();
            if (ip.AddressFamily == AddressFamily.InterNetwork && ipBytes.Length == 4)
            {
                ms.WriteByte(0x01); // IPv4
                ms.Write(ipBytes, 0, 4);
            }
            else if (ip.AddressFamily == AddressFamily.InterNetworkV6 && ipBytes.Length == 16)
            {
                ms.WriteByte(0x03); // IPv6
                ms.Write(ipBytes, 0, 16);
            }
            else
            {
                WriteDomainAddress(ms, destinationHost);
            }
        }
        else
        {
            WriteDomainAddress(ms, destinationHost);
        }

        if (paddingLen > 0)
        {
            byte[] pad = RandomNumberGenerator.GetBytes(paddingLen);
            ms.Write(pad, 0, pad.Length);
        }

        byte[] beforeChecksum = ms.ToArray();
        uint fnv = ComputeFnv1a32(beforeChecksum);
        Span<byte> fnvBytes = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(fnvBytes, fnv);
        ms.Write(fnvBytes);
        return ms.ToArray();
    }

    public static uint ComputeCrc32Ieee(ReadOnlySpan<byte> data)
    {
        uint crc = 0xFFFFFFFFu;
        for (int i = 0; i < data.Length; i++)
        {
            crc = Crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
        }
        return ~crc;
    }

    public static uint ComputeFnv1a32(ReadOnlySpan<byte> data)
    {
        uint hash = 0x811C9DC5u;
        for (int i = 0; i < data.Length; i++)
        {
            hash ^= data[i];
            hash *= 0x01000193u;
        }
        return hash;
    }

    internal static byte[] AesGcmSeal(byte[] key16, byte[] nonce12, ReadOnlySpan<byte> plaintext, ReadOnlySpan<byte> aad)
    {
        byte[] output = new byte[plaintext.Length + 16];
        using var gcm = new AesGcm(key16, 16);
        gcm.Encrypt(nonce12, plaintext, output.AsSpan(0, plaintext.Length), output.AsSpan(plaintext.Length, 16), aad);
        return output;
    }

    internal static byte[] AesGcmOpen(byte[] key16, byte[] nonce12, ReadOnlySpan<byte> ciphertextWithTag, ReadOnlySpan<byte> aad)
    {
        if (ciphertextWithTag.Length < 16)
        {
            throw new CryptographicException("AEAD payload shorter than 16-byte tag.");
        }
        int plainLen = ciphertextWithTag.Length - 16;
        byte[] plain = new byte[plainLen];
        using var gcm = new AesGcm(key16, 16);
        gcm.Decrypt(nonce12, ciphertextWithTag.Slice(0, plainLen), ciphertextWithTag.Slice(plainLen, 16), plain, aad);
        return plain;
    }

    private static void WriteDomainAddress(MemoryStream ms, string domain)
    {
        byte[] domainBytes = Encoding.ASCII.GetBytes(domain);
        if (domainBytes.Length == 0 || domainBytes.Length > 255)
        {
            throw new ArgumentException($"Invalid destination domain length: {domain}");
        }
        ms.WriteByte(0x02); // Domain
        ms.WriteByte((byte)domainBytes.Length);
        ms.Write(domainBytes, 0, domainBytes.Length);
    }

    private static byte[] ComputeNestedHmac(Func<byte[], byte[]> hashFunc, byte[] hmacKey, byte[] message)
    {
        const int blockSize = 64;
        byte[] keyBlock = new byte[blockSize];
        if (hmacKey.Length > blockSize)
        {
            byte[] hashedKey = hashFunc(hmacKey);
            Buffer.BlockCopy(hashedKey, 0, keyBlock, 0, Math.Min(hashedKey.Length, blockSize));
        }
        else
        {
            Buffer.BlockCopy(hmacKey, 0, keyBlock, 0, hmacKey.Length);
        }

        byte[] inner = new byte[blockSize + message.Length];
        for (int i = 0; i < blockSize; i++)
        {
            inner[i] = (byte)(keyBlock[i] ^ 0x36);
        }
        Buffer.BlockCopy(message, 0, inner, blockSize, message.Length);
        byte[] innerDigest = hashFunc(inner);

        byte[] outer = new byte[blockSize + innerDigest.Length];
        for (int i = 0; i < blockSize; i++)
        {
            outer[i] = (byte)(keyBlock[i] ^ 0x5C);
        }
        Buffer.BlockCopy(innerDigest, 0, outer, blockSize, innerDigest.Length);
        return hashFunc(outer);
    }

    private static uint[] BuildCrc32Table()
    {
        uint[] table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int j = 0; j < 8; j++)
            {
                c = (c & 1) != 0 ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
            }
            table[i] = c;
        }
        return table;
    }

    private static async Task<Stream> OpenTransportStreamAsync(VmessConfig config, CancellationToken ct)
    {
        if (config.Network == "ws")
        {
            return await OpenWebSocketTransportAsync(config, ct).ConfigureAwait(false);
        }

        // TCP (optionally wrapped in TLS and/or HTTP header obfuscation)
        var tcp = new TcpClient { NoDelay = true };
        try
        {
            await tcp.ConnectAsync(config.Server, config.Port, ct).ConfigureAwait(false);
            NetworkStream netStream = tcp.GetStream();
            Stream baseStream = new OwnedTcpStream(tcp, netStream);
            if (config.UseTls)
            {
                var ssl = new SslStream(baseStream, leaveInnerStreamOpen: false);
                try
                {
                    var sslOptions = new SslClientAuthenticationOptions
                    {
                        TargetHost = config.EffectiveSni,
                        EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
                    };
                    if (config.AllowInsecure)
                    {
                        sslOptions.RemoteCertificateValidationCallback = (_, _, _, _) => true;
                    }
                    if (!string.IsNullOrWhiteSpace(config.Alpn))
                    {
                        var protocols = new List<SslApplicationProtocol>();
                        foreach (string proto in config.Alpn.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                        {
                            protocols.Add(new SslApplicationProtocol(proto));
                        }
                        if (protocols.Count > 0)
                        {
                            sslOptions.ApplicationProtocols = protocols;
                        }
                    }
                    await ssl.AuthenticateAsClientAsync(sslOptions, ct).ConfigureAwait(false);
                    baseStream = ssl;
                }
                catch
                {
                    await ssl.DisposeAsync().ConfigureAwait(false);
                    throw;
                }
            }

            if (string.Equals(config.HeaderType, "http", StringComparison.OrdinalIgnoreCase))
            {
                return new HttpHeaderTransportStream(baseStream, config.EffectiveHttpHeaderHost, config.EffectiveWsPath);
            }
            return baseStream;
        }
        catch
        {
            tcp.Dispose();
            throw;
        }
    }

    private static async Task<Stream> OpenWebSocketTransportAsync(VmessConfig config, CancellationToken ct)
    {
        string scheme = config.UseTls ? "wss" : "ws";
        string serverHostForUri = config.Server.Contains(':') && !config.Server.StartsWith("[", StringComparison.Ordinal)
            ? $"[{config.Server}]"
            : config.Server;
        var wsUri = new Uri($"{scheme}://{serverHostForUri}:{config.Port}{config.EffectiveWsPath}");

        var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
        ws.Options.SetRequestHeader(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
        if (!string.IsNullOrWhiteSpace(config.PrimaryHost))
        {
            ws.Options.SetRequestHeader("Host", config.PrimaryHost);
        }

        HttpMessageInvoker? invoker = null;
        try
        {
            // Use custom SocketsHttpHandler so SNI can differ from connect IP/host (standard CDN/preferred-IP VMess WS+TLS).
            var wsHandler = new SocketsHttpHandler
            {
                UseProxy = false,
                Proxy = null,
                ConnectTimeout = TimeSpan.FromSeconds(15)
            };
            if (config.UseTls)
            {
                wsHandler.SslOptions = new SslClientAuthenticationOptions
                {
                    TargetHost = config.EffectiveSni,
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13
                };
                if (config.AllowInsecure)
                {
                    wsHandler.SslOptions.RemoteCertificateValidationCallback = (_, _, _, _) => true;
                }
            }
            invoker = new HttpMessageInvoker(wsHandler, disposeHandler: true);
            await ws.ConnectAsync(wsUri, invoker, ct).ConfigureAwait(false);
            return new WebSocketTransportStream(ws, invoker);
        }
        catch
        {
            ws.Dispose();
            invoker?.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Standard V2Ray / Xray-core TCP HTTP header obfuscation (`net: "tcp", type: "http"`):
    /// prepends an HTTP/1.1 GET request header on the first write and strips the server's HTTP response
    /// header (up to `\r\n\r\n`) on the first read while tolerating servers that omit a response header.
    /// </summary>
    internal sealed class HttpHeaderTransportStream : Stream
    {
        private const int MaxHttpHeaderBytes = 8192;
        private readonly Stream _inner;
        private byte[]? _pendingRequestHeader;
        private bool _responseHeaderHandled;
        private byte[] _bufferedPayload = Array.Empty<byte>();
        private int _bufferedOffset;

        public HttpHeaderTransportStream(Stream inner, string host, string path)
        {
            _inner = inner;
            string safePath = string.IsNullOrWhiteSpace(path) ? "/" : (path.StartsWith("/", StringComparison.Ordinal) ? path : "/" + path);
            string safeHost = string.IsNullOrWhiteSpace(host) ? "www.baidu.com" : host.Trim();
            string headerText =
                $"GET {safePath} HTTP/1.1\r\n" +
                $"Host: {safeHost}\r\n" +
                "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36\r\n" +
                "Accept-Encoding: gzip, deflate\r\n" +
                "Connection: keep-alive\r\n" +
                "Pragma: no-cache\r\n" +
                "\r\n";
            _pendingRequestHeader = Encoding.ASCII.GetBytes(headerText);
        }

        public override bool CanRead => _inner.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => _inner.CanWrite;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => _inner.Flush();
        public override Task FlushAsync(CancellationToken ct) => _inner.FlushAsync(ct);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
            ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            if (buffer.Length == 0) return 0;

            if (!_responseHeaderHandled)
            {
                await ReadAndStripHttpResponseHeaderAsync(ct).ConfigureAwait(false);
                _responseHeaderHandled = true;
            }

            if (_bufferedOffset < _bufferedPayload.Length)
            {
                int avail = Math.Min(buffer.Length, _bufferedPayload.Length - _bufferedOffset);
                _bufferedPayload.AsSpan(_bufferedOffset, avail).CopyTo(buffer.Span);
                _bufferedOffset += avail;
                if (_bufferedOffset >= _bufferedPayload.Length)
                {
                    _bufferedPayload = Array.Empty<byte>();
                    _bufferedOffset = 0;
                }
                return avail;
            }

            return await _inner.ReadAsync(buffer, ct).ConfigureAwait(false);
        }

        public override void Write(byte[] buffer, int offset, int count) =>
            WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
            WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
        {
            byte[]? header = _pendingRequestHeader;
            if (header != null)
            {
                _pendingRequestHeader = null;
                byte[] combined = new byte[header.Length + buffer.Length];
                Buffer.BlockCopy(header, 0, combined, 0, header.Length);
                if (buffer.Length > 0)
                {
                    buffer.Span.CopyTo(combined.AsSpan(header.Length));
                }
                await _inner.WriteAsync(combined, ct).ConfigureAwait(false);
                return;
            }

            await _inner.WriteAsync(buffer, ct).ConfigureAwait(false);
        }

        private async Task ReadAndStripHttpResponseHeaderAsync(CancellationToken ct)
        {
            byte[] acc = new byte[MaxHttpHeaderBytes];
            int filled = 0;

            while (filled < MaxHttpHeaderBytes)
            {
                int n = await _inner.ReadAsync(acc.AsMemory(filled, MaxHttpHeaderBytes - filled), ct).ConfigureAwait(false);
                if (n == 0)
                {
                    if (filled > 0)
                    {
                        _bufferedPayload = acc[..filled];
                        _bufferedOffset = 0;
                    }
                    return;
                }
                filled += n;

                // Only strip if the server actually starts with an HTTP response line ("HTTP").
                if (filled >= 4 &&
                    !(acc[0] == (byte)'H' && acc[1] == (byte)'T' && acc[2] == (byte)'T' && acc[3] == (byte)'P'))
                {
                    _bufferedPayload = acc[..filled];
                    _bufferedOffset = 0;
                    return;
                }

                int endIdx = FindCrlfCrlf(acc, filled);
                if (endIdx >= 0)
                {
                    int payloadStart = endIdx + 4;
                    int rem = filled - payloadStart;
                    if (rem > 0)
                    {
                        _bufferedPayload = new byte[rem];
                        Buffer.BlockCopy(acc, payloadStart, _bufferedPayload, 0, rem);
                        _bufferedOffset = 0;
                    }
                    return;
                }
            }

            throw new InvalidDataException("VMess TCP/HTTP obfuscation response header exceeded 8 KiB without CRLFCRLF.");
        }

        private static int FindCrlfCrlf(byte[] buf, int length)
        {
            for (int i = 0; i <= length - 4; i++)
            {
                if (buf[i] == (byte)'\r' && buf[i + 1] == (byte)'\n' &&
                    buf[i + 2] == (byte)'\r' && buf[i + 3] == (byte)'\n')
                {
                    return i;
                }
            }
            return -1;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _inner.Dispose();
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await _inner.DisposeAsync().ConfigureAwait(false);
            await base.DisposeAsync().ConfigureAwait(false);
        }
    }

    private sealed class OwnedTcpStream : Stream
    {
        private readonly TcpClient _tcp;
        private readonly NetworkStream _inner;
        public OwnedTcpStream(TcpClient tcp, NetworkStream inner) { _tcp = tcp; _inner = inner; }
        public override bool CanRead => _inner.CanRead;
        public override bool CanSeek => false;
        public override bool CanWrite => _inner.CanWrite;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => _inner.Flush();
        public override Task FlushAsync(CancellationToken ct) => _inner.FlushAsync(ct);
        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => _inner.ReadAsync(buffer, offset, count, ct);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => _inner.ReadAsync(buffer, ct);
        public override void Write(byte[] buffer, int offset, int count) => _inner.Write(buffer, offset, count);
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => _inner.WriteAsync(buffer, offset, count, ct);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) => _inner.WriteAsync(buffer, ct);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) { _inner.Dispose(); _tcp.Dispose(); }
            base.Dispose(disposing);
        }
    }

    private sealed class WebSocketTransportStream : Stream
    {
        private readonly ClientWebSocket _ws;
        private readonly HttpMessageInvoker _invoker;
        public WebSocketTransportStream(ClientWebSocket ws, HttpMessageInvoker invoker)
        {
            _ws = ws;
            _invoker = invoker;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken ct) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            if (_ws.State != WebSocketState.Open && _ws.State != WebSocketState.CloseSent)
            {
                return 0;
            }
            ValueWebSocketReceiveResult result = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return 0;
            }
            return result.Count;
        }
        public override void Write(byte[] buffer, int offset, int count) => WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
        {
            return _ws.SendAsync(buffer, WebSocketMessageType.Binary, endOfMessage: true, ct);
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _ws.Dispose();
                _invoker.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    private sealed class VmessAeadStream : Stream
    {
        private const int MaxPlainChunkSize = 8192;

        private readonly Stream _transport;
        private readonly byte[] _requestBodyKey;
        private readonly byte[] _requestBodyIv;
        private readonly byte[] _responseBodyKey;
        private readonly byte[] _responseBodyIv;
        private readonly byte _responseAuthV;
        private readonly byte _securityByte; // 0x03 AES-128-GCM, 0x05 None, 0x06 Zero
        private byte[]? _pendingHeaderBytes;

        private ushort _writeCount;
        private ushort _readCount;
        private bool _responseHeaderRead;
        private bool _readEof;
        private byte[] _readRemainder = Array.Empty<byte>();
        private int _readRemainderOffset;
        private bool _disposed;

        public VmessAeadStream(Stream transport, VmessConfig config, string destHost, int destPort)
        {
            _transport = transport;
            _requestBodyKey = RandomNumberGenerator.GetBytes(16);
            _requestBodyIv = RandomNumberGenerator.GetBytes(16);
            _responseBodyKey = SHA256.HashData(_requestBodyKey)[..16];
            _responseBodyIv = SHA256.HashData(_requestBodyIv)[..16];
            _responseAuthV = RandomNumberGenerator.GetBytes(1)[0];
            _securityByte = config.WireSecurityByte;

            // Opt: 0x01 (Standard Chunk Format S) for AES-128-GCM / None; 0x00 (Basic raw stream) for Zero.
            byte optionByte = _securityByte == 0x06 ? (byte)0x00 : (byte)0x01;
            byte[] cmdKey = ComputeCmdKey(config.UserIdBytes);
            byte[] instruction = BuildInstructionSection(
                _requestBodyIv,
                _requestBodyKey,
                _responseAuthV,
                optionByte,
                _securityByte,
                destHost,
                destPort);
            _pendingHeaderBytes = SealAeadHeader(cmdKey, instruction);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush() => _transport.Flush();
        public override Task FlushAsync(CancellationToken ct) => _transport.FlushAsync(ct);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
            ReadAsync(buffer.AsMemory(offset, count), ct).AsTask();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            if (buffer.Length == 0 || _readEof) return 0;

            if (_readRemainderOffset < _readRemainder.Length)
            {
                int avail = Math.Min(buffer.Length, _readRemainder.Length - _readRemainderOffset);
                _readRemainder.AsSpan(_readRemainderOffset, avail).CopyTo(buffer.Span);
                _readRemainderOffset += avail;
                if (_readRemainderOffset >= _readRemainder.Length)
                {
                    _readRemainder = Array.Empty<byte>();
                    _readRemainderOffset = 0;
                }
                return avail;
            }

            if (!_responseHeaderRead)
            {
                await ReadAndVerifyResponseHeaderAsync(ct).ConfigureAwait(false);
                _responseHeaderRead = true;
            }

            if (_securityByte == 0x06) // Zero (raw stream)
            {
                return await _transport.ReadAsync(buffer, ct).ConfigureAwait(false);
            }

            // Standard Chunk Format (Opt = 0x01, PlainChunkSizeParser)
            byte[] lenBuf = new byte[2];
            int gotLen = await ReadExactOrEofAsync(_transport, lenBuf, ct).ConfigureAwait(false);
            if (gotLen == 0)
            {
                _readEof = true;
                return 0;
            }
            if (gotLen < 2)
            {
                throw new EndOfStreamException("Truncated VMess chunk length.");
            }
            ushort chunkLen = BinaryPrimitives.ReadUInt16BigEndian(lenBuf);

            if (_securityByte == 0x05) // None
            {
                if (chunkLen == 0)
                {
                    _readEof = true;
                    return 0;
                }
                byte[] plainChunk = new byte[chunkLen];
                await ReadExactAsync(_transport, plainChunk, ct).ConfigureAwait(false);
                return CopyToCallerBuffer(plainChunk, buffer);
            }

            // AES-128-GCM (0x03)
            if (chunkLen < 16)
            {
                throw new InvalidDataException($"Invalid VMess AEAD chunk length: {chunkLen}");
            }
            if (chunkLen == 16)
            {
                // Empty AEAD chunk signals EOF (consume the 16-byte tag cleanly if present)
                byte[] eofTag = new byte[16];
                await ReadExactOrEofAsync(_transport, eofTag, ct).ConfigureAwait(false);
                _readEof = true;
                return 0;
            }

            byte[] encryptedChunk = new byte[chunkLen];
            await ReadExactAsync(_transport, encryptedChunk, ct).ConfigureAwait(false);
            byte[] chunkNonce = NextChunkNonce(_responseBodyIv, ref _readCount);
            byte[] decrypted = AesGcmOpen(_responseBodyKey, chunkNonce, encryptedChunk, ReadOnlySpan<byte>.Empty);
            return CopyToCallerBuffer(decrypted, buffer);
        }

        public override void Write(byte[] buffer, int offset, int count) =>
            WriteAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
            WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
        {
            byte[]? headerToSend = _pendingHeaderBytes;
            _pendingHeaderBytes = null;

            if (buffer.Length == 0)
            {
                if (headerToSend != null)
                {
                    await _transport.WriteAsync(headerToSend, ct).ConfigureAwait(false);
                }
                return;
            }

            if (_securityByte == 0x06) // Zero (raw unencrypted stream)
            {
                if (headerToSend != null)
                {
                    byte[] combined = new byte[headerToSend.Length + buffer.Length];
                    Buffer.BlockCopy(headerToSend, 0, combined, 0, headerToSend.Length);
                    buffer.Span.CopyTo(combined.AsSpan(headerToSend.Length));
                    await _transport.WriteAsync(combined, ct).ConfigureAwait(false);
                }
                else
                {
                    await _transport.WriteAsync(buffer, ct).ConfigureAwait(false);
                }
                return;
            }

            int pos = 0;
            while (pos < buffer.Length)
            {
                int sliceLen = Math.Min(MaxPlainChunkSize, buffer.Length - pos);
                ReadOnlySpan<byte> slice = buffer.Span.Slice(pos, sliceLen);
                pos += sliceLen;

                byte[] frame;
                if (_securityByte == 0x05) // None
                {
                    int hdrLen = headerToSend?.Length ?? 0;
                    frame = new byte[hdrLen + 2 + sliceLen];
                    if (headerToSend != null)
                    {
                        Buffer.BlockCopy(headerToSend, 0, frame, 0, hdrLen);
                        headerToSend = null;
                    }
                    BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(hdrLen, 2), (ushort)sliceLen);
                    slice.CopyTo(frame.AsSpan(hdrLen + 2));
                }
                else // AES-128-GCM (0x03)
                {
                    byte[] chunkNonce = NextChunkNonce(_requestBodyIv, ref _writeCount);
                    byte[] sealedChunk = AesGcmSeal(_requestBodyKey, chunkNonce, slice, ReadOnlySpan<byte>.Empty);
                    int hdrLen = headerToSend?.Length ?? 0;
                    frame = new byte[hdrLen + 2 + sealedChunk.Length];
                    if (headerToSend != null)
                    {
                        Buffer.BlockCopy(headerToSend, 0, frame, 0, hdrLen);
                        headerToSend = null;
                    }
                    BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(hdrLen, 2), checked((ushort)sealedChunk.Length));
                    Buffer.BlockCopy(sealedChunk, 0, frame, hdrLen + 2, sealedChunk.Length);
                }

                await _transport.WriteAsync(frame, ct).ConfigureAwait(false);
            }
        }

        private async Task ReadAndVerifyResponseHeaderAsync(CancellationToken ct)
        {
            byte[] encLenBuf = new byte[18];
            await ReadExactAsync(_transport, encLenBuf, ct).ConfigureAwait(false);

            byte[] lenKey = Kdf16(_responseBodyKey, Encoding.ASCII.GetBytes(SaltRespHeaderLenKey));
            byte[] lenIv = Kdf(_responseBodyIv, Encoding.ASCII.GetBytes(SaltRespHeaderLenIv))[..12];
            byte[] plainLen = AesGcmOpen(lenKey, lenIv, encLenBuf, ReadOnlySpan<byte>.Empty);
            ushort respHeaderLen = BinaryPrimitives.ReadUInt16BigEndian(plainLen);
            if (respHeaderLen < 4 || respHeaderLen > 1024)
            {
                throw new InvalidDataException($"Unexpected VMess response header length: {respHeaderLen}");
            }

            byte[] encHdrBuf = new byte[respHeaderLen + 16];
            await ReadExactAsync(_transport, encHdrBuf, ct).ConfigureAwait(false);

            byte[] hdrKey = Kdf16(_responseBodyKey, Encoding.ASCII.GetBytes(SaltRespHeaderPayloadKey));
            byte[] hdrIv = Kdf(_responseBodyIv, Encoding.ASCII.GetBytes(SaltRespHeaderPayloadIv))[..12];
            byte[] plainHdr = AesGcmOpen(hdrKey, hdrIv, encHdrBuf, ReadOnlySpan<byte>.Empty);

            if (plainHdr.Length < 4 || plainHdr[0] != _responseAuthV)
            {
                throw new CryptographicException("VMess response authentication byte mismatch.");
            }
        }

        private int CopyToCallerBuffer(byte[] plainChunk, Memory<byte> callerBuffer)
        {
            int toCopy = Math.Min(callerBuffer.Length, plainChunk.Length);
            plainChunk.AsSpan(0, toCopy).CopyTo(callerBuffer.Span);
            if (toCopy < plainChunk.Length)
            {
                _readRemainder = plainChunk;
                _readRemainderOffset = toCopy;
            }
            return toCopy;
        }

        private static byte[] NextChunkNonce(byte[] bodyIv16, ref ushort counter)
        {
            // Xray-core GenerateChunkNonce: count(2B BE) || bodyIv[2..12] (10B) = 12B AEAD nonce
            byte[] nonce = new byte[12];
            BinaryPrimitives.WriteUInt16BigEndian(nonce.AsSpan(0, 2), counter);
            Buffer.BlockCopy(bodyIv16, 2, nonce, 2, 10);
            counter++;
            return nonce;
        }

        private static async Task ReadExactAsync(Stream stream, byte[] buffer, CancellationToken ct)
        {
            int read = await ReadExactOrEofAsync(stream, buffer, ct).ConfigureAwait(false);
            if (read < buffer.Length)
            {
                throw new EndOfStreamException($"Unexpected EOF on VMess transport (expected {buffer.Length} bytes, got {read}).");
            }
        }

        private static async Task<int> ReadExactOrEofAsync(Stream stream, byte[] buffer, CancellationToken ct)
        {
            int total = 0;
            while (total < buffer.Length)
            {
                int n = await stream.ReadAsync(buffer.AsMemory(total, buffer.Length - total), ct).ConfigureAwait(false);
                if (n == 0) break;
                total += n;
            }
            return total;
        }

        protected override void Dispose(bool disposing)
        {
            if (!_disposed && disposing)
            {
                _disposed = true;
                _transport.Dispose();
            }
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            if (!_disposed)
            {
                _disposed = true;
                try
                {
                    if (_pendingHeaderBytes == null && _securityByte == 0x03)
                    {
                        // Best-effort EOF marker chunk
                        byte[] chunkNonce = NextChunkNonce(_requestBodyIv, ref _writeCount);
                        byte[] eofTag = AesGcmSeal(_requestBodyKey, chunkNonce, ReadOnlySpan<byte>.Empty, ReadOnlySpan<byte>.Empty);
                        byte[] frame = new byte[2 + eofTag.Length];
                        BinaryPrimitives.WriteUInt16BigEndian(frame.AsSpan(0, 2), (ushort)eofTag.Length);
                        Buffer.BlockCopy(eofTag, 0, frame, 2, eofTag.Length);
                        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
                        await _transport.WriteAsync(frame, cts.Token).ConfigureAwait(false);
                    }
                }
                catch
                {
                    // Transport may already be closed by peer
                }
                await _transport.DisposeAsync().ConfigureAwait(false);
            }
            await base.DisposeAsync().ConfigureAwait(false);
        }
    }
}
