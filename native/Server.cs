using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web;
using System.Web.Script.Serialization;

namespace NearbyLanToolbox
{
    internal sealed class ClipboardState
    {
        public string text = "";
        public long? updatedAt = null;
        public string deviceName = "";
    }

    internal class ClientRecord
    {
        public string id;
        public string name;
        public string address;
        public string userAgent;
        public long connectedAt;
        public long lastSeen;
    }

    internal sealed class EventClient : ClientRecord
    {
        public TcpClient tcp;
        public NetworkStream stream;
        public readonly object writeLock = new object();
    }

    internal sealed class HttpRequestData
    {
        public string method;
        public string target;
        public Dictionary<string, string> headers;
        public long contentLength;
    }

    internal sealed class AddressInfo
    {
        public string interfaceName;
        public string address;
        public string url;
        public int score;
    }

    internal sealed class ChatMessage
    {
        public string id;
        public string clientId;
        public string deviceName;
        public string text;
        public long sentAt;
    }

    internal static class Program
    {
        internal const int Port = 8787;
        // 上传不限制单文件大小：能传多大由接收盘剩余空间决定，而不是写死的常量。
        // 预检时保留这个余量，避免刚好把盘写满导致系统不稳定。
        private const long FreeSpaceReserve = 1024L * 1024 * 1024;
        private const int MaxJsonBody = 1024 * 1024;
        private const int MaxSpeedBytes = 100 * 1024 * 1024;
        private const long PollClientTtl = 15000;
        private static readonly object ServerLock = new object();
        private static readonly object StateLock = new object();
        private static readonly Dictionary<string, EventClient> EventClients = new Dictionary<string, EventClient>();
        private static readonly Dictionary<string, ClientRecord> PollClients = new Dictionary<string, ClientRecord>();
        private static readonly List<ChatMessage> ChatMessages = new List<ChatMessage>();
        private static readonly RNGCryptoServiceProvider Random = new RNGCryptoServiceProvider();
        private static ClipboardState Clipboard = new ClipboardState();
        private static TcpListener Listener;
        private static Timer CleanupTimer;
        private static Thread AcceptThread;
        private static string BaseDirectory;
        private static string UploadDirectory;
        private static bool AccessSettingsLoaded;
        private static bool AccessPasswordEnabled;
        private static string AccessPassword = "";
        private static long StartedAt;

        [STAThread]
        public static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Local\\NearbyLanToolbox.SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    System.Windows.Forms.MessageBox.Show("局域网工具箱已经在运行。", "近邻 · 局域网工具箱", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Information);
                    return;
                }

