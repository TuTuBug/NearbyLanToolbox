"use strict";

/**
 * 访问密码与授权判定测试
 *
 * 重点覆盖「非回环请求」路径：开发机上无法实测 —— Windows 防火墙会拦掉
 * 本机到自身局域网地址的连接，所以只能靠这里的单元测试保证正确性。
 *
 * 运行:  node tools/test-access.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  defaultSettingsDirectory,
  isValidPassword,
  secureEquals,
  isLoopbackAddress,
  requestIsLoopback,
  createAccessControl
} = require("../lib/access");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${error.message}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlt-access-test-"));

// 伪造请求对象：headers 的键在真实 Node 中是小写
function fakeRequest(address, headers) {
  return { socket: { remoteAddress: address }, headers: headers || {} };
}

function fakeUrl(query) {
  return new URL(`http://localhost/api/state${query ? `?${query}` : ""}`);
}

const LOOPBACK = "127.0.0.1";
const LAN = "192.168.110.50";     // 模拟另一台设备的请求

console.log("");
console.log("访问密码与授权判定测试");
console.log("");

// ---------- 设置目录 ----------

test("设置目录: Windows 用 LOCALAPPDATA", () => {
  const dir = defaultSettingsDirectory("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "/home/me");
  // 必须用 path.win32.join：被断言的是「Windows 上的路径」，
  // 若用当前平台的 path.join，在 Linux/macOS 上跑测试会得到正斜杠而误判失败。
  assert.strictEqual(dir, path.win32.join("C:\\Users\\me\\AppData\\Local", "NearbyLanToolbox"));
  assert.ok(!dir.includes("/"), `Windows 路径不应含正斜杠：${dir}`);
});

test("设置目录: Windows 未设 LOCALAPPDATA 时退回 ~/AppData/Local", () => {
  const dir = defaultSettingsDirectory("win32", {}, "C:\\Users\\me");
  assert.strictEqual(dir, "C:\\Users\\me\\AppData\\Local\\NearbyLanToolbox");
});

test("设置目录: macOS 用 ~/Library/Application Support", () => {
  const dir = defaultSettingsDirectory("darwin", {}, "/Users/me");
  assert.strictEqual(dir, "/Users/me/Library/Application Support/NearbyLanToolbox");
});

test("设置目录: Linux 用 XDG_CONFIG_HOME", () => {
  assert.strictEqual(
    defaultSettingsDirectory("linux", { XDG_CONFIG_HOME: "/home/me/.config" }, "/home/me"),
    "/home/me/.config/NearbyLanToolbox"
  );
});

test("设置目录: Linux 未设 XDG 时退回 ~/.config", () => {
  assert.strictEqual(
    defaultSettingsDirectory("linux", {}, "/home/me"),
    "/home/me/.config/NearbyLanToolbox"
  );
});

// ---------- 密码格式与比较 ----------

test("密码格式: 4 到 8 位数字有效", () => {
  assert.ok(isValidPassword("1234"));
  assert.ok(isValidPassword("12345678"));
});

test("密码格式: 过短/过长/非数字/空 无效", () => {
  assert.ok(!isValidPassword("123"));
  assert.ok(!isValidPassword("123456789"));
  assert.ok(!isValidPassword("12a4"));
  assert.ok(!isValidPassword(""));
  assert.ok(!isValidPassword(null));
});

test("定长比较: 相同与不同", () => {
  assert.ok(secureEquals("1234", "1234"));
  assert.ok(!secureEquals("1234", "1235"));
  assert.ok(!secureEquals("1234", "12345"));
  assert.ok(!secureEquals("", "1"));
});

test("定长比较: 忽略两侧空白", () => {
  assert.ok(secureEquals("1234", "  1234  "));
});

test("定长比较: 空对空视为相同（未启用时的语义）", () => {
  assert.ok(secureEquals("", ""));
});

// ---------- 回环判定 ----------

test("回环判定: 127.0.0.1 / ::1 / IPv4-mapped", () => {
  assert.ok(isLoopbackAddress("127.0.0.1"));
  assert.ok(isLoopbackAddress("127.1.2.3"));
  assert.ok(isLoopbackAddress("::1"));
  assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
});

test("回环判定: 局域网地址不是回环", () => {
  assert.ok(!isLoopbackAddress("192.168.110.50"));
  assert.ok(!isLoopbackAddress("10.0.0.8"));
  assert.ok(!isLoopbackAddress("::ffff:192.168.110.50"));
  assert.ok(!isLoopbackAddress(""));
});

test("回环判定: 从请求对象取值", () => {
  assert.ok(requestIsLoopback(fakeRequest("127.0.0.1")));
  assert.ok(!requestIsLoopback(fakeRequest("192.168.110.50")));
  assert.ok(!requestIsLoopback({}));
});

// ---------- 未启用密码 ----------

test("未启用: 回环请求放行", () => {
  const access = createAccessControl({ settingsFile: path.join(tmpDir, "none-1.txt") });
  access.load();
  assert.strictEqual(access.enabled, false);
  assert.ok(access.isAuthorized(fakeRequest(LOOPBACK), fakeUrl()));
});

test("未启用: 非回环请求也放行", () => {
  const access = createAccessControl({ settingsFile: path.join(tmpDir, "none-2.txt") });
  access.load();
  assert.ok(access.isAuthorized(fakeRequest(LAN), fakeUrl()));
});

test("未启用: status.required 为 false 且已认证", () => {
  const access = createAccessControl({ settingsFile: path.join(tmpDir, "none-3.txt") });
  access.load();
  const status = access.status(fakeRequest(LAN), fakeUrl());
  assert.deepStrictEqual(status, { enabled: false, required: false, authenticated: true });
});

// ---------- 启用密码 ----------

const enabledFile = path.join(tmpDir, "enabled.txt");

function enabledAccess() {
  const access = createAccessControl({ settingsFile: enabledFile });
  access.save(true, "1234");
  return access;
}

test("启用: 设置文件格式与 exe 版一致（首行 1，次行密码）", () => {
  const access = enabledAccess();
  assert.strictEqual(fs.readFileSync(access.settingsFile, "utf8"), "1\n1234");
  assert.strictEqual(access.enabled, true);
  assert.strictEqual(access.password, "1234");
});

test("启用: 非回环 + 无密码 -> 拒绝", () => {
  const access = enabledAccess();
  assert.ok(!access.isAuthorized(fakeRequest(LAN), fakeUrl()));
});

test("启用: 非回环 + 错误密码 -> 拒绝", () => {
  const access = enabledAccess();
  assert.ok(!access.isAuthorized(fakeRequest(LAN, { "x-access-code": "9999" }), fakeUrl()));
});

test("启用: 非回环 + 正确密码（请求头）-> 通过", () => {
  const access = enabledAccess();
  assert.ok(access.isAuthorized(fakeRequest(LAN, { "x-access-code": "1234" }), fakeUrl()));
});

test("启用: 非回环 + 正确密码（查询串）-> 通过", () => {
  const access = enabledAccess();
  assert.ok(access.isAuthorized(fakeRequest(LAN), fakeUrl("accessCode=1234")));
});

test("启用: 查询串密码错误 -> 拒绝", () => {
  const access = enabledAccess();
  assert.ok(!access.isAuthorized(fakeRequest(LAN), fakeUrl("accessCode=0000")));
});

test("启用: 请求头优先于查询串", () => {
  const access = enabledAccess();
  const request = fakeRequest(LAN, { "x-access-code": "1234" });
  assert.ok(access.isAuthorized(request, fakeUrl("accessCode=0000")));
});

test("启用: 回环请求免密码 -> 通过", () => {
  const access = enabledAccess();
  assert.ok(access.isAuthorized(fakeRequest(LOOPBACK), fakeUrl()));
  assert.ok(access.isAuthorized(fakeRequest("::1"), fakeUrl()));
});

test("启用: status 对非回环返回 required=true", () => {
  const access = enabledAccess();
  const bare = access.status(fakeRequest(LAN), fakeUrl());
  assert.deepStrictEqual(bare, { enabled: true, required: true, authenticated: false });

  const withCode = access.status(fakeRequest(LAN), fakeUrl("accessCode=1234"));
  assert.strictEqual(withCode.authenticated, true);
});

test("启用: status 对回环返回 required=false", () => {
  const access = enabledAccess();
  const status = access.status(fakeRequest(LOOPBACK), fakeUrl());
  assert.deepStrictEqual(status, { enabled: true, required: false, authenticated: true });
});

test("启用: verify 放行回环请求", () => {
  const access = enabledAccess();
  assert.ok(access.verify(fakeRequest(LOOPBACK), ""));
  assert.ok(access.verify(fakeRequest(LOOPBACK), "随便什么"));
});

test("启用: verify 校验非回环请求的密码", () => {
  const access = enabledAccess();
  assert.ok(access.verify(fakeRequest(LAN), "1234"));
  assert.ok(access.verify(fakeRequest(LAN), " 1234 "));
  assert.ok(!access.verify(fakeRequest(LAN), "0000"));
  assert.ok(!access.verify(fakeRequest(LAN), ""));
});

// ---------- 读写往返与容错 ----------

test("保存后重新 load 状态一致", () => {
  enabledAccess();
  const reloaded = createAccessControl({ settingsFile: enabledFile });
  reloaded.load();
  assert.strictEqual(reloaded.enabled, true);
  assert.strictEqual(reloaded.password, "1234");
});

test("关闭密码后文件置为 0 且不再校验", () => {
  const access = enabledAccess();
  access.save(false, "");
  assert.strictEqual(fs.readFileSync(access.settingsFile, "utf8"), "0\n");
  assert.strictEqual(access.enabled, false);
  assert.ok(access.isAuthorized(fakeRequest(LAN), fakeUrl()));

  const reloaded = createAccessControl({ settingsFile: enabledFile });
  reloaded.load();
  assert.strictEqual(reloaded.enabled, false);
});

test("保存非法密码抛错且不落盘", () => {
  const file = path.join(tmpDir, "invalid.txt");
  const access = createAccessControl({ settingsFile: file });
  assert.throws(() => access.save(true, "12"), /4 到 8 位数字/);
  assert.throws(() => access.save(true, "abcd"), /4 到 8 位数字/);
  assert.ok(!fs.existsSync(file));
});

test("设置文件缺失时按未启用处理", () => {
  const access = createAccessControl({ settingsFile: path.join(tmpDir, "does-not-exist.txt") });
  access.load();
  assert.strictEqual(access.enabled, false);
});

test("设置文件损坏时按未启用处理", () => {
  const cases = ["", "1\n", "1\nabc", "1\n123", "0\n1234", "garbage\nxyz"];
  cases.forEach((content, index) => {
    const file = path.join(tmpDir, `broken-${index}.txt`);
    fs.writeFileSync(file, content, "utf8");
    const access = createAccessControl({ settingsFile: file });
    access.load();
    assert.strictEqual(access.enabled, false, `内容 ${JSON.stringify(content)} 应视为未启用`);
  });
});

test("能读取 exe 版写出的设置文件（含 CRLF）", () => {
  const file = path.join(tmpDir, "from-exe.txt");
  fs.writeFileSync(file, "1\r\n5678\r\n", "utf8");
  const access = createAccessControl({ settingsFile: file });
  access.load();
  assert.strictEqual(access.enabled, true);
  assert.strictEqual(access.password, "5678");
});

test("目录不存在时保存会自动创建", () => {
  const nested = path.join(tmpDir, "deep", "nested", "access-settings.txt");
  const access = createAccessControl({ settingsFile: nested });
  access.save(true, "4321");
  assert.ok(fs.existsSync(nested));
});

// ---------- 清理 ----------

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
console.log(`结果: ${passed} 项通过, ${failed} 项失败`);
console.log("");

process.exit(failed === 0 ? 0 : 1);
