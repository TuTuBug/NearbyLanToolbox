"use strict";

/**
 * 近邻 · 局域网工具箱 — Node.js 版后端
 *
 * 与 exe 版（C# / .NET Framework 4.8 + WebView2）提供同一套 HTTP 接口和同一份前端，
 * 区别只在于运行方式：本文件是纯 Node.js 实现，不依赖 Windows，可在 macOS / Linux /
 * Windows 上直接运行，让 Mac / Linux 也能当「服务主机」。
 *
 * 用法：
 *   node server.js                     启动服务
 *   node server.js --port 9000         指定端口
 *   node server.js --upload-dir <路径>  指定接收目录（不写入配置）
 *   node server.js --set-password 1234 设置访问密码（4 到 8 位数字）后退出
 *   node server.js --disable-password  关闭访问密码后退出
 *   node server.js --show-config       打印当前配置后退出
 *   node server.js --help              查看帮助
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { defaultSettingsDirectory, createAccessControl } = require("./lib/access");
const { arpDevices } = require("./lib/arp");

const PLATFORM = process.platform;

// ---------- 路径（跨平台） ----------

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

// 设置目录由 lib/access 统一决定（Windows/macOS/Linux 各自的标准位置），
// 与 exe 版同名，便于两台机器上配置习惯保持一致。
const SETTINGS_DIR = process.env.NEARBY_SETTINGS_DIR || defaultSettingsDirectory();
const UPLOAD_PATH_FILE = path.join(SETTINGS_DIR, "upload-path.txt");

// ---------- 命令行参数 ----------

const argv = process.argv.slice(2);

function argValue(name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? "" : value;
}

function hasFlag(name) {
  return argv.includes(name);
}

function printHelp() {
  console.log(`
近邻 · 局域网工具箱（Node 版后端）

用法:
  node server.js [选项]

选项:
  --port <端口>            服务端口，默认 8787
  --upload-dir <路径>      接收目录，默认 <项目目录>/data/uploads
  --set-password <密码>    设置访问密码（4 到 8 位数字）后退出
  --disable-password       关闭访问密码后退出
  --show-config            打印当前配置后退出
  --help                   显示本帮助

环境变量:
  PORT                     同 --port
  UPLOAD_DIR               同 --upload-dir
  NEARBY_SETTINGS_DIR      覆盖设置目录

设置文件:
  访问密码   ${access.settingsFile}
  接收目录   ${UPLOAD_PATH_FILE}
`);
}

// ---------- 访问密码 ----------

// 实现见 lib/access.js：与 exe 版共用同一份设置文件与语义。
// 独立成模块是为了能用单元测试覆盖非回环请求路径 —— 开发机上无法实测
// （Windows 防火墙会拦掉本机到自身局域网地址的连接），见 tools/test-access.js。
const access = createAccessControl({ settingsDirectory: SETTINGS_DIR });

// ---------- 运行参数 ----------

const HOST = "0.0.0.0";
const PORT = Number(argValue("--port") || process.env.PORT || 8787);

// 上传不限制单文件大小：能传多大由接收盘剩余空间决定。
// 预检时保留这个余量，避免刚好把盘写满导致系统不稳定。
const FREE_SPACE_RESERVE = 1024 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
const MAX_SPEED_BYTES = 100 * 1024 * 1024;
const POLL_CLIENT_TTL = 15000;
const MAX_CHAT_MESSAGES = 200;

// 接收目录优先级：命令行 > 环境变量 > 设置文件 > 项目内默认目录。
function resolveUploadDirectory() {
  const candidates = [];
  const fromArg = argValue("--upload-dir");
  if (fromArg) candidates.push(fromArg);
  if (process.env.UPLOAD_DIR) candidates.push(process.env.UPLOAD_DIR);
  try {
    if (fs.existsSync(UPLOAD_PATH_FILE)) {
      const configured = fs.readFileSync(UPLOAD_PATH_FILE, "utf8").trim();
      if (configured) candidates.push(configured);
    }
  } catch {
    // 配置读不到就继续往后找。
  }
  candidates.push(path.join(ROOT, "data", "uploads"));

  for (const directory of candidates) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.accessSync(directory, fs.constants.W_OK);
      return directory;
    } catch {
      // 这个候选不可用，试下一个。
    }
  }
  throw new Error("找不到可写的接收目录");
}

const UPLOAD_DIR = resolveUploadDirectory();

// 目标磁盘可用空间。statfsSync 需要 Node 18.15+，读不到就按「不拦截」处理。
function availableFreeSpace(directory) {
  try {
    const stat = fs.statfsSync(directory);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

let clipboard = { text: "", updatedAt: null, deviceName: "" };
let chatMessages = [];
const eventClients = new Map();
const pollClients = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function safeFileName(name) {
  const cleaned = path.basename(name || "file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();
  return (cleaned || "file").slice(0, 180);
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

// ---------- 网络接口 ----------

// 虚拟 / 隧道 / 点对点接口：这些地址对外不可达，必须排除。
// macOS 上尤其重要 —— 它默认带一堆 utun / awdl / llw / bridge / anpi 接口，
// 不加过滤会把 AirDrop 或 VPN 的地址当成「局域网地址」推荐给用户。
const VIRTUAL_INTERFACE = /^(lo\d*|utun\d*|awdl\d*|llw\d*|ap\d|anpi\d*|vmenet\d*|gif\d*|stf\d*|bridge\d*|p2p\d*|docker\d*|br-|veth|virbr\d*|tun\d*|tap\d*|wg\d*|zt\d*|tailscale\d*|hamachi\d*|hyper-v|npcap|bluetooth)/i;
const VPN_INTERFACE = /vpn|virtual|vmware|vethernet|wsl|loopback|zerotier|nordlynx|proton/i;

function interfaceScore(interfaceName) {
  const name = String(interfaceName || "");
  if (VIRTUAL_INTERFACE.test(name)) return -1000;
  if (VPN_INTERFACE.test(name)) return -500;

  let score = 0;
  // macOS 用 en0/en1，Linux 用 eth0/eth1。
  if (/^(en|eth)\d/i.test(name)) score += 80;
  if (/wi-?fi|wlan|wireless|airport|无线/i.test(name)) score += 120;
  if (/ethernet|以太网/i.test(name)) score += 90;
  // en0 / eth0 通常是主网卡，优先推荐。
  if (/^(en0|eth0)$/i.test(name)) score += 40;
  return score;
}

function localAddresses() {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      // Node 18 起 family 是字符串，更早是数字，两种都认。
      const isIPv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIPv4 || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      addresses.push({
        interfaceName,
        address: entry.address,
        url: `http://${entry.address}:${PORT}`
      });
    }
  }
  return addresses.sort((a, b) => {
    const difference = interfaceScore(b.interfaceName) - interfaceScore(a.interfaceName);
    return difference !== 0 ? difference : a.interfaceName.localeCompare(b.interfaceName);
  });
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".part"))
    .map((entry) => {
      const filePath = path.join(UPLOAD_DIR, entry.name);
      const stat = fs.statSync(filePath);
      const divider = entry.name.indexOf("--");
      const originalName = divider >= 0 ? entry.name.slice(divider + 2) : entry.name;
      return {
        id: entry.name,
        name: originalName,
        size: stat.size,
        uploadedAt: stat.birthtimeMs || stat.mtimeMs,
        url: `/download/${encodeURIComponent(entry.name)}`
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function removeStalePollClients() {
  const now = Date.now();
  let changed = false;
  for (const [id, client] of pollClients) {
    if (now - client.lastSeen > POLL_CLIENT_TTL) {
      pollClients.delete(id);
      changed = true;
    }
  }
  return changed;
}

function publicClients() {
  removeStalePollClients();
  const clients = new Map(pollClients);
  for (const [id, client] of eventClients) clients.set(id, client);
  return Array.from(clients.values()).map((client) => ({
    id: client.id,
    name: client.name,
    address: client.address,
    userAgent: client.userAgent,
    connectedAt: client.connectedAt
  }));
}

function chatHistory() {
  return chatMessages.slice();
}

function requestAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(forwarded || req.socket.remoteAddress || "").replace("::ffff:", "");
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of eventClients.values()) {
    client.res.write(message);
  }
}

function addEventClient(req, res, url) {
  const id = (url.searchParams.get("clientId") || crypto.randomUUID()).slice(0, 80);
  const name = safeDecode(url.searchParams.get("name") || "未命名设备").slice(0, 50);
  const address = requestAddress(req);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ clipboard, chat: chatHistory() })}\n\n`);

  const previous = eventClients.get(id);
  if (previous) previous.res.end();
  eventClients.set(id, {
    id,
    name,
    address,
    userAgent: req.headers["user-agent"] || "",
    connectedAt: Date.now(),
    res
  });
  broadcast("devices", publicClients());

  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    if (eventClients.get(id)?.res === res) {
      eventClients.delete(id);
      broadcast("devices", publicClients());
    }
  });
}

// ---------- 静态资源与下载 ----------

function serveStatic(req, res, url) {
  let relative = url.pathname === "/" ? "index.html" : safeDecode(url.pathname.slice(1));
  relative = path.normalize(relative).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return error(res, 403, "禁止访问");

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return error(res, 404, "页面不存在");
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleDownload(req, res, url) {
  const id = path.basename(safeDecode(url.pathname.slice("/download/".length)));
  const filePath = path.join(UPLOAD_DIR, id);
  if (!filePath.startsWith(UPLOAD_DIR)) return error(res, 403, "禁止访问");
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return error(res, 404, "文件不存在");
    const divider = id.indexOf("--");
    const name = divider >= 0 ? id.slice(divider + 2) : id;
    const encoded = encodeURIComponent(name);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "Cache-Control": "private, no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- 接口 ----------

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/auth/status") {
    return json(res, 200, access.status(req, url));
  }

  if (req.method === "POST" && pathname === "/api/auth") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return error(res, 400, err.message);
    }
    if (access.verify(req, String(body.password || ""))) {
      return json(res, 200, { ok: true });
    }
    return error(res, 401, "访问密码错误");
  }

  // 除密码校验接口外，其余接口在启用密码时都需要通过校验。
  if (!access.isAuthorized(req, url)) {
    return error(res, 401, "需要访问密码");
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return json(res, 200, {
      clipboard,
      files: listFiles(),
      clients: publicClients(),
      chat: chatHistory(),
      server: {
        hostname: os.hostname(),
        port: PORT,
        addresses: localAddresses(),
        startedAt: startedAt
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/events") {
    return addEventClient(req, res, url);
  }

  if (req.method === "POST" && pathname === "/api/heartbeat") {
    try {
      const body = await readJson(req);
      const id = String(body.clientId || crypto.randomUUID()).slice(0, 80);
      const previous = pollClients.get(id);
      const client = {
        id,
        name: String(body.name || "未命名设备").slice(0, 50),
        address: requestAddress(req),
        userAgent: req.headers["user-agent"] || "",
        connectedAt: previous ? previous.connectedAt : Date.now(),
        lastSeen: Date.now()
      };
      pollClients.set(id, client);
      if (!previous || previous.name !== client.name || previous.address !== client.address) {
        broadcast("devices", publicClients());
      }
      return json(res, 200, {
        clipboard,
        files: listFiles(),
        clients: publicClients(),
        chat: chatHistory()
      });
    } catch (err) {
      return error(res, 400, err.message);
    }
  }

  if (req.method === "POST" && pathname === "/api/clipboard") {
    try {
      const body = await readJson(req);
      const text = String(body.text || "").slice(0, 500000);
      clipboard = {
        text,
        updatedAt: Date.now(),
        deviceName: String(body.deviceName || "未知设备").slice(0, 50)
      };
      broadcast("clipboard", clipboard);
      return json(res, 200, clipboard);
    } catch (err) {
      return error(res, 400, err.message);
    }
  }

  if (req.method === "GET" && pathname === "/api/files") {
    return json(res, 200, { files: listFiles() });
  }

  if (req.method === "GET" && pathname === "/api/chat") {
    return json(res, 200, { messages: chatHistory() });
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return error(res, 400, err.message);
    }
    const text = String(body.text || "").trim().slice(0, 2000);
    if (!text) return error(res, 400, "消息不能为空");
    const message = {
      id: crypto.randomUUID(),
      clientId: String(body.clientId || "").slice(0, 80),
      deviceName: String(body.deviceName || "未知设备").slice(0, 50),
      text,
      sentAt: Date.now()
    };
    chatMessages.push(message);
    while (chatMessages.length > MAX_CHAT_MESSAGES) chatMessages.shift();
    broadcast("chat", message);
    return json(res, 201, message);
  }

  if (req.method === "POST" && pathname === "/api/upload") {
    const declaredSize = Number(req.headers["content-length"] || 0);
    // 不做单文件大小限制，只校验接收盘是否有足够剩余空间。
    const sizeLimit = Math.max(0, availableFreeSpace(UPLOAD_DIR) - FREE_SPACE_RESERVE);
    if (declaredSize > sizeLimit) return error(res, 413, "接收目录所在磁盘剩余空间不足");
    const originalName = safeFileName(safeDecode(req.headers["x-file-name"] || "file"));
    const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}--${originalName}`;
    const finalPath = path.join(UPLOAD_DIR, id);
    const tempPath = `${finalPath}.part`;
    const stream = fs.createWriteStream(tempPath, { flags: "wx" });
    let received = 0;
    let settled = false;

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      fs.rm(tempPath, { force: true }, () => error(res, status, message));
    };

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > sizeLimit) fail(413, "接收目录所在磁盘剩余空间不足");
    });
    req.on("aborted", () => fail(400, "上传已中断"));
    req.on("error", () => fail(500, "上传失败"));
    stream.on("error", () => fail(500, "无法保存文件"));
    stream.on("finish", () => {
      if (settled) return;
      fs.rename(tempPath, finalPath, (err) => {
        if (err) return fail(500, "无法完成文件保存");
        settled = true;
        const files = listFiles();
        broadcast("files", files);
        json(res, 201, { file: files.find((file) => file.id === id) });
      });
    });
    req.pipe(stream);
    return;
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/files/")) {
    const id = path.basename(safeDecode(pathname.slice("/api/files/".length)));
    const filePath = path.join(UPLOAD_DIR, id);
    if (!filePath.startsWith(UPLOAD_DIR)) return error(res, 403, "禁止访问");
    fs.rm(filePath, { force: false }, (err) => {
      if (err) return error(res, err.code === "ENOENT" ? 404 : 500, "无法删除文件");
      const files = listFiles();
      broadcast("files", files);
      json(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/devices") {
    const arp = await arpDevices();
    return json(res, 200, {
      clients: publicClients(),
      arp,
      server: {
        name: os.hostname(),
        addresses: localAddresses().map((entry) => entry.address)
      },
      scannedAt: Date.now()
    });
  }

  if (req.method === "GET" && pathname === "/api/ping") {
    return json(res, 200, { now: Date.now() });
  }

  if (req.method === "GET" && pathname === "/api/speed/download") {
    const bytes = Math.min(Math.max(Number(url.searchParams.get("bytes") || 10 * 1024 * 1024), 1), MAX_SPEED_BYTES);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes,
      "Cache-Control": "no-store"
    });
    const chunk = crypto.randomBytes(64 * 1024);
    let remaining = bytes;
    function write() {
      while (remaining > 0) {
        const size = Math.min(remaining, chunk.length);
        remaining -= size;
        if (!res.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          res.once("drain", write);
          return;
        }
      }
      res.end();
    }
    write();
    return;
  }

  if (req.method === "POST" && pathname === "/api/speed/upload") {
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_SPEED_BYTES) req.destroy();
    });
    req.on("end", () => json(res, 200, { bytes }));
    req.on("error", () => {
      if (!res.headersSent) error(res, 400, "测速上传失败");
    });
    return;
  }

  return error(res, 404, "接口不存在");
}

// ---------- 启动 ----------

const startedAt = Date.now();

// ---------- 命令行子模式（设置密码等，执行完即退出） ----------

if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
  process.exit(0);
}

if (hasFlag("--show-config")) {
  access.load();
  console.log("");
  console.log(`  平台      ${PLATFORM}`);
  console.log(`  设置目录  ${SETTINGS_DIR}`);
  console.log(`  接收目录  ${UPLOAD_DIR}`);
  console.log(`  端口      ${PORT}`);
  console.log(`  访问密码  ${access.enabled ? "已启用" : "未启用"}`);
  console.log("");
  process.exit(0);
}

if (hasFlag("--set-password")) {
  try {
    access.save(true, argValue("--set-password"));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(`访问密码已启用，设置文件：${access.settingsFile}`);
  process.exit(0);
}

if (hasFlag("--disable-password")) {
  access.save(false, "");
  console.log(`访问密码已关闭，设置文件：${access.settingsFile}`);
  process.exit(0);
}

access.load();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

setInterval(() => {
  if (removeStalePollClients()) broadcast("devices", publicClients());
}, 5000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) error(res, 500, "服务器内部错误");
    });
  } else if (url.pathname.startsWith("/download/")) {
    if (!access.isAuthorized(req, url)) return error(res, 401, "需要访问密码");
    handleDownload(req, res, url);
  } else {
    serveStatic(req, res, url);
  }
});

server.on("clientError", (_, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

server.listen(PORT, HOST, () => {
  const platformName = PLATFORM === "darwin" ? "macOS" : PLATFORM === "win32" ? "Windows" : "Linux";
  console.log("");
  console.log("  近邻 · 局域网工具箱（Node 版）");
  console.log(`  运行平台: ${platformName}`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  for (const item of localAddresses()) {
    console.log(`  局域网访问: ${item.url}`);
  }
  console.log(`  接收目录: ${UPLOAD_DIR}`);
  console.log(`  访问密码: ${access.enabled ? `已启用（${access.password}）` : "未启用"}`);
  console.log("");
  console.log("  保持此窗口开启，按 Ctrl+C 停止。");
  console.log("");
});
