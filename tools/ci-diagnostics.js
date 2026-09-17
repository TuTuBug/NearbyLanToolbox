"use strict";

/**
 * 汇总 CI 的构建日志，输出成「可公开读取」的形式：
 *   1) GitHub 注解（::error::）—— 关键错误行，直接显示在 Actions 页面上
 *   2) job summary —— 各步骤日志尾部，可通过 check-run 接口读到
 *
 * 为什么用 Node 而不是 PowerShell：
 *   · 构建脚本本身出问题时，诊断不能依赖同一个运行时；
 *   · Actions 的 job 日志接口对公开仓库也要求认证，注解与 summary 是仅有的
 *     无需登录即可读取的通道。
 *
 * 用法：node tools/ci-diagnostics.js
 */

const fs = require("fs");

const LOG_FILES = [
  "01-fetch-deps.out.log",
  "01-fetch-deps.err.log",
  "02-embed-assets.out.log",
  "02-embed-assets.err.log",
  "03-msbuild.out.log",
  "03-msbuild.err.log"
];

/** 每个日志在 summary 里保留的尾部行数 */
const TAIL_LINES = 80;
const ERROR_PATTERN = /(error\s+[A-Z]+\d+|error\:|错误|MSB\d{4}|CS\d{4}|cannot find|could not|not found|找不到|拒绝访问|Access is denied|Exception|异常)/i;

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch (error) {
    return null;
  }
}

function appendSummary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    fs.appendFileSync(target, text + "\n", "utf8");
  } catch (error) {
    /* 写 summary 失败不影响主流程 */
  }
}

const found = [];
const highlights = [];

for (const file of LOG_FILES) {
  const lines = readLines(file);
  if (!lines) continue;
  found.push({ file, lines });

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (ERROR_PATTERN.test(text)) {
      highlights.push(`[${file}] ${text}`);
    }
  }
}

if (found.length === 0) {
  console.log("没有找到任何构建日志文件");
  appendSummary("没有找到任何构建日志文件");
  console.log("::error title=no-build-log::构建失败但没有留下任何日志");
  process.exit(1);
}

appendSummary("## 构建诊断");
appendSummary("");

for (const { file, lines } of found) {
  const tail = lines.slice(-TAIL_LINES);
  appendSummary(`### ${file}（共 ${lines.length} 行，显示末尾 ${tail.length} 行）`);
  appendSummary("");
  appendSummary("```text");
  appendSummary(tail.join("\n"));
  appendSummary("```");
  appendSummary("");
}

console.log("找到日志文件：", found.map((item) => `${item.file}(${item.lines.length} 行)`).join(", "));
console.log(`匹配到 ${highlights.length} 行疑似错误`);

const picked = (highlights.length > 0 ? highlights : []).slice(-8);

if (picked.length === 0) {
  // 没有明显错误行，就把最后一个日志的尾部当注解发出去
  const last = found[found.length - 1];
  const tail = last.lines.slice(-6).filter((line) => line.trim());
  picked.push(...tail.map((line) => `[${last.file}] ${line.trim()}`));
}

for (const line of picked) {
  const message = line.replace(/[\r\n%]/g, " ").slice(0, 700);
  console.log(`::error title=ci-build-failure::${message}`);
}

process.exit(0);
