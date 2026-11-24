using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Incrementally tails VRChat `output_log_*.txt` using a persisted byte-offset cursor
/// and buffers unsent events in a durable local JSONL offline queue until periodic HTTP sync succeeds.
/// </summary>
public sealed class LogTailCollector
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int MaxOfflineQueueEntries = 20000;
    private const int BackfillQueueHighWatermark = 3500;
    private const int MaxTrackedLogFiles = 500;

    private readonly string _stateDir;
    private readonly string _cursorPath;
    private readonly string _queuePath;
    private readonly VrcLogParser _parser;

    private LogCursorState _cursor = new();
    private readonly List<GameLogEventItem> _queue = new();

    public event Action<GameLogEventItem>? ScreenshotCaptured;
    public event Action? WorldStateChanged;

    public VrcLogParser Parser => _parser;

    public int OfflineQueueCount
    {
        get
        {
            lock (_queue)
            {
                return _queue.Count;
            }
        }
    }

    public LogTailCollector(string stateDir, VrcLogParser? parser = null)
    {
        _stateDir = stateDir;
        Directory.CreateDirectory(_stateDir);
        _cursorPath = Path.Combine(_stateDir, "cursor.json");
        _queuePath = Path.Combine(_stateDir, "offline-queue.jsonl");
        _parser = parser ?? new VrcLogParser();

        LoadPersistedState();
    }

    public static string ResolveDefaultVrChatLogDirectory()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(localAppData))
        {
            return string.Empty;
        }
        // Standard Windows path: %USERPROFILE%\AppData\LocalLow\VRChat\VRChat
        string? appDataRoot = Directory.GetParent(localAppData)?.FullName;
        if (!string.IsNullOrEmpty(appDataRoot))
        {
            string localLow = Path.Combine(appDataRoot, "LocalLow", "VRChat", "VRChat");
            if (Directory.Exists(localLow))
            {
                return localLow;
            }
        }
        return Path.Combine(localAppData, "VRChat", "VRChat");
    }

    public LogCursorState SnapshotCursor()
    {
        lock (_queue)
        {
            return _cursor.Clone();
        }
    }

    /// <summary>
    /// Reads up to `maxCount` queued events without removing them so failed HTTP uploads retain durability.
    /// </summary>
    public List<GameLogEventItem> PeekBatch(int maxCount = 50)
    {
        lock (_queue)
        {
            int count = Math.Min(Math.Max(maxCount, 1), _queue.Count);
            return count == 0 ? new List<GameLogEventItem>() : _queue.GetRange(0, count);
        }
    }

    /// <summary>
    /// Removes the oldest `count` events after the cloud Worker confirms HTTP 200 ingest.
    /// </summary>
    public void AcknowledgeBatch(int count)
    {
        if (count <= 0) return;
        lock (_queue)
        {
            int removeCount = Math.Min(count, _queue.Count);
            if (removeCount <= 0) return;
            _queue.RemoveRange(0, removeCount);
            PersistQueueLocked();
        }
    }

    /// <summary>
    /// Scans all `output_log_*.txt` files in chronological order:
    /// - Historical log files (older than the latest file) are backfilled once each using an isolated parser
    ///   so they never overwrite live room/player state or trigger duplicate screenshot re-embedding.
    /// - The latest log file is incrementally tailed using the live `_parser` with persisted byte offsets.
    /// Returns the total number of newly parsed GameLog events.
    /// </summary>
    public int PollLogDirectory(string logDirectory)
    {
        if (string.IsNullOrWhiteSpace(logDirectory) || !Directory.Exists(logDirectory))
        {
            return 0;
        }

        List<string> orderedFiles = Directory
            .EnumerateFiles(logDirectory, "output_log_*.txt", SearchOption.TopDirectoryOnly)
            .OrderBy(File.GetLastWriteTimeUtc)
            .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (orderedFiles.Count == 0)
        {
            return 0;
        }

        string latestFile = orderedFiles[orderedFiles.Count - 1];
        int totalParsed = 0;
        bool cursorDirty = false;

        // 1. Backfill any unread historical output_log_*.txt files oldest-first (paused if offline queue is already heavy).
        for (int i = 0; i < orderedFiles.Count - 1; i++)
        {
            if (OfflineQueueCount >= BackfillQueueHighWatermark)
            {
                break;
            }
            string histFile = orderedFiles[i];
            int added = ReadHistoricalLogFile(histFile, out bool fileCursorUpdated);
            totalParsed += added;
            cursorDirty |= fileCursorUpdated;
        }

        // 2. Tail the active/latest output_log_*.txt file using the live parser.
        totalParsed += ReadLatestLogFile(latestFile, out bool latestCursorUpdated);
        cursorDirty |= latestCursorUpdated;

        if (cursorDirty)
        {
            PruneTrackedOffsets(orderedFiles);
            SaveCursor();
        }

        return totalParsed;
    }

    private int ReadHistoricalLogFile(string filePath, out bool cursorUpdated)
    {
        cursorUpdated = false;
        string fileName = Path.GetFileName(filePath);
        long fileLen;
        try
        {
            fileLen = new FileInfo(filePath).Length;
        }
        catch
        {
            return 0;
        }

        long startOffset = 0;
        if (_cursor.FileOffsets.TryGetValue(fileName, out long recordedOffset))
        {
            if (fileLen <= recordedOffset)
            {
                return 0;
            }
            startOffset = recordedOffset;
        }

        var isolatedParser = new VrcLogParser();
        var batch = new List<GameLogEventItem>();
        long endPosition = startOffset;

        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (startOffset > 0)
            {
                fs.Seek(startOffset, SeekOrigin.Begin);
            }
            using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);

            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                GameLogEventItem? ev = isolatedParser.ParseLine(line);
                if (ev != null)
                {
                    batch.Add(ev);
                }
            }
            endPosition = fs.Position;
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read historical VRChat log {File}", fileName);
            return 0;
        }

        if (batch.Count > 0)
        {
            EnqueueEventsBatch(batch);
            Log.Info("Backfilled {Count} historical GameLog event(s) from {File}.", batch.Count, fileName);
        }

        _cursor.FileOffsets[fileName] = endPosition;
        cursorUpdated = true;
        return batch.Count;
    }

    private bool _liveParserWarmupDone;

    private sealed class BoundedReadStream : Stream
    {
        private readonly Stream _inner;
        private long _remaining;

        public BoundedReadStream(Stream inner, long maxBytes)
        {
            _inner = inner;
            _remaining = Math.Max(0, maxBytes);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_remaining <= 0) return 0;
            int toRead = (int)Math.Min(count, _remaining);
            int read = _inner.Read(buffer, offset, toRead);
            _remaining -= read;
            return read;
        }
    }

    private void WarmUpLiveParserFromPrefix(string latestFile, long upToOffset)
    {
        if (_liveParserWarmupDone || upToOffset <= 0)
        {
            _liveParserWarmupDone = true;
            return;
        }
        _liveParserWarmupDone = true;

        try
        {
            using var fs = new FileStream(latestFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            long limit = Math.Min(upToOffset, fs.Length);
            using var bounded = new BoundedReadStream(fs, limit);
            using var reader = new StreamReader(bounded, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);

            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                _parser.ParseLine(line);
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to warm up live parser room state from {File}", Path.GetFileName(latestFile));
        }
    }

    private int ReadLatestLogFile(string latestFile, out bool cursorUpdated)
    {
        cursorUpdated = false;
        string fileName = Path.GetFileName(latestFile);
        long fileLen;
        try
        {
            fileLen = new FileInfo(latestFile).Length;
        }
        catch
        {
            return 0;
        }

        long offset;
        if (_cursor.FileOffsets.TryGetValue(fileName, out long mappedOffset))
        {
            offset = fileLen < mappedOffset ? 0 : mappedOffset;
        }
        else if (string.Equals(_cursor.FileName, fileName, StringComparison.OrdinalIgnoreCase))
        {
            offset = fileLen < _cursor.ByteOffset ? 0 : _cursor.ByteOffset;
        }
        else
        {
            offset = 0;
        }

        if (offset > 0 && !_liveParserWarmupDone)
        {
            WarmUpLiveParserFromPrefix(latestFile, offset);
        }
        else
        {
            _liveParserWarmupDone = true;
        }

        if (!string.Equals(_cursor.FileName, fileName, StringComparison.OrdinalIgnoreCase))
        {
            _cursor.FileName = fileName;
            _cursor.ByteOffset = offset;
            cursorUpdated = true;
        }

        if (fileLen <= offset)
        {
            if (_cursor.ByteOffset != offset || !_cursor.FileOffsets.ContainsKey(fileName))
            {
                _cursor.ByteOffset = offset;
                _cursor.FileOffsets[fileName] = offset;
                cursorUpdated = true;
            }
            return 0;
        }

        var batch = new List<GameLogEventItem>();
        var screenshots = new List<GameLogEventItem>();
        bool stateMutated = false;
        long endPosition = offset;

        using (var fs = new FileStream(latestFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            fs.Seek(offset, SeekOrigin.Begin);
            using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);

            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                string prevLoc = _parser.CurrentLocation;
                string prevWorld = _parser.CurrentWorldName;
                int prevPlayers = _parser.CurrentPlayerCount;

                GameLogEventItem? ev = _parser.ParseLine(line);
                if (ev != null)
                {
                    batch.Add(ev);
                    _cursor.LastEventDt = ev.CreatedAt;

                    if (!string.IsNullOrEmpty(ev.LocalScreenshotPath))
                    {
                        screenshots.Add(ev);
                    }
                }

                if (prevLoc != _parser.CurrentLocation || prevWorld != _parser.CurrentWorldName || prevPlayers != _parser.CurrentPlayerCount)
                {
                    stateMutated = true;
                }
            }

            endPosition = fs.Position;
        }

        if (batch.Count > 0)
        {
            EnqueueEventsBatch(batch);
        }

        _cursor.FileName = fileName;
        _cursor.ByteOffset = endPosition;
        _cursor.FileOffsets[fileName] = endPosition;
        cursorUpdated = true;

        foreach (GameLogEventItem shot in screenshots)
        {
            ScreenshotCaptured?.Invoke(shot);
        }

        if (stateMutated)
        {
            WorldStateChanged?.Invoke();
        }

        return batch.Count;
    }

    private void PruneTrackedOffsets(List<string> existingFilePaths)
    {
        if (_cursor.FileOffsets.Count <= MaxTrackedLogFiles) return;
        var existingNames = new HashSet<string>(
            existingFilePaths.Select(Path.GetFileName).Where(n => !string.IsNullOrEmpty(n))!,
            StringComparer.OrdinalIgnoreCase);
        foreach (string key in _cursor.FileOffsets.Keys.ToList())
        {
            if (_cursor.FileOffsets.Count <= MaxTrackedLogFiles) break;
            if (!existingNames.Contains(key) && !string.Equals(key, _cursor.FileName, StringComparison.OrdinalIgnoreCase))
            {
                _cursor.FileOffsets.Remove(key);
            }
        }
    }

    public void EnqueueEvent(GameLogEventItem item)
    {
        lock (_queue)
        {
            if (_queue.Count >= MaxOfflineQueueEntries)
            {
                _queue.RemoveRange(0, _queue.Count - MaxOfflineQueueEntries + 1);
            }
            _queue.Add(item);
            PersistQueueLocked();
        }
    }

    private void EnqueueEventsBatch(IReadOnlyList<GameLogEventItem> items)
    {
        if (items.Count == 0) return;
        lock (_queue)
        {
            _queue.AddRange(items);
            if (_queue.Count > MaxOfflineQueueEntries)
            {
                _queue.RemoveRange(0, _queue.Count - MaxOfflineQueueEntries);
            }
            PersistQueueLocked();
        }
    }

    private void LoadPersistedState()
    {
        try
        {
            if (File.Exists(_cursorPath))
            {
                string raw = File.ReadAllText(_cursorPath, Encoding.UTF8);
                var parsed = JsonConvert.DeserializeObject<LogCursorState>(raw);
                if (parsed != null)
                {
                    _cursor = parsed;
                    _cursor.FileOffsets = _cursor.FileOffsets != null
                        ? new Dictionary<string, long>(_cursor.FileOffsets, StringComparer.OrdinalIgnoreCase)
                        : new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
                    // Migrate legacy single-file cursor.json cleanly without re-reading the active file.
                    if (!string.IsNullOrWhiteSpace(_cursor.FileName) && !_cursor.FileOffsets.ContainsKey(_cursor.FileName))
                    {
                        _cursor.FileOffsets[_cursor.FileName] = _cursor.ByteOffset;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read log cursor state; starting fresh.");
        }

        try
        {
            if (File.Exists(_queuePath))
            {
                foreach (string line in File.ReadLines(_queuePath, Encoding.UTF8))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    var item = JsonConvert.DeserializeObject<GameLogEventItem>(line);
                    if (item != null)
                    {
                        _queue.Add(item);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read offline queue; starting empty.");
        }
    }

    private void SaveCursor()
    {
        try
        {
            string tmp = _cursorPath + ".tmp";
            File.WriteAllText(tmp, JsonConvert.SerializeObject(_cursor, Formatting.Indented), Encoding.UTF8);
            File.Move(tmp, _cursorPath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist log cursor.");
        }
    }

    private void PersistQueueLocked()
    {
        try
        {
            string tmp = _queuePath + ".tmp";
            using (var sw = new StreamWriter(tmp, append: false, Encoding.UTF8))
            {
                foreach (var item in _queue)
                {
                    sw.WriteLine(JsonConvert.SerializeObject(item));
                }
            }
            File.Move(tmp, _queuePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist offline queue.");
        }
    }
}
