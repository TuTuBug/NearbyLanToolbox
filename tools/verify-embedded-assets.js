"use strict";

/**
 * 校验 native/EmbeddedAssets.g.cs 里内嵌的前端资源，与 public/ 下的文件是否一致。
 *
 * 为什么需要它：
 *   exe 是单文件，页面走的是「GZip + Base64 内嵌进 EmbeddedAssets.g.cs」这条路，
 *   所以改完 public/ 必须重新生成 g.cs，否则 exe 里跑的还是旧页面。
 *   正常由 build.ps1 自动完成；但 CI 上若跳过或异常，就必须有独立校验兜底。
 *
 * 用 Node 实现（而不是 PowerShell）的原因：CI 上出问题的恰恰是那个脚本运行时，
 * 校验本身必须站在一个稳定可靠的运行时上，才有意义。
 *
 * 用法：node tools/verify-embedded-assets.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const GCS_PATH = path.join(ROOT, "native", "EmbeddedAssets.g.cs");
const PUBLIC_DIR = path.join(ROOT, "public");

const ASSETS = [
  { member: "Index", file: "index.html" },
  { member: "App", file: "app.js" },
  { member: "Styles", file: "styles.css" }
];

function describe(buffer) {
  return `${buffer.length} 字节 sha256=${crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12)}`;
}

function summary(line) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) {
    try {
      fs.appendFileSync(target, line + "\n", "utf8");
    } catch (error) {
      /* 写 summary 失败不影响主流程 */
    }
  }
}

console.log("");
console.log("内嵌前端资源一致性校验");
console.log("");

summary("## 内嵌前端资源一致性校验");
summary("");

if (!fs.existsSync(GCS_PATH)) {
  const message = `找不到 ${GCS_PATH}`;
  console.error(message);
  summary(message);
  console.log(`::error title=embedded-assets::${message}`);
  process.exit(1);
}

const source = fs.readFileSync(GCS_PATH, "utf8");
const problems = [];

for (const { member, file } of ASSETS) {
  const pattern = new RegExp(`byte\\[\\]\\s+${member}\\s*=\\s*Inflate\\("([^"]+)"\\)`);
  const match = source.match(pattern);

  if (!match) {
    const message = `EmbeddedAssets.g.cs 里找不到 ${member}（对应 public/${file}）`;
    console.log(`  ✗ ${message}`);
    summary(`- ✗ ${message}`);
    problems.push(`${file}: 未找到`);
    continue;
  }

  const filePath = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(filePath)) {
    const message = `找不到 public/${file}`;
    console.log(`  ✗ ${message}`);
    summary(`- ✗ ${message}`);
    problems.push(`${file}: 源文件缺失`);
    continue;
  }

  let embedded;
  try {
    embedded = zlib.gunzipSync(Buffer.from(match[1], "base64"));
  } catch (error) {
    const message = `${member} 的内嵌内容无法解压：${error.message}`;
    console.log(`  ✗ ${message}`);
    summary(`- ✗ ${message}`);
    problems.push(`${file}: 解压失败`);
    continue;
  }

  const actual = fs.readFileSync(filePath);
  const base64Length = match[1].length;

  if (embedded.equals(actual)) {
    console.log(`  ✓ ${file}（${describe(actual)}）与内嵌内容一致`);
    summary(`- ✓ ${file}：${describe(actual)}`);
    continue;
  }

  const detail = `${file} 内嵌 ${describe(embedded)} / 实际 ${describe(actual)} / base64 ${base64Length} 字符`;
  console.log(`  ✗ ${file} 与内嵌内容不一致`);
  console.log(`      内嵌: ${describe(embedded)}`);
  console.log(`      实际: ${describe(actual)}`);
  console.log(`      内嵌首 16 字节: ${embedded.subarray(0, 16).toString("hex")}`);
  console.log(`      实际首 16 字节: ${actual.subarray(0, 16).toString("hex")}`);
  summary(`- ✗ ${detail}`);
  problems.push(detail);
}

console.log("");
console.log(`结果: ${ASSETS.length - problems.length} 项一致, ${problems.length} 项不一致`);
console.log("");

if (problems.length === 0) {
  summary("");
  summary("结论：一致。");
  process.exit(0);
}

summary("");
summary("结论：不一致，exe 会嵌进与 public/ 不符的前端，已阻止构建。");

// 注解是唯一能可靠传出信息的通道（Actions 日志接口对公开仓库也要认证）
const oneLine = problems.join(" | ").replace(/[\r\n%]/g, " ").slice(0, 400);
console.log(`::error title=embedded-assets-mismatch::${oneLine}`);
process.exit(1);
