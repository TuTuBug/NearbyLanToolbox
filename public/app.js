"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Private browsing modes may disable persistent storage.
  }
}

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeSession(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch (error) {
    // Session storage may be unavailable.
  }
}

function createClientId() {
  const browserCrypto = window.crypto || window.msCrypto;
  if (browserCrypto && typeof browserCrypto.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (browserCrypto && typeof browserCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => {
      const hex = byte.toString(16);
      return hex.length === 1 ? `0${hex}` : hex;
    }).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const state = {
  clientId: readStorage("nearby-client-id") || createClientId(),
  deviceName: readStorage("nearby-device-name") || defaultDeviceName(),
  files: [],
  speedMb: 25,
  serverUrl: location.origin,
  eventSource: null,
  eventErrors: 0,
  pollTimer: null,
  accessCode: readSession("nearby-access-code") || "",
  chatMessages: [],
  initialized: false
};
writeStorage("nearby-client-id", state.clientId);

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android 手机";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows 电脑";
  return "浏览器设备";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatTime(value) {
  if (!value) return "尚未同步";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

async function apiFetch(url, options = {}) {
  const next = { ...options };
  next.headers = new Headers(options.headers || {});
  if (state.accessCode) next.headers.set("X-Access-Code", state.accessCode);
  const response = await fetch(url, next);
  if (response.status === 401 && !url.startsWith("/api/auth")) {
    state.accessCode = "";
    writeSession("nearby-access-code", "");
    showAuth();
  }
  return response;
}

function authorizedUrl(url) {
  if (!state.accessCode) return url;
  return `${url}${url.includes("?") ? "&" : "?"}accessCode=${encodeURIComponent(state.accessCode)}`;
}

let toastTimer;
function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast("已复制");
  }
}

const views = {
  clipboard: ["共享剪贴板", "跨设备实时同步"],
  files: ["文件快传", "上传、下载与集中暂存"],
  devices: ["设备列表", "查看当前局域网中的邻居"],
  chat: ["局域网聊天", "同一网络中的即时交流"],
  speed: ["局域网测速", "测量设备到服务电脑的链路"]
};

$$(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.dataset.view;
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
    $("#page-title").textContent = views[name][0];
    $("#eyebrow").textContent = views[name][1];
    if (name === "devices") loadDevices();
    if (name === "files") loadFiles();
  });
});

$("#device-name").value = state.deviceName;
$("#device-name").addEventListener("change", () => {
  state.deviceName = $("#device-name").value.trim() || defaultDeviceName();
  $("#device-name").value = state.deviceName;
  writeStorage("nearby-device-name", state.deviceName);
  connectEvents();
});

function applyClipboard(data) {
  data = data || {};
  const text = String(data.text || "");
  if ($("#clipboard-text").value !== text) $("#clipboard-text").value = text;
  $("#clipboard-count").textContent = `${text.length} 字符`;
  $("#clipboard-meta").textContent = data.updatedAt
    ? `${data.deviceName || "未知设备"} · ${formatTime(data.updatedAt)}`
    : "尚未同步";
}

$("#clipboard-text").addEventListener("input", () => {
  $("#clipboard-count").textContent = `${$("#clipboard-text").value.length} 字符`;
});
$("#sync-clipboard").addEventListener("click", async () => {
  const response = await apiFetch("/api/clipboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: $("#clipboard-text").value, deviceName: state.deviceName })
  });
  if (!response.ok) return toast("同步失败");
  toast("已同步到局域网");
});
$("#copy-clipboard").addEventListener("click", () => copyText($("#clipboard-text").value));

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  stopPolling();
  state.eventErrors = 0;
  if (typeof window.EventSource !== "function") {
    startPolling();
    return;
  }
  let query = `clientId=${encodeURIComponent(state.clientId)}&name=${encodeURIComponent(state.deviceName)}`;
  if (state.accessCode) query += `&accessCode=${encodeURIComponent(state.accessCode)}`;
  const source = new EventSource(`/api/events?${query}`);
  state.eventSource = source;
  source.addEventListener("open", () => {
    state.eventErrors = 0;
    setConnectionState(true);
  });
  source.addEventListener("ready", (event) => {
    setConnectionState(true);
    const data = JSON.parse(event.data);
    applyClipboard(data.clipboard);
    renderChat(data.chat || []);
  });
  source.addEventListener("error", () => {
    setConnectionState(false);
    state.eventErrors += 1;
    if (state.eventErrors >= 2) {
      source.close();
      if (state.eventSource === source) state.eventSource = null;
      startPolling();
    }
  });
  source.addEventListener("clipboard", (event) => applyClipboard(JSON.parse(event.data)));
  source.addEventListener("files", (event) => renderFiles(JSON.parse(event.data)));
  source.addEventListener("chat", (event) => addChatMessage(JSON.parse(event.data)));
  source.addEventListener("devices", (event) => {
    const clients = JSON.parse(event.data);
    $("#client-count").textContent = clients.length;
    $("#active-device-count").textContent = clients.length;
  });
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function startPolling() {
  stopPolling();
  async function poll() {
    try {
      const response = await apiFetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ clientId: state.clientId, name: state.deviceName })
      });
      if (!response.ok) throw new Error("heartbeat failed");
      const data = await response.json();
      applyClipboard(data.clipboard);
      renderFiles(data.files || []);
      renderChat(data.chat || []);
      $("#client-count").textContent = data.clients.length;
      $("#active-device-count").textContent = data.clients.length;
      setConnectionState(true);
    } catch (error) {
      setConnectionState(false);
    }
    state.pollTimer = setTimeout(poll, 2000);
  }
  poll();
}

