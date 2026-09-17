"use strict";

/**
 * 访问密码（跨平台，与 exe 版共用同一份设置文件与语义）
 *
 * 设置文件格式与 exe 版完全一致：
 *   第一行  1 表示启用，0 表示关闭
 *   第二行  4 到 8 位数字密码
 *
 *   访问密码   <设置目录>/access-settings.txt
 *   设置目录   Windows  %LOCALAPPDATA%\NearbyLanToolbox
 *              macOS    ~/Library/Application Support/NearbyLanToolbox
 *              Linux    $XDG_CONFIG_HOME/NearbyLanToolbox 或 ~/.config/NearbyLanToolbox
 *
 * 抽成独立模块的原因：非回环请求路径无法在开发机上实测（防火墙会拦本机
 * 到自身局域网地址的连接），必须靠单元测试覆盖，见 tools/test-access.js。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_NAME = "NearbyLanToolbox";
const PASSWORD_PATTERN = /^\d{4,8}$/;

function defaultSettingsDirectory(platform, env, home) {
  const targetPlatform = platform || process.platform;
  const environment = env || process.env;
  const homeDirectory = home || os.homedir();

  // 按目标平台选路径语义，而不是按当前运行平台。
  // 这样该函数在任意平台上调用都能算出正确结果（便于跨平台单元测试，
  // 也避免把 Windows 的反斜杠混进 macOS 路径）。
  const join = targetPlatform === "win32" ? path.win32.join : path.posix.join;

  if (targetPlatform === "win32") {
    const base = environment.LOCALAPPDATA || join(homeDirectory, "AppData", "Local");
    return join(base, APP_NAME);
  }
  if (targetPlatform === "darwin") {
    return join(homeDirectory, "Library", "Application Support", APP_NAME);
  }
  const base = environment.XDG_CONFIG_HOME || join(homeDirectory, ".config");
  return join(base, APP_NAME);
}

function isValidPassword(value) {
  return PASSWORD_PATTERN.test(String(value == null ? "" : value).trim());
}

// 定长比较，避免用响应时间侧信道推断密码。
function secureEquals(expected, supplied) {
  const left = Buffer.from(String(expected == null ? "" : expected), "utf8");
  const right = Buffer.from(String(supplied == null ? "" : supplied).trim(), "utf8");
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const a = i < left.length ? left[i] : 0;
    const b = i < right.length ? right[i] : 0;
    difference |= a ^ b;
  }
  return difference === 0;
}

function isLoopbackAddress(address) {
  const value = String(address == null ? "" : address);
  if (value === "::1") return true;
  if (value.startsWith("127.")) return true;
  // IPv4-mapped IPv6，如 ::ffff:127.0.0.1
  if (value.startsWith("::ffff:127.")) return true;
  return false;
}

function requestIsLoopback(req) {
  return isLoopbackAddress(req && req.socket ? req.socket.remoteAddress : "");
}

// 密码可通过 X-Access-Code 请求头或 ?accessCode= 查询串传入。
// SSE（/api/events）无法自定义请求头，所以查询串这条路是必需的。
function suppliedCode(req, url) {
  const header = req && req.headers ? req.headers["x-access-code"] : null;
  if (header) return String(header);
  if (url && url.searchParams && typeof url.searchParams.get === "function") {
    return url.searchParams.get("accessCode") || "";
  }
  return "";
}

function createAccessControl(options) {
  const settings = options || {};
  const settingsFile = settings.settingsFile
    || path.join(settings.settingsDirectory || defaultSettingsDirectory(), "access-settings.txt");

  let enabled = false;
  let password = "";

  function load() {
    enabled = false;
    password = "";
    try {
      if (!fs.existsSync(settingsFile)) return;
      const lines = fs.readFileSync(settingsFile, "utf8").split(/\r?\n/);
      const storedEnabled = lines.length > 0 && lines[0].trim() === "1";
      const storedPassword = lines.length > 1 ? lines[1].trim() : "";
      if (storedEnabled && PASSWORD_PATTERN.test(storedPassword)) {
        enabled = true;
        password = storedPassword;
      }
    } catch {
      // 读不到或格式损坏就按「未启用」处理，与 exe 版行为一致。
    }
  }

  function save(enable, value) {
    const nextPassword = String(value == null ? "" : value).trim();
    if (enable && !PASSWORD_PATTERN.test(nextPassword)) {
      throw new Error("访问密码必须是 4 到 8 位数字");
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${enable ? "1" : "0"}\n${enable ? nextPassword : ""}`, "utf8");
    enabled = Boolean(enable);
    password = enable ? nextPassword : "";
  }

  function matches(supplied) {
    return secureEquals(password, supplied);
  }

  function isAuthorized(req, url) {
    if (requestIsLoopback(req) || !enabled) return true;
    return matches(suppliedCode(req, url));
  }

  // 登录接口语义：回环、未启用、或密码正确，都算通过。
  function verify(req, submitted) {
    return requestIsLoopback(req) || !enabled || matches(submitted);
  }

  function status(req, url) {
    const required = !requestIsLoopback(req) && enabled;
    return {
      enabled,
      required,
      authenticated: !required || isAuthorized(req, url)
    };
  }

  return {
    settingsFile,
    load,
    save,
    matches,
    isAuthorized,
    verify,
    status,
    get enabled() { return enabled; },
    get password() { return password; }
  };
}

module.exports = {
  APP_NAME,
  defaultSettingsDirectory,
  isValidPassword,
  secureEquals,
  isLoopbackAddress,
  requestIsLoopback,
  createAccessControl
};
