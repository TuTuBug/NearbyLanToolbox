"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "data", "uploads");
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
const MAX_SPEED_BYTES = 100 * 1024 * 1024;
const POLL_CLIENT_TTL = 15000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let clipboard = { text: "", updatedAt: null, deviceName: "" };
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

function localAddresses() {
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push({
          interfaceName,
          address: entry.address,
          url: `http://${entry.address}:${PORT}`
        });
      }
    }
  }
  const score = (item) => {
    const name = item.interfaceName;
    let value = 0;
    if (/wi-?fi|wlan|无线/i.test(name)) value += 100;
    else if (/ethernet|以太网/i.test(name)) value += 70;
    if (/vpn|openvpn|vmware|virtual|vethernet|wsl|tailscale|hamachi|loopback/i.test(name)) value -= 150;
    return value;
  };
  return addresses.sort((a, b) => score(b) - score(a));
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
  res.write(`event: ready\ndata: ${JSON.stringify({ clipboard })}\n\n`);

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

function parseArpOutput(stdout) {
  const devices = [];
  const seen = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\s+(\S+)/i);
    if (!match) continue;
    const address = match[1];
    const mac = match[2].replace(/-/g, ":").toUpperCase();
    const firstOctet = Number(address.split(".")[0]);
    if (
      seen.has(address) ||
      firstOctet >= 224 ||
      address.endsWith(".255") ||
      mac === "FF:FF:FF:FF:FF:FF" ||
      mac.startsWith("01:00:5E")
    ) continue;
    seen.add(address);
    devices.push({
      address,
      mac,
      type: match[3]
    });
  }
  return devices;
}

function arpDevices() {
  return new Promise((resolve) => {
    execFile("arp", ["-a"], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parseArpOutput(stdout));
    });
  });
}

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

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, {
      clipboard,
      files: listFiles(),
      clients: publicClients(),
      server: {
        hostname: os.hostname(),
        port: PORT,
        addresses: localAddresses(),
        startedAt: startedAt
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    return addEventClient(req, res, url);
  }

  if (req.method === "POST" && url.pathname === "/api/heartbeat") {
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
        clients: publicClients()
      });
    } catch (err) {
      return error(res, 400, err.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/clipboard") {
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

  if (req.method === "GET" && url.pathname === "/api/files") {
    return json(res, 200, { files: listFiles() });
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    const declaredSize = Number(req.headers["content-length"] || 0);
    if (declaredSize > MAX_UPLOAD) return error(res, 413, "文件超过 2 GB");
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
      if (received > MAX_UPLOAD) fail(413, "文件超过 2 GB");
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

  if (req.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
    const id = path.basename(safeDecode(url.pathname.slice("/api/files/".length)));
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

  if (req.method === "GET" && url.pathname === "/api/devices") {
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

  if (req.method === "GET" && url.pathname === "/api/ping") {
    return json(res, 200, { now: Date.now() });
  }

  if (req.method === "GET" && url.pathname === "/api/speed/download") {
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

  if (req.method === "POST" && url.pathname === "/api/speed/upload") {
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

const startedAt = Date.now();
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
    handleDownload(req, res, url);
  } else {
    serveStatic(req, res, url);
  }
});

server.on("clientError", (_, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Nearby LAN Toolbox is running");
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const item of localAddresses()) console.log(`  Network: ${item.url}`);
  console.log("");
  console.log("  Keep this window open. Press Ctrl+C to stop.");
});