function setConnectionState(connected) {
  const sidebarText = $(".status-line span");
  if (sidebarText) sidebarText.textContent = connected ? "服务已连接" : "连接重试中";
  const sidebarDot = $(".status-line i");
  const identityDot = $(".online-dot");
  if (sidebarDot) sidebarDot.classList.toggle("offline", !connected);
  if (identityDot) identityDot.classList.toggle("offline", !connected);
  const chatStatus = $("#chat-status");
  if (chatStatus) chatStatus.textContent = connected ? "已连接" : "连接重试中";
}

function fileExtension(name) {
  const parts = name.split(".");
  return parts.length > 1 ? parts.pop().slice(0, 4).toUpperCase() : "FILE";
}

function renderFiles(files) {
  state.files = files || [];
  const list = $("#file-list");
  if (!state.files.length) {
    list.innerHTML = '<div class="empty">还没有共享文件</div>';
    return;
  }
  list.innerHTML = state.files.map((file) => `
    <div class="file-row">
      <div class="file-type">${escapeHtml(fileExtension(file.name))}</div>
      <div class="file-info">
        <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)} · ${formatTime(file.uploadedAt)}</span>
      </div>
      <a class="file-action" href="${authorizedUrl(file.url)}">下载</a>
      <button class="file-action danger" data-delete="${encodeURIComponent(file.id)}">删除</button>
    </div>
  `).join("");
  $$("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("从共享列表中删除这个文件？")) return;
    const response = await apiFetch(`/api/files/${button.dataset.delete}`, { method: "DELETE" });
    if (response.ok) loadFiles();
    else toast("删除失败");
  }));
}

async function loadFiles() {
  const response = await apiFetch("/api/files", { cache: "no-store" });
  if (response.ok) renderFiles((await response.json()).files);
}

