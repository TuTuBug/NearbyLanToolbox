"use strict";

/**
 * ARP 输出解析测试（跨平台）
 *
 * macOS / Linux 的 arp 输出格式无法在开发机上实测，所以用各平台的真实样本
 * 做断言，保证解析逻辑正确。
 *
 * 运行:  node tools/test-arp-parser.js
 */

const assert = require("assert");
const { normalizeMac, describeInterface, parseArpOutput, arpCommands } = require("../lib/arp");

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

function addresses(devices) {
  return devices.map((device) => device.address).sort();
}

console.log("");
console.log("ARP 解析测试");
console.log("");

// ---------- Windows ----------

const WINDOWS_SAMPLE = [
  "",
  "接口: 192.168.110.100 --- 0xb",
  "  Internet 地址         物理地址              类型",
  "  192.168.110.1         00-1a-2b-3c-4d-5e     动态",
  "  192.168.110.46        a4-5e-60-12-34-56     动态",
  "  192.168.110.255       ff-ff-ff-ff-ff-ff     静态",
  "  224.0.0.22            01-00-5e-00-00-16     静态",
  "  224.0.0.251           01-00-5e-00-00-fb     静态",
  "  239.255.255.250       01-00-5e-7f-ff-fa     静态",
  "  255.255.255.255       ff-ff-ff-ff-ff-ff     静态",
  "接口: 192.168.56.1 --- 0x10",
  "  Internet 地址         物理地址              类型",
  "  192.168.56.255        ff-ff-ff-ff-ff-ff     静态"
].join("\r\n");

test("Windows: 只保留真实主机，过滤广播与组播", () => {
  const devices = parseArpOutput(WINDOWS_SAMPLE);
  assert.deepStrictEqual(addresses(devices), ["192.168.110.1", "192.168.110.46"]);
});

test("Windows: 短横线 MAC 归一化为冒号大写", () => {
  const devices = parseArpOutput(WINDOWS_SAMPLE);
  const first = devices.find((device) => device.address === "192.168.110.1");
  assert.strictEqual(first.mac, "00:1A:2B:3C:4D:5E");
});

test("Windows: type 保留原始状态字", () => {
  const devices = parseArpOutput(WINDOWS_SAMPLE);
  const first = devices.find((device) => device.address === "192.168.110.1");
  assert.strictEqual(first.type, "动态");
});

// ---------- macOS ----------

const MACOS_SAMPLE = [
  "? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]",
  "? (192.168.1.5) at a4:5e:60:12:34:56 on en0 ifscope [ethernet]",
  "? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]",
  "? (192.168.1.1) at 0:11:22:33:44:55 on en1 ifscope [ethernet]",
  "? (192.168.1.100) at 0:11:22:33:44:56 on en0 ifscope permanent [ethernet]",
  "? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]",
  "? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]",
  "? (239.255.255.250) at 1:0:5e:7f:ff:fa on en0 ifscope permanent [ethernet]"
].join("\n");

test("macOS: 解析带括号的地址格式", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  assert.deepStrictEqual(addresses(devices), ["192.168.1.1", "192.168.1.100", "192.168.1.5"]);
});

test("macOS: MAC 无前导零时补齐（0:11:22:33:44:55）", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  const first = devices.find((device) => device.address === "192.168.1.1");
  assert.strictEqual(first.mac, "00:11:22:33:44:55");
});

test("macOS: (incomplete) 条目被跳过", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  assert.ok(!devices.some((device) => device.address === "192.168.1.50"));
});

test("macOS: 同一 IP 出现在多个接口时只保留一条", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  assert.strictEqual(devices.filter((device) => device.address === "192.168.1.1").length, 1);
});

test("macOS: 组播 MAC（1:0:5e:...）被过滤", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  assert.ok(!devices.some((device) => device.mac.startsWith("01:00:5E")));
});

test("macOS: type 取接口名 en0", () => {
  const devices = parseArpOutput(MACOS_SAMPLE);
  const first = devices.find((device) => device.address === "192.168.1.1");
  assert.strictEqual(first.type, "en0");
});

// ---------- Linux ----------

const LINUX_IPNEIGH_SAMPLE = [
  "192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE",
  "192.168.1.5 dev eth0 lladdr a4:5e:60:12:34:56 STALE",
  "192.168.1.50 dev eth0 lladdr 00:00:00:00:00:00 FAILED",
  "192.168.1.255 dev eth0 lladdr ff:ff:ff:ff:ff:ff STALE",
  "224.0.0.251 dev eth0 lladdr 01:00:5e:00:00:fb NOARP",
  "fe80::1 dev eth0 lladdr 00:11:22:33:44:55 router STALE"
].join("\n");

test("Linux(ip neigh): 解析 lladdr 格式，跳过 IPv6 与无效条目", () => {
  const devices = parseArpOutput(LINUX_IPNEIGH_SAMPLE);
  assert.deepStrictEqual(addresses(devices), ["192.168.1.1", "192.168.1.5"]);
});

test("Linux(ip neigh): type 取接口名 eth0", () => {
  const devices = parseArpOutput(LINUX_IPNEIGH_SAMPLE);
  assert.strictEqual(devices[0].type, "eth0");
});

const LINUX_ARP_SAMPLE = [
  "? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0",
  "? (192.168.1.5) at a4:5e:60:12:34:56 [ether] on eth0",
  "? (192.168.1.255) at ff:ff:ff:ff:ff:ff [ether] on eth0",
  "? (192.168.1.77) at <incomplete> on eth0"
].join("\n");

test("Linux(arp -an): 解析 net-tools 格式", () => {
  const devices = parseArpOutput(LINUX_ARP_SAMPLE);
  assert.deepStrictEqual(addresses(devices), ["192.168.1.1", "192.168.1.5"]);
});

// ---------- 边界情况 ----------

test("空输出返回空数组", () => {
  assert.deepStrictEqual(parseArpOutput(""), []);
  assert.deepStrictEqual(parseArpOutput(null), []);
  assert.deepStrictEqual(parseArpOutput(undefined), []);
});

test("无法识别的输出返回空数组", () => {
  assert.deepStrictEqual(parseArpOutput("command not found"), []);
});

test("回环地址被过滤", () => {
  const devices = parseArpOutput("? (127.0.0.1) at 00:11:22:33:44:55 on lo0 ifscope [ethernet]");
  assert.deepStrictEqual(devices, []);
});

test("normalizeMac 处理单字符段", () => {
  assert.strictEqual(normalizeMac("0:11:22:3:44:5"), "00:11:22:03:44:05");
  assert.strictEqual(normalizeMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
});

test("describeInterface 回退到方括号内容", () => {
  assert.strictEqual(describeInterface("ifscope [ethernet]"), "ethernet");
  assert.strictEqual(describeInterface("on en0 ifscope [ethernet]"), "en0");
});

test("各平台选用正确的邻居表命令", () => {
  assert.deepStrictEqual(arpCommands("win32"), [["arp", ["-a"]]]);
  assert.deepStrictEqual(arpCommands("darwin"), [["arp", ["-an"]]]);
  assert.deepStrictEqual(arpCommands("linux"), [["ip", ["neigh"]], ["arp", ["-an"]]]);
});

console.log("");
console.log(`结果: ${passed} 项通过, ${failed} 项失败`);
console.log("");

process.exit(failed === 0 ? 0 : 1);
