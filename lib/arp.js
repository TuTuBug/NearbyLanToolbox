"use strict";

/**
 * 局域网邻居表解析（跨平台）
 *
 * 三个平台的输出格式各不相同，抽成独立模块以便用真实样本做单元测试
 * （见 tools/test-arp-parser.js）——macOS 的格式无法在 Windows 上实测，
 * 只能靠样本测试保证正确性。
 *
 *   Windows  arp -a       192.168.1.1        00-11-22-33-44-55    动态
 *   macOS    arp -an      ? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]
 *   Linux    ip neigh     192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
 *   Linux    arp -an      ? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0
 */

const { execFile } = require("child_process");

// 把各种写法归一成 AA:BB:CC:DD:EE:FF。
// macOS 的 arp 输出不做前导零补齐（写 0:11:22:33:44:55），这里补回来。
function normalizeMac(value) {
  return String(value)
    .split(/[:-]/)
    .map((part) => part.padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

// macOS / Linux（net-tools），形如：
//   ? (192.168.1.1) at 0:11:22:33:44:55 on en0 ifscope [ethernet]
//   ? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]   ← 无 MAC，不匹配
const ARP_NIX = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\s*(.*)$/i;

// Windows，形如：
//   192.168.1.1           00-11-22-33-44-55     动态
const ARP_WINDOWS = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\s+(\S+)/i;

// Linux（iproute2），形如：
//   192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
const ARP_IPROUTE = /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)\s+lladdr\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i;

// 从 "on en0 ifscope [ethernet]" 里取出接口名，取不到就退化成链路类型。
function describeInterface(rest) {
  const text = String(rest || "");
  const on = text.match(/\bon\s+(\S+)/i);
  if (on) return on[1];
  const bracket = text.match(/\[(\w+)\]/);
  if (bracket) return bracket[1];
  return text.trim().split(/\s+/)[0] || "";
}

function parseArpOutput(stdout) {
  const devices = [];
  const seen = new Set();

  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let address = null;
    let mac = null;
    let type = "";

    let match = line.match(ARP_NIX);
    if (match) {
      address = match[1];
      mac = normalizeMac(match[2]);
      type = describeInterface(match[3]);
    } else {
      match = line.match(ARP_IPROUTE);
      if (match) {
        address = match[1];
        mac = normalizeMac(match[3]);
        type = match[2];
      } else {
        match = line.match(ARP_WINDOWS);
        if (!match) continue;
        address = match[1];
        mac = normalizeMac(match[2]);
        type = match[3];
      }
    }

    const firstOctet = Number(address.split(".")[0]);
    if (
      seen.has(address) ||
      firstOctet >= 224 ||              // 组播
      firstOctet === 0 ||               // 无效段
      address.endsWith(".255") ||       // 广播
      address.endsWith(".0") ||         // 网段地址
      address.startsWith("127.") ||     // 回环
      mac === "FF:FF:FF:FF:FF:FF" ||
      mac === "00:00:00:00:00:00" ||    // Linux 上 FAILED 状态的占位 MAC
      mac.startsWith("01:00:5E")        // IPv4 组播映射
    ) continue;

    seen.add(address);
    devices.push({ address, mac, type });
  }
  return devices;
}

// 各平台可用的邻居表命令，按顺序尝试：
//   Windows  arp -a
//   Linux    ip neigh（iproute2 默认安装），退回到 arp -an（net-tools）
//   macOS    arp -an（-n 跳过 DNS 反解，否则每扫一次都要等超时）
function arpCommands(platform = process.platform) {
  if (platform === "win32") return [["arp", ["-a"]]];
  if (platform === "linux") return [["ip", ["neigh"]], ["arp", ["-an"]]];
  return [["arp", ["-an"]]];
}

function runCommand(file, args, platform = process.platform) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: platform === "win32", timeout: 5000 }, (err, stdout) => {
      resolve(err && !stdout ? "" : String(stdout || ""));
    });
  });
}

// 依次尝试各候选命令，返回第一个解析出设备的非空结果。
// 全部失败时返回空数组（调用方据此显示「没有发现设备」，而不是报错）。
async function arpDevices(platform = process.platform) {
  for (const [file, args] of arpCommands(platform)) {
    let output = "";
    try {
      output = await runCommand(file, args, platform);
    } catch {
      continue;
    }
    const devices = parseArpOutput(output);
    if (devices.length) return devices;
  }
  return [];
}

module.exports = {
  normalizeMac,
  describeInterface,
  parseArpOutput,
  arpCommands,
  arpDevices
};