function uploadFile(file) {
  const item = document.createElement("div");
  item.className = "upload-item";
  item.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>等待上传</span><div class="progress"><i></i></div>`;
  $("#upload-queue").prepend(item);
  const label = item.querySelector("span");
  const bar = item.querySelector("i");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  if (state.accessCode) xhr.setRequestHeader("X-Access-Code", state.accessCode);
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round(event.loaded / event.total * 100);
    bar.style.width = `${percent}%`;
    label.textContent = `${percent}%`;
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      label.textContent = "完成";
      bar.style.width = "100%";
      loadFiles();
      setTimeout(() => item.remove(), 1800);
    } else {
      label.textContent = "失败";
      bar.style.background = "var(--red)";
      if (xhr.status === 401) showAuth();
    }
  };
  xhr.onerror = () => { label.textContent = "网络错误"; };
  xhr.send(file);
}

const dropZone = $("#drop-zone");
dropZone.addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (event) => {
  Array.from(event.target.files).forEach(uploadFile);
  event.target.value = "";
});
["dragenter", "dragover"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
}));
dropZone.addEventListener("drop", (event) => Array.from(event.dataTransfer.files).forEach(uploadFile));
$("#refresh-files").addEventListener("click", loadFiles);

function deviceRows(data) {
  const rows = [];
  const liveIps = new Set();
  const server = data.server || {};
  const serverAddresses = server.addresses || [];
  for (const client of data.clients || []) {
    liveIps.add(client.address);
    rows.push({
      name: client.name,
      address: client.address,
      mac: "—",
      source: "工具箱",
      live: true
    });
  }
  for (const address of serverAddresses) {
    if (!liveIps.has(address)) rows.unshift({
      name: `${server.name || "本机"}（服务电脑）`,
      address,
      mac: "—",
      source: "本机",
      live: true
    });
  }
  for (const device of data.arp || []) {
    if (liveIps.has(device.address) || serverAddresses.includes(device.address)) continue;
    rows.push({
      name: "局域网设备",
      address: device.address,
      mac: device.mac,
      source: "ARP 缓存",
      live: false
    });
  }
  return rows;
}

async function loadDevices() {
  $("#refresh-devices").disabled = true;
  $("#refresh-devices").textContent = "扫描中…";
  try {
    const response = await apiFetch("/api/devices", { cache: "no-store" });
    const data = await response.json();
    $("#active-device-count").textContent = data.clients.length;
    $("#arp-device-count").textContent = data.arp.length;
    $("#server-name").textContent = data.server.name;
    $("#scan-time").textContent = `扫描于 ${formatTime(data.scannedAt)}`;
    const rows = deviceRows(data);
    $("#device-table").innerHTML = rows.length ? rows.map((device) => `
      <tr>
        <td><div class="device-name-cell"><span class="device-avatar">${device.live ? "ON" : "IP"}</span><strong>${escapeHtml(device.name)}</strong></div></td>
        <td><code>${escapeHtml(device.address)}</code></td>
        <td><code>${escapeHtml(device.mac)}</code></td>
        <td><span class="tag ${device.live ? "live" : ""}">${escapeHtml(device.source)}</span></td>
        <td class="status-cell ${device.live ? "live" : ""}">${device.live ? "在线" : "缓存记录"}</td>
      </tr>
    `).join("") : '<tr><td colspan="5" class="empty">没有发现设备</td></tr>';
  } catch (error) {
    toast("设备扫描失败");
  } finally {
    $("#refresh-devices").disabled = false;
    $("#refresh-devices").textContent = "重新扫描";
  }
}
$("#refresh-devices").addEventListener("click", loadDevices);

function chatMessageHtml(message) {
  const own = message.clientId === state.clientId;
  return `
    <div class="chat-message ${own ? "own" : ""}" data-message-id="${escapeHtml(message.id)}">
      <div class="chat-meta">${escapeHtml(message.deviceName || "未知设备")} · ${formatTime(message.sentAt)}</div>
      <div class="chat-bubble">${escapeHtml(message.text || "")}</div>
    </div>
  `;
}

function renderChat(messages) {
  messages = messages || [];
  const currentIds = state.chatMessages.map((message) => message.id).join("|");
  const nextIds = messages.map((message) => message.id).join("|");
  if (currentIds === nextIds) return;
  state.chatMessages = messages.slice(-200);
  const list = $("#chat-messages");
  list.innerHTML = state.chatMessages.length
    ? state.chatMessages.map(chatMessageHtml).join("")
    : '<div class="chat-empty">还没有消息，发一句打个招呼吧</div>';
  list.scrollTop = list.scrollHeight;
}

function addChatMessage(message) {
  if (!message || state.chatMessages.some((item) => item.id === message.id)) return;
  state.chatMessages.push(message);
  if (state.chatMessages.length > 200) state.chatMessages.shift();
  const list = $("#chat-messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const empty = list.querySelector(".chat-empty");
  if (empty) empty.remove();
  list.insertAdjacentHTML("beforeend", chatMessageHtml(message));
  if (nearBottom || message.clientId === state.clientId) list.scrollTop = list.scrollHeight;
}

$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const response = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: state.clientId, deviceName: state.deviceName, text })
    });
    if (!response.ok) throw new Error("chat");
    addChatMessage(await response.json());
    input.value = "";
    input.focus();
  } catch (error) {
    toast("消息发送失败");
  } finally {
    button.disabled = false;
  }
});

$("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    const form = $("#chat-form");
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
});

$("#speed-size").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.speedMb = Number(button.dataset.mb);
  $$("#speed-size button").forEach((item) => item.classList.toggle("active", item === button));
});

async function measurePing() {
  const results = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await apiFetch(`/api/ping?t=${Date.now()}-${i}`, { cache: "no-store" });
    results.push(performance.now() - start);
  }
  results.sort((a, b) => a - b);
  return results[Math.floor(results.length / 2)];
}

async function measureDownload(bytes) {
  const start = performance.now();
  const response = await apiFetch(`/api/speed/download?bytes=${bytes}&t=${Date.now()}`, { cache: "no-store" });
  const buffer = await response.arrayBuffer();
  const seconds = (performance.now() - start) / 1000;
  return (buffer.byteLength * 8 / seconds) / 1_000_000;
}

async function measureUpload(bytes) {
  const data = new Uint8Array(bytes);
  const start = performance.now();
  const response = await apiFetch(`/api/speed/upload?t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data
  });
  if (!response.ok) throw new Error("upload");
  const seconds = (performance.now() - start) / 1000;
  return (bytes * 8 / seconds) / 1_000_000;
}

