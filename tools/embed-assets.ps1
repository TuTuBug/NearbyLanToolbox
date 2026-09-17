# 近邻 · 局域网工具箱 —— 前端资源内嵌脚本
#
# 背景：exe 是单文件，页面不走磁盘文件，而是把 public\ 下的前端资源
#       GZip 压缩 + Base64 后以字符串常量写进 native\EmbeddedAssets.g.cs，
#       编译时随代码一起进入 exe，运行时由 EmbeddedAssets.Inflate 还原。
#
#       所以：改了 public\index.html、app.js、styles.css 之后，
#       必须重新跑本脚本，否则 exe 里跑的还是旧页面。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\embed-assets.ps1
#
# 产物：native\EmbeddedAssets.g.cs（覆盖生成，勿手工编辑）

[CmdletBinding()]
param(
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$publicDir = Join-Path $RepoRoot "public"
$outFile = Join-Path $RepoRoot "native\EmbeddedAssets.g.cs"

$assets = @(
    @{ Member = "Index";  File = "index.html" },
    @{ Member = "App";    File = "app.js" },
    @{ Member = "Styles"; File = "styles.css" }
)

function Compress-ToBase64 {
    param([byte[]]$Bytes)

    $ms = New-Object System.IO.MemoryStream
    try {
        $gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Compress, $true)
        try {
            $gz.Write($Bytes, 0, $Bytes.Length)
        }
        finally {
            $gz.Dispose()
        }
        return [Convert]::ToBase64String($ms.ToArray())
    }
    finally {
        $ms.Dispose()
    }
}

Write-Host "近邻 · 局域网工具箱 —— 重新内嵌前端资源" -ForegroundColor White
Write-Host "源目录：$publicDir"
Write-Host ""

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("using System;")
[void]$sb.AppendLine("using System.IO;")
[void]$sb.AppendLine("using System.IO.Compression;")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("namespace NearbyLanToolbox")
[void]$sb.AppendLine("{")
[void]$sb.AppendLine("    // 本文件由 tools\embed-assets.ps1 自动生成，请勿手工编辑。")
[void]$sb.AppendLine("    // 源文件：public\index.html、public\app.js、public\styles.css")
[void]$sb.AppendLine("    internal static class EmbeddedAssets")
[void]$sb.AppendLine("    {")

foreach ($a in $assets) {
    $path = Join-Path $publicDir $a.File
    if (-not (Test-Path $path)) {
        throw "找不到前端资源：$path"
    }

    $bytes = [System.IO.File]::ReadAllBytes($path)
    $b64 = Compress-ToBase64 -Bytes $bytes

    [void]$sb.AppendLine(("        public static readonly byte[] {0} = Inflate(`"{1}`");" -f $a.Member, $b64))
    [void]$sb.AppendLine("")

    $ratio = 100.0 * $b64.Length / [Math]::Max($bytes.Length, 1)
    Write-Host ("  {0,-12} {1,-14} {2,8:N0} 字节 -> Base64 {3,8:N0} 字符 ({4:N1}%)" -f `
        $a.Member, $a.File, $bytes.Length, $b64.Length, $ratio) -ForegroundColor Green
}

[void]$sb.AppendLine("        private static byte[] Inflate(string value)")
[void]$sb.AppendLine("        {")
[void]$sb.AppendLine("            byte[] compressed = Convert.FromBase64String(value);")
[void]$sb.AppendLine("            using (MemoryStream input = new MemoryStream(compressed))")
[void]$sb.AppendLine("            using (GZipStream gzip = new GZipStream(input, CompressionMode.Decompress))")
[void]$sb.AppendLine("            using (MemoryStream output = new MemoryStream())")
[void]$sb.AppendLine("            {")
[void]$sb.AppendLine("                gzip.CopyTo(output);")
[void]$sb.AppendLine("                return output.ToArray();")
[void]$sb.AppendLine("            }")
[void]$sb.AppendLine("        }")
[void]$sb.AppendLine("    }")
[void]$sb.AppendLine("}")

# 用 UTF-8（无 BOM）写出：C# 源文件统一无 BOM，避免编译器告警
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outFile, $sb.ToString(), $utf8NoBom)

Write-Host ""
Write-Host "已生成：$outFile" -ForegroundColor Green
Write-Host ("大小：{0:N0} 字节" -f (Get-Item $outFile).Length) -ForegroundColor Green