                WebViewRuntime.Initialize();
                GuiApplication.Run();
            }
        }

        internal static bool StartServer(out string error)
        {
            lock (ServerLock)
            {
                if (Listener != null)
                {
                    error = null;
                    return true;
                }

                BaseDirectory = AppDomain.CurrentDomain.BaseDirectory;
                if (String.IsNullOrWhiteSpace(UploadDirectory)) UploadDirectory = LoadUploadDirectory();
                EnsureAccessSettingsLoaded();
                Directory.CreateDirectory(UploadDirectory);
                StartedAt = EpochMilliseconds();

                TcpListener listener = new TcpListener(IPAddress.Any, Port);
                try
                {
                    listener.Start();
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    return false;
                }

                Listener = listener;
                CleanupTimer = new Timer(CleanupClients, null, 5000, 5000);
                AcceptThread = new Thread(delegate() { AcceptLoop(listener); });
                AcceptThread.IsBackground = true;
                AcceptThread.Name = "NearbyLanToolbox HTTP";
                AcceptThread.Start();
                error = null;
                return true;
            }
        }

        private static void AcceptLoop(TcpListener listener)
        {
            while (Object.ReferenceEquals(Listener, listener))
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleConnection, client);
                }
                catch (SocketException)
                {
                    if (!Object.ReferenceEquals(Listener, listener)) break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
            }
        }

        internal static void StopServer()
        {
            TcpListener listener;
            Timer cleanupTimer;
            lock (ServerLock)
            {
                listener = Listener;
                Listener = null;
                cleanupTimer = CleanupTimer;
                CleanupTimer = null;
                AcceptThread = null;
            }

            if (cleanupTimer != null) cleanupTimer.Dispose();
            if (listener != null)
            {
                try { listener.Stop(); } catch { }
            }

            List<EventClient> clients;
            lock (StateLock)
            {
                clients = EventClients.Values.ToList();
                EventClients.Clear();
                PollClients.Clear();
            }
            foreach (EventClient client in clients)
            {
                try { client.tcp.Close(); } catch { }
            }
        }

        internal static bool IsRunning
        {
            get { lock (ServerLock) return Listener != null; }
        }

        internal static string UploadDirectoryPath
        {
            get
            {
                lock (ServerLock)
                {
                    if (String.IsNullOrWhiteSpace(UploadDirectory)) UploadDirectory = LoadUploadDirectory();
                    return UploadDirectory;
                }
            }
        }

        internal static string DefaultUploadDirectoryPath
        {
            get
            {
                string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                if (String.IsNullOrWhiteSpace(profile)) profile = AppDomain.CurrentDomain.BaseDirectory;
                return Path.Combine(profile, "Downloads", "data", "uploads");
            }
        }

        internal static bool SetUploadDirectory(string path, out string error)
        {
            try
            {
                if (String.IsNullOrWhiteSpace(path)) throw new ArgumentException("目录不能为空");
                string fullPath = Path.GetFullPath(path.Trim());
                Directory.CreateDirectory(fullPath);

                string settingsDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NearbyLanToolbox");
                Directory.CreateDirectory(settingsDirectory);
                File.WriteAllText(
                    Path.Combine(settingsDirectory, "upload-path.txt"),
                    fullPath,
                    new UTF8Encoding(false));

                lock (ServerLock) UploadDirectory = fullPath;
                error = null;
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string LoadUploadDirectory()
        {
            string defaultPath = DefaultUploadDirectoryPath;
            try
            {
                string settingsFile = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NearbyLanToolbox",
                    "upload-path.txt");
                if (File.Exists(settingsFile))
                {
                    string configured = File.ReadAllText(settingsFile, Encoding.UTF8).Trim();
                    if (!String.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
                }
            }
            catch { }
            return defaultPath;
        }

        internal static string[] NetworkUrls()
        {
            return LocalAddresses().Select(delegate(AddressInfo item) { return item.url; }).ToArray();
        }

        internal static int ConnectedClientCount()
        {
            return PublicClients().Count;
        }

        internal static bool IsAccessPasswordEnabled
        {
            get
            {
                EnsureAccessSettingsLoaded();
                lock (StateLock) return AccessPasswordEnabled;
            }
        }

        internal static string CurrentAccessPassword
        {
            get
            {
                EnsureAccessSettingsLoaded();
                lock (StateLock) return AccessPassword;
            }
        }

        internal static string NewAccessPassword()
        {
            byte[] data = new byte[4];
            Random.GetBytes(data);
            uint value = BitConverter.ToUInt32(data, 0);
            return (100000 + (value % 900000)).ToString();
        }

        internal static bool SetAccessPassword(bool enabled, string password, out string error)
        {
            password = (password ?? "").Trim();
            if (enabled && !Regex.IsMatch(password, @"^\d{4,8}$"))
            {
                error = "访问密码必须是 4 到 8 位数字";
                return false;
            }

            try
            {
                string settingsDirectory = SettingsDirectory();
                Directory.CreateDirectory(settingsDirectory);
                string content = (enabled ? "1" : "0") + "\n" + (enabled ? password : "");
                File.WriteAllText(
                    Path.Combine(settingsDirectory, "access-settings.txt"),
                    content,
                    new UTF8Encoding(false));

                List<EventClient> clients;
                lock (StateLock)
                {
                    AccessSettingsLoaded = true;
                    AccessPasswordEnabled = enabled;
                    AccessPassword = enabled ? password : "";
                    clients = EventClients.Values.ToList();
                    EventClients.Clear();
                    PollClients.Clear();
                }
                foreach (EventClient client in clients)
                {
                    try { client.tcp.Close(); } catch { }
                }
                error = null;
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static string SettingsDirectory()
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NearbyLanToolbox");
        }

        private static void EnsureAccessSettingsLoaded()
        {
            lock (StateLock)
            {
                if (AccessSettingsLoaded) return;
                AccessSettingsLoaded = true;
                AccessPasswordEnabled = false;
                AccessPassword = "";
                try
                {
                    string settingsFile = Path.Combine(SettingsDirectory(), "access-settings.txt");
                    if (!File.Exists(settingsFile)) return;
                    string[] lines = File.ReadAllLines(settingsFile, Encoding.UTF8);
                    bool enabled = lines.Length > 0 && lines[0].Trim() == "1";
                    string password = lines.Length > 1 ? lines[1].Trim() : "";
                    if (enabled && Regex.IsMatch(password, @"^\d{4,8}$"))
                    {
                        AccessPasswordEnabled = true;
                        AccessPassword = password;
                    }
                }
                catch { }
            }
        }


        private static void HandleConnection(object state)
        {
            using (TcpClient client = (TcpClient)state)
            {
                try
                {
                    client.NoDelay = true;
                    client.ReceiveTimeout = 300000;
                    client.SendTimeout = 300000;
                    NetworkStream stream = client.GetStream();
                    HttpRequestData request = ReadRequest(stream);
                    if (request == null) return;
                    Uri uri = new Uri("http://localhost" + request.target);
                    string path = uri.AbsolutePath;

                    if (request.method == "GET" && path == "/api/events")
                    {
                        if (!IsAuthorized(client, request, uri))
                        {
                            WriteError(stream, 401, "需要访问密码");
                            return;
                        }
                        HandleEventClient(client, stream, request, uri);
                        return;
                    }

                    if (path.StartsWith("/api/", StringComparison.Ordinal))
                        HandleApi(client, stream, request, uri);
                    else if (path.StartsWith("/download/", StringComparison.Ordinal))
                    {
                        if (!IsAuthorized(client, request, uri))
                        {
                            WriteError(stream, 401, "需要访问密码");
                            return;
                        }
                        HandleDownload(stream, path);
                    }
                    else
                        HandleStatic(stream, path);
                }
                catch (IOException) { }
                catch (SocketException) { }
                catch (Exception ex)
                {
                    try
                    {
                        WriteJson(((TcpClient)state).GetStream(), 500, new Dictionary<string, object> { { "error", "服务器内部错误" } });
                    }
                    catch { }
                    Console.Error.WriteLine(ex);
                }
            }
        }

        private static HttpRequestData ReadRequest(NetworkStream stream)
        {
            MemoryStream header = new MemoryStream();
            int matched = 0;
            while (header.Length < 65536)
            {
                int value = stream.ReadByte();
                if (value < 0) return null;
                header.WriteByte((byte)value);
                if ((matched == 0 || matched == 2) && value == 13) matched++;
                else if ((matched == 1 || matched == 3) && value == 10) matched++;
                else matched = value == 13 ? 1 : 0;
                if (matched == 4) break;
            }
            if (matched != 4) return null;
            string text = Encoding.ASCII.GetString(header.ToArray());
            string[] lines = text.Split(new[] { "\r\n" }, StringSplitOptions.None);
            string[] first = lines[0].Split(' ');
            if (first.Length < 2) return null;
            Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon > 0) headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
            }
            long length = 0;
            string rawLength;
            if (headers.TryGetValue("Content-Length", out rawLength)) long.TryParse(rawLength, out length);
            return new HttpRequestData
            {
                method = first[0].ToUpperInvariant(),
                target = first[1],
                headers = headers,
                contentLength = length
            };
        }

        private static byte[] ReadBody(NetworkStream stream, long length, int limit)
        {
            if (length < 0 || length > limit) throw new InvalidDataException("请求内容过大");
            byte[] body = new byte[(int)length];
            int offset = 0;
            while (offset < body.Length)
            {
                int read = stream.Read(body, offset, body.Length - offset);
                if (read <= 0) throw new EndOfStreamException();
                offset += read;
            }
            return body;
        }

        private static void HandleStatic(NetworkStream stream, string path)
        {
            if (path == "/" || path == "/index.html")
                WriteResponse(stream, 200, "text/html; charset=utf-8", EmbeddedAssets.Index, null);
            else if (path == "/app.js")
                WriteResponse(stream, 200, "text/javascript; charset=utf-8", EmbeddedAssets.App, null);
            else if (path == "/styles.css")
                WriteResponse(stream, 200, "text/css; charset=utf-8", EmbeddedAssets.Styles, null);
            else
                WriteJson(stream, 404, new Dictionary<string, object> { { "error", "页面不存在" } });
        }

        private static void HandleApi(TcpClient client, NetworkStream stream, HttpRequestData request, Uri uri)
        {
            string path = uri.AbsolutePath;
            if (request.method == "GET" && path == "/api/auth/status")
            {
                EnsureAccessSettingsLoaded();
                bool required = !IsLoopback(client) && IsAccessPasswordEnabled;
                WriteJson(stream, 200, new Dictionary<string, object>
                {
                    { "enabled", IsAccessPasswordEnabled },
                    { "required", required },
                    { "authenticated", !required || IsAuthorized(client, request, uri) }
                });
                return;
            }
            if (request.method == "POST" && path == "/api/auth")
            {
                Dictionary<string, object> body = ReadJsonObject(stream, request);
                string password = GetString(body, "password", "");
                if (IsLoopback(client) || !IsAccessPasswordEnabled || PasswordMatches(password))
                {
                    WriteJson(stream, 200, new Dictionary<string, object> { { "ok", true } });
                    return;
                }
                WriteError(stream, 401, "访问密码错误");
                return;
            }
            if (!IsAuthorized(client, request, uri))
            {
                WriteError(stream, 401, "需要访问密码");
                return;
            }
            if (request.method == "GET" && path == "/api/state")
            {
                WriteJson(stream, 200, StatePayload(true));
                return;
            }
            if (request.method == "POST" && path == "/api/heartbeat")
            {
                Dictionary<string, object> body = ReadJsonObject(stream, request);
                string id = Limit(GetString(body, "clientId", NewId()), 80);
                string name = Limit(GetString(body, "name", "未命名设备"), 50);
                string address = RemoteAddress(client);
                string userAgent = Header(request, "User-Agent");
                bool changed;
                lock (StateLock)
                {
                    ClientRecord previous;
                    PollClients.TryGetValue(id, out previous);
                    changed = previous == null || previous.name != name || previous.address != address;
                    PollClients[id] = new ClientRecord
                    {
                        id = id,
                        name = name,
                        address = address,
                        userAgent = userAgent,
                        connectedAt = previous == null ? EpochMilliseconds() : previous.connectedAt,
                        lastSeen = EpochMilliseconds()
                    };
                }
                if (changed) Broadcast("devices", PublicClients());
                Dictionary<string, object> payload = StatePayload(false);
                WriteJson(stream, 200, payload);
                return;
            }
            if (request.method == "POST" && path == "/api/clipboard")
            {
                Dictionary<string, object> body = ReadJsonObject(stream, request);
                ClipboardState next = new ClipboardState
                {
                    text = Limit(GetString(body, "text", ""), 500000),
                    updatedAt = EpochMilliseconds(),
                    deviceName = Limit(GetString(body, "deviceName", "未知设备"), 50)
                };
                lock (StateLock) Clipboard = next;
                Broadcast("clipboard", next);
                WriteJson(stream, 200, next);
                return;
            }
            if (request.method == "GET" && path == "/api/files")
            {
                WriteJson(stream, 200, new Dictionary<string, object> { { "files", ListFiles() } });
                return;
            }
            if (request.method == "GET" && path == "/api/chat")
            {
                WriteJson(stream, 200, new Dictionary<string, object> { { "messages", ChatHistory() } });
                return;
            }
            if (request.method == "POST" && path == "/api/chat")
            {
                Dictionary<string, object> body = ReadJsonObject(stream, request);
                string text = Limit(GetString(body, "text", "").Trim(), 2000);
                if (text.Length == 0) { WriteError(stream, 400, "消息不能为空"); return; }
                ChatMessage message = new ChatMessage
                {
                    id = NewId(),
                    clientId = Limit(GetString(body, "clientId", ""), 80),
                    deviceName = Limit(GetString(body, "deviceName", "未知设备"), 50),
                    text = text,
                    sentAt = EpochMilliseconds()
                };
                lock (StateLock)
                {
                    ChatMessages.Add(message);
                    while (ChatMessages.Count > 200) ChatMessages.RemoveAt(0);
                }
                Broadcast("chat", message);
                WriteJson(stream, 201, message);
                return;
            }
            if (request.method == "POST" && path == "/api/upload")
            {
                HandleUpload(stream, request);
                return;
            }
            if (request.method == "DELETE" && path.StartsWith("/api/files/", StringComparison.Ordinal))
            {
                string id = Path.GetFileName(Uri.UnescapeDataString(path.Substring("/api/files/".Length)));
                string filePath = SafeUploadPath(id);
                if (filePath == null) { WriteError(stream, 403, "禁止访问"); return; }
                if (!File.Exists(filePath)) { WriteError(stream, 404, "文件不存在"); return; }
                File.Delete(filePath);
                List<Dictionary<string, object>> files = ListFiles();
                Broadcast("files", files);
                WriteJson(stream, 200, new Dictionary<string, object> { { "ok", true } });
                return;
            }
            if (request.method == "GET" && path == "/api/devices")
            {
                WriteJson(stream, 200, new Dictionary<string, object>
                {
                    { "clients", PublicClients() },
                    { "arp", ArpDevices() },
                    { "server", new Dictionary<string, object>
                        {
                            { "name", Environment.MachineName },
                            { "addresses", LocalAddresses().Select(delegate(AddressInfo a) { return a.address; }).ToList() }
                        }
                    },
                    { "scannedAt", EpochMilliseconds() }
                });
                return;
            }
            if (request.method == "GET" && path == "/api/ping")
            {
                WriteJson(stream, 200, new Dictionary<string, object> { { "now", EpochMilliseconds() } });
                return;
            }
            if (request.method == "GET" && path == "/api/speed/download")
            {
                int bytes = ParseInt(HttpUtility.ParseQueryString(uri.Query)["bytes"], 10 * 1024 * 1024);
                bytes = Math.Min(Math.Max(bytes, 1), MaxSpeedBytes);
                WriteSpeedDownload(stream, bytes);
                return;
            }
            if (request.method == "POST" && path == "/api/speed/upload")
            {
                long bytes = DrainBody(stream, Math.Min(request.contentLength, MaxSpeedBytes));
                WriteJson(stream, 200, new Dictionary<string, object> { { "bytes", bytes } });
                return;
            }
            WriteError(stream, 404, "接口不存在");
        }

        private static Dictionary<string, object> StatePayload(bool includeServer)
        {
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["clipboard"] = ClipboardCopy();
            payload["files"] = ListFiles();
            payload["clients"] = PublicClients();
            payload["chat"] = ChatHistory();
            if (includeServer)
            {
                payload["server"] = new Dictionary<string, object>
                {
                    { "hostname", Environment.MachineName },
                    { "port", Port },
                    { "addresses", LocalAddresses() },
                    { "startedAt", StartedAt }
                };
            }
            return payload;
        }

        private static ClipboardState ClipboardCopy()
        {
            lock (StateLock)
            {
                return new ClipboardState { text = Clipboard.text, updatedAt = Clipboard.updatedAt, deviceName = Clipboard.deviceName };
            }
        }

        private static List<ChatMessage> ChatHistory()
        {
            lock (StateLock) return ChatMessages.Select(delegate(ChatMessage message)
            {
                return new ChatMessage
                {
                    id = message.id,
                    clientId = message.clientId,
                    deviceName = message.deviceName,
                    text = message.text,
                    sentAt = message.sentAt
                };
            }).ToList();
        }

        private static Dictionary<string, object> ReadJsonObject(NetworkStream stream, HttpRequestData request)
        {
            byte[] body = ReadBody(stream, request.contentLength, MaxJsonBody);
            string json = Encoding.UTF8.GetString(body);
            if (String.IsNullOrWhiteSpace(json)) return new Dictionary<string, object>();
            return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
        }

        // 目标磁盘可用空间；读不到时返回 Int64.MaxValue，即不拦截。
        private static long AvailableFreeSpace(string directory)
        {
            try
            {
                string root = Path.GetPathRoot(Path.GetFullPath(directory));
                if (String.IsNullOrEmpty(root)) return Int64.MaxValue;
                return new DriveInfo(root).AvailableFreeSpace;
            }
            catch
            {
                return Int64.MaxValue;
            }
        }

        private static void HandleUpload(NetworkStream stream, HttpRequestData request)
        {
            string originalName = SafeFileName(Uri.UnescapeDataString(Header(request, "X-File-Name")));
            string id = EpochMilliseconds() + "-" + RandomHex(4) + "--" + originalName;
            string uploadDirectory = UploadDirectoryPath;

            // 不做单文件大小限制，只校验接收盘是否有足够剩余空间。
            // 先预检一次，避免写到一半才发现空间不够、白等一场。
            if (request.contentLength > 0)
            {
                long available = AvailableFreeSpace(uploadDirectory);
                if (request.contentLength > available - FreeSpaceReserve)
                {
                    WriteError(stream, 413, "接收目录所在磁盘剩余空间不足");
                    return;
                }
            }

            string finalPath = Path.Combine(uploadDirectory, id);
            string tempPath = finalPath + ".part";
            try
            {
                using (FileStream file = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    CopyExact(stream, file, request.contentLength);
                }
                File.Move(tempPath, finalPath);
                List<Dictionary<string, object>> files = ListFiles();
                Broadcast("files", files);
                Dictionary<string, object> uploaded = files.FirstOrDefault(delegate(Dictionary<string, object> item) { return Convert.ToString(item["id"]) == id; });
                WriteJson(stream, 201, new Dictionary<string, object> { { "file", uploaded } });
            }
            catch
            {
                try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
                throw;
            }
        }

        private static void HandleDownload(NetworkStream stream, string path)
        {
            string id = Path.GetFileName(Uri.UnescapeDataString(path.Substring("/download/".Length)));
            string filePath = SafeUploadPath(id);
            if (filePath == null || !File.Exists(filePath)) { WriteError(stream, 404, "文件不存在"); return; }
            FileInfo info = new FileInfo(filePath);
            int divider = id.IndexOf("--", StringComparison.Ordinal);
            string name = divider >= 0 ? id.Substring(divider + 2) : id;
            Dictionary<string, string> headers = new Dictionary<string, string>
            {
                { "Content-Disposition", "attachment; filename*=UTF-8''" + Uri.EscapeDataString(name) },
                { "Cache-Control", "private, no-store" }
            };
            WriteHeaders(stream, 200, "application/octet-stream", info.Length, headers);
            using (FileStream file = File.OpenRead(filePath)) file.CopyTo(stream);
        }

        private static List<Dictionary<string, object>> ListFiles()
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            DirectoryInfo directory = new DirectoryInfo(UploadDirectoryPath);
            foreach (FileInfo file in directory.GetFiles())
            {
                if (file.Name.EndsWith(".part", StringComparison.OrdinalIgnoreCase)) continue;
                int divider = file.Name.IndexOf("--", StringComparison.Ordinal);
                string originalName = divider >= 0 ? file.Name.Substring(divider + 2) : file.Name;
                result.Add(new Dictionary<string, object>
                {
                    { "id", file.Name },
                    { "name", originalName },
                    { "size", file.Length },
                    { "uploadedAt", ToEpochMilliseconds(file.CreationTimeUtc.Year > 1970 ? file.CreationTimeUtc : file.LastWriteTimeUtc) },
                    { "url", "/download/" + Uri.EscapeDataString(file.Name) }
                });
            }
            return result.OrderByDescending(delegate(Dictionary<string, object> item) { return Convert.ToInt64(item["uploadedAt"]); }).ToList();
        }

        private static string SafeUploadPath(string id)
        {
            string uploadDirectory = UploadDirectoryPath;
            string root = Path.GetFullPath(uploadDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string candidate = Path.GetFullPath(Path.Combine(uploadDirectory, id));
            return candidate.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? candidate : null;
        }

        private static string SafeFileName(string name)
        {
            if (String.IsNullOrWhiteSpace(name)) name = "file";
            name = Path.GetFileName(name);
            name = Regex.Replace(name, "[<>:\"/\\|?*\x00-\x1F]", "_").Trim();
            if (name.Length == 0) name = "file";
            return Limit(name, 180);
        }

        private static void HandleEventClient(TcpClient tcp, NetworkStream stream, HttpRequestData request, Uri uri)
        {
            var query = HttpUtility.ParseQueryString(uri.Query);
            string id = Limit(query["clientId"] ?? NewId(), 80);
            string name = Limit(query["name"] ?? "未命名设备", 50);
            EventClient current = new EventClient
            {
                id = id,
                name = name,
                address = RemoteAddress(tcp),
                userAgent = Header(request, "User-Agent"),
                connectedAt = EpochMilliseconds(),
                lastSeen = EpochMilliseconds(),
                tcp = tcp,
                stream = stream
            };
            EventClient previous = null;
            lock (StateLock)
            {
                EventClients.TryGetValue(id, out previous);
                EventClients[id] = current;
            }
            if (previous != null) try { previous.tcp.Close(); } catch { }
            WriteRaw(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n");
            WriteSse(current, "ready", new Dictionary<string, object>
            {
                { "clipboard", ClipboardCopy() },
                { "chat", ChatHistory() }
            });
            Broadcast("devices", PublicClients());
            try
            {
                while (true)
                {
                    Thread.Sleep(20000);
                    lock (current.writeLock)
                    {
                        WriteRaw(current.stream, ": keep-alive\n\n");
                        current.stream.Flush();
                    }
                }
            }
            catch { }
            finally
            {
                bool removed = false;
                lock (StateLock)
                {
                    EventClient active;
                    if (EventClients.TryGetValue(id, out active) && Object.ReferenceEquals(active, current))
                    {
                        EventClients.Remove(id);
                        removed = true;
                    }
                }
                if (removed) Broadcast("devices", PublicClients());
            }
        }

        private static void Broadcast(string eventName, object payload)
        {
            List<EventClient> clients;
            lock (StateLock) clients = EventClients.Values.ToList();
            foreach (EventClient client in clients)
            {
                try { WriteSse(client, eventName, payload); }
                catch
                {
                    lock (StateLock)
                    {
                        EventClient active;
                        if (EventClients.TryGetValue(client.id, out active) && Object.ReferenceEquals(active, client))
                            EventClients.Remove(client.id);
                    }
                    try { client.tcp.Close(); } catch { }
                }
            }
        }

        private static void WriteSse(EventClient client, string eventName, object payload)
        {
            string json = Serialize(payload);
            lock (client.writeLock)
            {
                WriteRaw(client.stream, "event: " + eventName + "\ndata: " + json + "\n\n");
                client.stream.Flush();
            }
        }

        private static List<Dictionary<string, object>> PublicClients()
        {
            lock (StateLock)
            {
                RemoveStalePollClientsLocked();
                Dictionary<string, ClientRecord> combined = new Dictionary<string, ClientRecord>(PollClients);
                foreach (KeyValuePair<string, EventClient> pair in EventClients) combined[pair.Key] = pair.Value;
                return combined.Values.Select(delegate(ClientRecord client)
                {
                    return new Dictionary<string, object>
                    {
                        { "id", client.id },
                        { "name", client.name },
                        { "address", client.address },
                        { "userAgent", client.userAgent },
                        { "connectedAt", client.connectedAt }
                    };
                }).ToList();
            }
        }

        private static bool RemoveStalePollClientsLocked()
        {
            long now = EpochMilliseconds();
            List<string> stale = PollClients.Where(delegate(KeyValuePair<string, ClientRecord> pair) { return now - pair.Value.lastSeen > PollClientTtl; }).Select(delegate(KeyValuePair<string, ClientRecord> pair) { return pair.Key; }).ToList();
            foreach (string id in stale) PollClients.Remove(id);
            return stale.Count > 0;
        }

        private static void CleanupClients(object state)
        {
            bool changed;
            lock (StateLock) changed = RemoveStalePollClientsLocked();
            if (changed) Broadcast("devices", PublicClients());
        }

        private static List<AddressInfo> LocalAddresses()
        {
            List<AddressInfo> result = new List<AddressInfo>();
            foreach (NetworkInterface network in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (network.OperationalStatus != OperationalStatus.Up || network.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                string lower = (network.Name + " " + network.Description).ToLowerInvariant();
                int score = network.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 100 : network.NetworkInterfaceType == NetworkInterfaceType.Ethernet ? 70 : 0;
                if (Regex.IsMatch(lower, "vpn|vmware|virtual|vethernet|wsl|tailscale|hamachi|loopback")) score -= 150;
                foreach (UnicastIPAddressInformation address in network.GetIPProperties().UnicastAddresses)
                {
                    if (address.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address.Address)) continue;
                    string value = address.Address.ToString();
                    if (value.StartsWith("169.254.", StringComparison.Ordinal)) continue;
                    result.Add(new AddressInfo { interfaceName = network.Name, address = value, url = "http://" + value + ":" + Port, score = score });
                }
            }
            return result.OrderByDescending(delegate(AddressInfo item) { return item.score; }).ThenBy(delegate(AddressInfo item) { return item.address; }).ToList();
        }

        private static List<Dictionary<string, object>> ArpDevices()
        {
            List<Dictionary<string, object>> devices = new List<Dictionary<string, object>>();
            HashSet<string> seen = new HashSet<string>();
            try
            {
                ProcessStartInfo info = new ProcessStartInfo("arp", "-a");
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                using (Process process = Process.Start(info))
                {
                    string output = process.StandardOutput.ReadToEnd();
                    if (!process.WaitForExit(5000)) try { process.Kill(); } catch { }
                    MatchCollection matches = Regex.Matches(output, @"\b((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\s+(\S+)", RegexOptions.IgnoreCase);
                    foreach (Match match in matches)
                    {
                        string address = match.Groups[1].Value;
                        string mac = match.Groups[2].Value.Replace('-', ':').ToUpperInvariant();
                        int first = ParseInt(address.Split('.')[0], 0);
                        if (seen.Contains(address) || first >= 224 || address.EndsWith(".255") || mac == "FF:FF:FF:FF:FF:FF" || mac.StartsWith("01:00:5E")) continue;
                        seen.Add(address);
                        devices.Add(new Dictionary<string, object> { { "address", address }, { "mac", mac }, { "type", match.Groups[3].Value } });
                    }
                }
            }
            catch { }
            return devices;
        }

        private static void WriteSpeedDownload(NetworkStream stream, int bytes)
        {
            WriteHeaders(stream, 200, "application/octet-stream", bytes, new Dictionary<string, string> { { "Cache-Control", "no-store" } });
            byte[] chunk = new byte[64 * 1024];
            Random.GetBytes(chunk);
            int remaining = bytes;
            while (remaining > 0)
            {
                int count = Math.Min(remaining, chunk.Length);
                stream.Write(chunk, 0, count);
                remaining -= count;
            }
        }

        private static long DrainBody(NetworkStream stream, long length)
        {
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            while (total < length)
            {
                int count = (int)Math.Min(buffer.Length, length - total);
                int read = stream.Read(buffer, 0, count);
                if (read <= 0) break;
                total += read;
            }
            return total;
        }

        private static void CopyExact(Stream source, Stream destination, long length)
        {
            byte[] buffer = new byte[128 * 1024];
            long total = 0;
            while (total < length)
            {
                int count = (int)Math.Min(buffer.Length, length - total);
                int read = source.Read(buffer, 0, count);
                if (read <= 0) throw new EndOfStreamException();
                destination.Write(buffer, 0, read);
                total += read;
            }
        }

        private static void WriteJson(NetworkStream stream, int status, object payload)
        {
            WriteResponse(stream, status, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(Serialize(payload)), null);
        }

        private static void WriteError(NetworkStream stream, int status, string message)
        {
            WriteJson(stream, status, new Dictionary<string, object> { { "error", message } });
        }

        private static void WriteResponse(NetworkStream stream, int status, string contentType, byte[] body, Dictionary<string, string> extraHeaders)
        {
            WriteHeaders(stream, status, contentType, body.LongLength, extraHeaders);
            stream.Write(body, 0, body.Length);
        }

        private static void WriteHeaders(NetworkStream stream, int status, string contentType, long contentLength, Dictionary<string, string> extraHeaders)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append("HTTP/1.1 ").Append(status).Append(' ').Append(StatusText(status)).Append("\r\n");
            builder.Append("Content-Type: ").Append(contentType).Append("\r\n");
            builder.Append("Content-Length: ").Append(contentLength).Append("\r\n");
            builder.Append("Cache-Control: no-store\r\n");
            builder.Append("Connection: close\r\n");
            if (extraHeaders != null)
                foreach (KeyValuePair<string, string> header in extraHeaders)
                    builder.Append(header.Key).Append(": ").Append(header.Value).Append("\r\n");
            builder.Append("\r\n");
            WriteRaw(stream, builder.ToString());
        }

        private static void WriteRaw(Stream stream, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
        }

        private static string Serialize(object value)
        {
            return new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue }.Serialize(value);
        }

        private static string StatusText(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 201: return "Created";
                case 400: return "Bad Request";
                case 401: return "Unauthorized";
                case 403: return "Forbidden";
                case 404: return "Not Found";
                case 413: return "Payload Too Large";
                default: return "Internal Server Error";
            }
        }

        private static string Header(HttpRequestData request, string name)
        {
            string value;
            return request.headers.TryGetValue(name, out value) ? value : "";
        }

        private static bool IsAuthorized(TcpClient client, HttpRequestData request, Uri uri)
        {
            EnsureAccessSettingsLoaded();
            if (IsLoopback(client) || !IsAccessPasswordEnabled) return true;
            string supplied = Header(request, "X-Access-Code");
            if (String.IsNullOrEmpty(supplied))
                supplied = HttpUtility.ParseQueryString(uri.Query)["accessCode"] ?? "";
            return PasswordMatches(supplied);
        }

        private static bool IsLoopback(TcpClient client)
        {
            IPEndPoint endpoint = client.Client.RemoteEndPoint as IPEndPoint;
            if (endpoint == null) return false;
            IPAddress address = endpoint.Address;
            if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
            return IPAddress.IsLoopback(address);
        }

        private static bool PasswordMatches(string supplied)
        {
            string expected;
            lock (StateLock) expected = AccessPassword;
            byte[] left = Encoding.UTF8.GetBytes(expected ?? "");
            byte[] right = Encoding.UTF8.GetBytes((supplied ?? "").Trim());
            int difference = left.Length ^ right.Length;
            int length = Math.Max(left.Length, right.Length);
            for (int i = 0; i < length; i++)
            {
                byte a = i < left.Length ? left[i] : (byte)0;
                byte b = i < right.Length ? right[i] : (byte)0;
                difference |= a ^ b;
            }
            return difference == 0;
        }

        private static string RemoteAddress(TcpClient client)
        {
            IPEndPoint endpoint = client.Client.RemoteEndPoint as IPEndPoint;
            if (endpoint == null) return "";
            string address = endpoint.Address.ToString();
            return address.StartsWith("::ffff:", StringComparison.OrdinalIgnoreCase) ? address.Substring(7) : address;
        }

        private static string GetString(Dictionary<string, object> data, string key, string fallback)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
        }

        private static string Limit(string value, int length)
        {
            value = value ?? "";
            return value.Length <= length ? value : value.Substring(0, length);
        }

        private static int ParseInt(string value, int fallback)
        {
            int parsed;
            return Int32.TryParse(value, out parsed) ? parsed : fallback;
        }

        private static string NewId()
        {
            return RandomHex(16);
        }

        private static string RandomHex(int bytes)
        {
            byte[] data = new byte[bytes];
            Random.GetBytes(data);
            StringBuilder result = new StringBuilder(bytes * 2);
            foreach (byte value in data) result.Append(value.ToString("x2"));
            return result.ToString();
        }

        private static long EpochMilliseconds()
        {
            return ToEpochMilliseconds(DateTime.UtcNow);
        }

        private static long ToEpochMilliseconds(DateTime value)
        {
            return (long)(value.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }
    }
}