function setResult(id, barId, value, max, decimals = 1) {
  $(id).textContent = value.toFixed(decimals);
  $(barId).style.width = `${Math.min(value / max * 100, 100)}%`;
}

$("#start-speed").addEventListener("click", async () => {
  const button = $("#start-speed");
  button.disabled = true;
  $("#download-speed").textContent = $("#upload-speed").textContent = $("#ping-speed").textContent = "—";
  $$(".result-bar i").forEach((bar) => bar.style.width = "0");
  try {
    $("#speed-status").textContent = "正在测量延迟…";
    const ping = await measurePing();
    setResult("#ping-speed", "#ping-bar", ping, 100);
    $("#speed-status").textContent = `正在测试下载（${state.speedMb} MB）…`;
    const download = await measureDownload(state.speedMb * 1024 * 1024);
    setResult("#download-speed", "#download-bar", download, 1000);
    $("#speed-status").textContent = `正在测试上传（${state.speedMb} MB）…`;
    const upload = await measureUpload(state.speedMb * 1024 * 1024);
    setResult("#upload-speed", "#upload-bar", upload, 1000);
    $("#speed-status").textContent = "测试完成";
  } catch (error) {
    $("#speed-status").textContent = "测试失败，请检查网络连接";
  } finally {
    button.disabled = false;
  }
});

function showAuth() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  stopPolling();
  $("#auth-overlay").hidden = false;
  $("#auth-error").textContent = "";
  setConnectionState(false);
  setTimeout(() => $("#auth-password").focus(), 20);
}

function hideAuth() {
  $("#auth-overlay").hidden = true;
  $("#auth-password").value = "";
  $("#auth-error").textContent = "";
}

async function checkAccess() {
  const headers = {};
  if (state.accessCode) headers["X-Access-Code"] = state.accessCode;
  const response = await fetch("/api/auth/status", { headers, cache: "no-store" });
  if (!response.ok) throw new Error("auth status");
  const status = await response.json();
  if (status.required && !status.authenticated) {
    state.accessCode = "";
    writeSession("nearby-access-code", "");
    showAuth();
    return false;
  }
  return true;
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#auth-password").value.trim();
  const button = event.currentTarget.querySelector("button");
  if (!/^\d{4,8}$/.test(password)) {
    $("#auth-error").textContent = "请输入 4 到 8 位数字密码";
    return;
  }
  button.disabled = true;
  $("#auth-error").textContent = "";
  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!response.ok) {
      $("#auth-error").textContent = "密码错误，请重试";
      $("#auth-password").select();
      return;
    }
    state.accessCode = password;
    writeSession("nearby-access-code", password);
    hideAuth();
    await initialize();
  } catch (error) {
    $("#auth-error").textContent = "无法连接服务端";
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  try {
    if (!await checkAccess()) return;
    const response = await apiFetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("state");
    const data = await response.json();
    const firstAddress = data.server && data.server.addresses && data.server.addresses[0];
    const network = firstAddress && firstAddress.url ? firstAddress.url : location.origin;
    state.serverUrl = network;
    $("#address-button").textContent = network;
    $("#clipboard-address").textContent = network;
    $("#address-button").onclick = () => copyText(network);
    $("#clipboard-address").onclick = () => copyText(network);
    applyClipboard(data.clipboard);
    renderFiles(data.files);
    renderChat(data.chat || []);
    $("#client-count").textContent = Math.max(data.clients.length, 1);
    state.initialized = true;
    connectEvents();
  } catch (error) {
    toast("无法连接服务端");
    setConnectionState(false);
  }
}

initialize();
