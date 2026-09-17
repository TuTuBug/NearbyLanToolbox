# 近邻 · 局域网工具箱 —— 依赖还原脚本
#
# 作用：准备构建所需的全部外部文件，全部落在 ..\deps\ 下（不提交进仓库）：
#         1) 第三方程序集：WebView2 1.0.2535.41、ZXing.Net 0.16.10
#            —— 这些会被内嵌进 exe，是「单文件」的关键
#         2) .NET Framework 4.8 参考程序集
#            —— 只装了 Build Tools、没装 Developer Pack 的机器靠它才能编译
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\fetch-deps.ps1
#   powershell -ExecutionPolicy Bypass -File tools\fetch-deps.ps1 -Proxy "http://127.0.0.1:7897"
#
# 说明：代理/内网环境下直连 NuGet 失败时，用 -Proxy 指定本地代理。

[CmdletBinding()]
param(
    [string]$Proxy = "",
    [string]$DepsDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $DepsDir) {
    $DepsDir = Join-Path (Split-Path -Parent $PSScriptRoot) "deps"
}
$DepsDir = [System.IO.Path]::GetFullPath($DepsDir)
$CacheDir = Join-Path $DepsDir ".cache"
$WorkDir = Join-Path $CacheDir "extract"

New-Item -ItemType Directory -Force -Path $DepsDir, $CacheDir | Out-Null

# 程序集包：下载地址、缓存文件名、需要提取的条目（nupkg 内路径 -> 输出文件名）
$packages = @(
    @{
        Name    = "Microsoft.Web.WebView2 1.0.2535.41"
        Url     = "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2535.41"
        Cache   = "webview2.1.0.2535.41.nupkg"
        Entries = [ordered]@{
            "lib/net462/Microsoft.Web.WebView2.Core.dll"     = "Microsoft.Web.WebView2.Core.dll"
            "lib/net462/Microsoft.Web.WebView2.WinForms.dll" = "Microsoft.Web.WebView2.WinForms.dll"
            "build/native/x64/WebView2Loader.dll"            = "WebView2Loader.x64.dll"
            "build/native/x86/WebView2Loader.dll"            = "WebView2Loader.x86.dll"
        }
    },
    @{
        Name    = "ZXing.Net 0.16.10"
        Url     = "https://www.nuget.org/api/v2/package/ZXing.Net/0.16.10"
        Cache   = "zxing.net.0.16.10.nupkg"
        Entries = [ordered]@{
            "lib/net48/zxing.dll" = "zxing.dll"
        }
    }
)

function Get-Nupkg {
    param([string]$Url, [string]$Destination)

    if (Test-Path $Destination) {
        $len = (Get-Item $Destination).Length
        if ($len -gt 10000) {
            Write-Host ("  [cache] {0} ({1:N0} 字节)" -f (Split-Path -Leaf $Destination), $len) -ForegroundColor DarkGray
            return
        }
        Remove-Item $Destination -Force
    }

    Write-Host "  [get]   $Url"
    $wc = New-Object System.Net.WebClient
    if ($Proxy) {
        $wc.Proxy = New-Object System.Net.WebProxy($Proxy, $true)
    }
    $wc.Headers.Add("User-Agent", "nearby-lan-toolbox-build")
    $wc.DownloadFile($Url, $Destination)
    $wc.Dispose()

    $size = (Get-Item $Destination).Length
    if ($size -lt 10000) {
        throw "$Destination 下载不完整（$size 字节），请检查网络，或改用 -Proxy 指定代理。"
    }
}

function Expand-Nupkg {
    param([string]$Nupkg, [string]$Destination)

    if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    # nupkg 本质是 zip，Expand-Archive 只认 .zip 扩展名，先复制一份
    $zipCopy = $Nupkg + ".zip"
    Copy-Item $Nupkg $zipCopy -Force
    Expand-Archive -Path $zipCopy -DestinationPath $Destination -Force
    Remove-Item $zipCopy -Force
}

# ---------- 1) 第三方程序集 ----------
foreach ($pkg in $packages) {
    Write-Host "==> $($pkg.Name)"
    $nupkg = Join-Path $CacheDir $pkg.Cache
    Get-Nupkg -Url $pkg.Url -Destination $nupkg

    Expand-Nupkg -Nupkg $nupkg -Destination $WorkDir

    foreach ($entry in $pkg.Entries.Keys) {
        $source = Join-Path $WorkDir ($entry -replace "/", "\")
        if (-not (Test-Path $source)) {
            throw "$($pkg.Cache) 中找不到条目：$entry"
        }
        $target = Join-Path $DepsDir $pkg.Entries[$entry]
        Copy-Item $source $target -Force
        $len = (Get-Item $target).Length
        Write-Host ("  [ok]    {0,-46} {1,9:N0} 字节" -f $pkg.Entries[$entry], $len)
    }
}

# ---------- 2) .NET Framework 4.8 参考程序集 ----------
Write-Host "==> .NET Framework 4.8 参考程序集"

# 始终使用包内自带的参考程序集，不再因为「本机装了 Developer Pack」而跳过。
# 原因：跳过会让构建结果依赖本机参考程序集的版本 —— 本机有 v4.8 目录、
# 而 CI 镜像上只有 v4.8.1 目录时，MSBuild 会在很深的地方报 MSB3644，极难定位。
# 自带一份的代价只有约 10 MB（首次下载，之后走缓存），换来任意机器上结果一致。
$installedPack = "${env:ProgramFiles(x86)}\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8"
if (Test-Path $installedPack) {
    Write-Host "  [info]  本机已装 Developer Pack，仍使用包内参考程序集以保证跨机器一致" -ForegroundColor DarkGray
}

$refNupkg = Join-Path $CacheDir "refasm.net48.nupkg"
Get-Nupkg -Url "https://www.nuget.org/api/v2/package/Microsoft.NETFramework.ReferenceAssemblies.net48/1.0.3" `
          -Destination $refNupkg

Expand-Nupkg -Nupkg $refNupkg -Destination $WorkDir

$refOut = Join-Path $DepsDir "reference-assemblies"
if (Test-Path $refOut) { Remove-Item $refOut -Recurse -Force }
Copy-Item (Join-Path $WorkDir "build") $refOut -Recurse -Force

$count = (Get-ChildItem (Join-Path $refOut ".NETFramework\v4.8") -Filter *.dll).Count
Write-Host ("  [ok]    reference-assemblies\.NETFramework\v4.8  ({0} 个参考程序集)" -f $count)

Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue

# ---------- 校验 ----------
Write-Host ""
Write-Host "==> 校验"
$required = @(
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.x64.dll",
    "WebView2Loader.x86.dll",
    "zxing.dll"
)
$missing = @()
foreach ($f in $required) {
    $full = Join-Path $DepsDir $f
    if (Test-Path $full) {
        Write-Host ("  [ok]   {0}" -f $f) -ForegroundColor Green
    }
    else {
        Write-Host ("  [缺失] {0}" -f $f) -ForegroundColor Red
        $missing += $f
    }
}

if ($missing.Count -gt 0) {
    throw "以下依赖缺失：$($missing -join ', ')"
}

Write-Host ""
Write-Host "依赖已就绪：$DepsDir" -ForegroundColor Green
Write-Host "接下来执行 build.ps1 编译。" -ForegroundColor Green
