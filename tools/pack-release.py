#!/usr/bin/env python3
"""打包 macOS / Linux 发布包。

Windows 上编译不出 macOS 原生可执行文件（需要 macOS 的 Node 二进制并做
ad-hoc 签名，本机没有 codesign），所以跨平台侧走「下载即用」方案：
把一个只含运行时必需文件的压缩包放到 Release，解压后双击启动脚本即可。

要点：
  * zip 里必须记录 Unix 权限位（external_attr），否则 macOS 解压后
    .command 没有可执行权限，双击会提示「无法执行」。
  * 压缩包顶层套一层目录，避免用户解压后文件散落一地。
  * 只收运行时必需文件，不带源码构建工具链（deps/ native/ docs/ 等）。

用法：
    python tools/pack-release.py            # 打包全部
    python tools/pack-release.py mac        # 只打 macOS 包
"""

from __future__ import annotations

import os
import stat
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "outputs"

# 运行时必需的目录与文件（相对于项目根）
COMMON_FILES = [
    "server.js",
    "package.json",
    "LICENSE",
    "start-mac.command",
    "start-linux.sh",
    "使用说明-必读.txt",
]
COMMON_DIRS = ["lib", "public"]

# 明显不该进发布包的东西（双保险，正常也不会走到）
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes"}

EXECUTABLE_SUFFIXES = (".command", ".sh")


def want_executable(relative: Path) -> bool:
    return relative.name.endswith(EXECUTABLE_SUFFIXES)


def collect(root_name: str) -> list[tuple[Path, str]]:
    """返回 [(绝对路径, 压缩包内相对路径)]。"""
    items: list[tuple[Path, str]] = []

    for name in COMMON_FILES:
        source = ROOT / name
        if not source.is_file():
            raise SystemExit(f"缺少文件：{source}")
        items.append((source, f"{root_name}/{name}"))

    for directory in COMMON_DIRS:
        source_dir = ROOT / directory
        if not source_dir.is_dir():
            raise SystemExit(f"缺少目录：{source_dir}")
        for path in sorted(source_dir.rglob("*")):
            if path.is_dir():
                continue
            if path.name in EXCLUDE_NAMES:
                continue
            items.append((path, f"{root_name}/{path.relative_to(ROOT).as_posix()}"))

    return items


def check_scripts_lf(root_name: str, items: list[tuple[Path, str]]) -> None:
    """启动脚本必须是 LF 换行，CRLF 会让 macOS 直接报 bad interpreter。"""
    for source, _ in items:
        if source.suffix not in EXECUTABLE_SUFFIXES:
            continue
        data = source.read_bytes()
        if b"\r\n" in data:
            raise SystemExit(
                f"{source.name} 含 CRLF 换行，macOS/Linux 会报 bad interpreter。"
                "请先转成 LF。"
            )


def build_zip(target: Path, root_name: str, items: list[tuple[Path, str]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, arcname in items:
            info = zipfile.ZipInfo.from_file(source, arcname)
            info.date_time = (1980, 1, 1, 0, 0, 0)  # 固定时间戳，保证可复现
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if want_executable(Path(arcname)) else 0o644
            info.external_attr = mode << 16
            archive.writestr(info, source.read_bytes())


def build_tar(target: Path, root_name: str, items: list[tuple[Path, str]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    def reset(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        info.mtime = 0
        if info.isfile():
            info.mode = 0o755 if want_executable(Path(info.name)) else 0o644
        return info

    with tarfile.open(target, "w:gz") as archive:
        for source, arcname in items:
            archive.add(source, arcname=arcname, filter=reset)


def human(size: int) -> str:
    return f"{size / 1024:.1f} KB"


def main() -> int:
    requested = {arg.lower() for arg in sys.argv[1:]} or {"mac", "linux"}

    version = "v1.0.0"
    package_json = (ROOT / "package.json").read_text(encoding="utf-8")
    for line in package_json.splitlines():
        if '"version"' in line:
            version = "v" + line.split(":", 1)[1].strip().strip('",')
            break

    items = collect("NearbyLanToolbox")
    check_scripts_lf("NearbyLanToolbox", items)

    print(f"发布包版本：{version}")
    print(f"收录文件：{len(items)} 个")
    print("")

    results: list[Path] = []

    if "mac" in requested:
        target = OUTPUT_DIR / "NearbyLanToolbox-mac.zip"
        build_zip(target, "NearbyLanToolbox", items)
        results.append(target)

    if "linux" in requested:
        target = OUTPUT_DIR / "NearbyLanToolbox-linux.tar.gz"
        build_tar(target, "NearbyLanToolbox", items)
        results.append(target)

    for path in results:
        print(f"  {path.name:<34} {human(path.stat().st_size):>10}   {path}")

    print("")
    print("校验（可执行权限位是否写入）：")
    mac_zip = OUTPUT_DIR / "NearbyLanToolbox-mac.zip"
    if mac_zip.exists():
        with zipfile.ZipFile(mac_zip) as archive:
            for info in archive.infolist():
                if info.filename.endswith(EXECUTABLE_SUFFIXES):
                    mode = (info.external_attr >> 16) & 0o777
                    flag = "OK" if mode & stat.S_IXUSR else "!! 缺少可执行位"
                    print(f"  {info.filename:<46} {oct(mode)}  {flag}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
