# 近邻 · 局域网工具箱 —— 一键构建脚本
#
# 作用：还原依赖 -> 编译 native\NearbyLanToolbox.csproj -> 产出单文件 exe
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build.ps1
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Proxy "http://127.0.0.1:7897"
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Configuration Debug
#
# 产物：outputs\NearbyLanToolbox.exe（单个文件，双击即可运行）

[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",
    [string]$Proxy = "",
    [switch]$SkipDeps,
    [switch]$SkipEmbed,
    [string]$MSBuildPath = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$ProjectFile = Join-Path $RepoRoot "native\NearbyLanToolbox.csproj"
$DepsDir = Join-Path $RepoRoot "deps"

function Write-Step($text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Resolve-MSBuild {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 MSBuild 不存在：$Explicit" }
        return $Explicit
    }

    # 1) 优先用 vswhere 查询（能同时覆盖 VS 完整版与 BuildTools）
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $found = & $vswhere -latest -prerelease -products * `
            -requires Microsoft.Component.MSBuild `
            -find "MSBuild\**\Bin\MSBuild.exe" 2>$null | Select-Object -First 1
        if ($found -and (Test-Path $found)) { return $found }
    }

    # 2) 回退到常见安装路径
    $vswherePaths = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe",
        "${env:ProgramFiles}\Microsoft Visual Studio\2019\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
    )
    foreach ($p in $vswherePaths) {
        if (Test-Path $p) { return $p }
    }

    # 3) 最后尝试 .NET Framework 自带的旧版 MSBuild
    $frameworkMsbuild = "${env:WINDIR}\Microsoft.NET\Framework64\v4.0.30319\MSBuild.exe"
    if (Test-Path $frameworkMsbuild) { return $frameworkMsbuild }

    throw @"
找不到 MSBuild。

请安装以下任意一项后重试：
  - Visual Studio 2022+（勾选「.NET 桌面开发」工作负载）
  - Visual Studio Build Tools（勾选「.NET 桌面生成工具」）
下载地址：https://visualstudio.microsoft.com/downloads/

或手动指定：build.ps1 -MSBuildPath "C:\path\to\MSBuild.exe"
"@
}

Write-Host "近邻 · 局域网工具箱 —— 构建" -ForegroundColor White
Write-Host "仓库根目录：$RepoRoot"

# ---------- 步骤 1：还原依赖 ----------
if (-not $SkipDeps) {
    Write-Step "还原第三方依赖（WebView2 / ZXing.Net）"
    $fetch = Join-Path $RepoRoot "tools\fetch-deps.ps1"
    if ($Proxy) {
        & $fetch -Proxy $Proxy
    } else {
        & $fetch
    }
    if ($LASTEXITCODE -ne 0) { throw "依赖还原失败。" }
} else {
    Write-Step "跳过依赖还原（-SkipDeps）"
}

$required = @(
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.x64.dll",
    "WebView2Loader.x86.dll",
    "zxing.dll"
)
foreach ($f in $required) {
    $full = Join-Path $DepsDir $f
    if (-not (Test-Path $full)) {
        throw "缺少依赖文件：$full（去掉 -SkipDeps 重新运行以自动下载）"
    }
}

# ---------- 步骤 1.5：重新内嵌前端资源 ----------
# 改了 public\index.html、app.js、styles.css 之后，必须重新生成 EmbeddedAssets.g.cs，
# 否则编译出来的 exe 里跑的仍是旧页面。这一步幂等且很快，所以每次构建都执行。
if ($SkipEmbed) {
    # 跳过重新生成，直接用仓库里已有的 EmbeddedAssets.g.cs。
    # 用途：CI 上资源内嵌步骤受环境影响失败时，仍能编译出 exe；
    # 前端是否与 public\ 同步由 tools\verify-embedded-assets.js 单独校验。
    Write-Step "跳过前端资源内嵌（-SkipEmbed）"
    $existing = Join-Path $RepoRoot "native\EmbeddedAssets.g.cs"
    if (-not (Test-Path $existing)) {
        throw "指定了 -SkipEmbed，但 native\EmbeddedAssets.g.cs 不存在，无法编译。"
    }
    Write-Host "使用仓库中已有的：$existing" -ForegroundColor DarkGray
}
else {
    Write-Step "同步前端资源（public\ -> native\EmbeddedAssets.g.cs）"
    $embed = Join-Path $RepoRoot "tools\embed-assets.ps1"
    try {
        & $embed -RepoRoot $RepoRoot
    } catch {
        throw "前端资源内嵌失败：$($_.Exception.Message)"
    }
}

# ---------- 步骤 2：编译 ----------
Write-Step "编译（$Configuration）"
$msbuild = Resolve-MSBuild -Explicit $MSBuildPath
Write-Host "MSBuild：$msbuild"
Write-Host "工程：  $ProjectFile"
Write-Host ""

& $msbuild $ProjectFile `
    /p:Configuration=$Configuration `
    /p:Platform=AnyCPU `
    /nologo `
    /v:minimal `
    /t:Rebuild

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    throw "编译失败，MSBuild 退出码 $LASTEXITCODE。"
}

# ---------- 步骤 3：报告产物 ----------
$exeDir = if ($Configuration -eq "Debug") {
    Join-Path $RepoRoot "outputs\Debug"
} else {
    Join-Path $RepoRoot "outputs"
}
$exe = Join-Path $exeDir "NearbyLanToolbox.exe"

Write-Step "构建完成"
if (Test-Path $exe) {
    $info = Get-Item $exe
    Write-Host ("{0}" -f $exe) -ForegroundColor Green
    Write-Host ("大小：{0:N0} 字节 ({1:N2} MB)" -f $info.Length, ($info.Length / 1MB)) -ForegroundColor Green
    Write-Host ("时间：{0}" -f $info.LastWriteTime) -ForegroundColor Green
} else {
    throw "编译报告成功，但找不到产物：$exe"
}
