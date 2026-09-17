"use strict";

/**
 * 校验 native/EmbeddedAssets.g.cs 里内嵌的前端资源，与 public/ 下的文件是否一致。
 *
 * 为什么需要它：
 *   exe 是单文件，页面走的是「GZip + Base64 内嵌进 EmbeddedAssets.g.cs」这条路，
 *   所以改完 public/ 必须重新生成 g.cs，否则 exe 里跑的还是旧页面。
 *   正常由 build.ps1 自动完成；但 CI 上若因环境问题跳过该步骤
 *   （build.ps1 -SkipEmbed），就必须有一道独立校验兜底，
 *   否则会出现「发出去的 exe 带着旧页面」这种很难发现的问题。
 *
 * 用 Node 实现（而不是 PowerShell）的原因：CI 上出问题的恰恰是那个脚本运行时，
 * 校验本身必须站在一个稳定可靠的运行时上，才有意义。
 *
 * 用法：node tools/verify-embedded-assets.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const GCS_PATH = path.join(ROOT, "native", "EmbeddedAssets.g.cs");
const PUBLIC_DIR = path.join(ROOT, "public");

const ASSETS = [
  { member: "Index", file: "index.html" },
  { member: "App", file: "app.js" },
  { member: "Styles", file: "styles.css" }
];

console.log("");
console.log("内嵌前端资源一致性校验");
console.log("");

if (!fs.existsSync(GCS_PATH)) {
  console.error(`找不到 ${GCS_PATH}`);
  process.exit(1);
}

const source = fs.readFileSync(GCS_PATH, "utf8");
let failed = 0;

for (const { member, file } of ASSETS) {
  const pattern = new RegExp(`byte\\[\\]\\s+${member}\\s*=\\s*Inflate\\("([^"]+)"\\)`);
  const match = source.match(pattern);

  if (!match) {
    console.log(`  ✗ 在 EmbeddedAssets.g.cs 里找不到 ${member}（对应的 public/${file}）`);
    failed += 1;
    continue;
  }

  const filePath = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`  ✗ 找不到 public/${file}`);
    failed += 1;
    continue;
  }

  let embedded;
  try {
    embedded = zlib.gunzipSync(Buffer.from(match[1], "base64"));
  } catch (error) {
    console.log(`  ✗ ${member} 的内嵌内容无法解压：${error.message}`);
    failed += 1;
    continue;
  }

  const actual = fs.readFileSync(filePath);

  if (embedded.equals(actual)) {
    console.log(`  ✓ ${file}（${actual.length} 字节）与内嵌内容一致`);
    continue;
  }

  console.log(`  ✗ ${file} 与内嵌内容不一致`);
  console.log(`      内嵌 ${embedded.length} 字节 / 实际 ${actual.length} 字节`);
  console.log("      说明改过 public/ 但没有重新生成 EmbeddedAssets.g.cs，");
  console.log("      exe 里会带旧页面。本地跑一次 build.ps1（不加 -SkipEmbed）即可修复。");
  failed += 1;
}

console.log("");
console.log(`结果: ${ASSETS.length - failed} 项一致, ${failed} 项不一致`);
console.log("");

process.exit(failed === 0 ? 0 : 1);
