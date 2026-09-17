# 近邻 · 局域网工具箱

一个轻量的 Windows 局域网工具。启动后在本机 `8787` 端口起一个 HTTP 服务，同一 Wi-Fi
下的手机、平板、电脑用浏览器打开局域网地址，即可与这台机器互传文件、共享剪贴板、群聊和测速。

界面用 WebView2 承载，整个程序编译为**单个 exe**，不需要安装 Node.js，不会弹出控制台黑框，
也不会自动打开外部浏览器。

## 功能

- 共享剪贴板（SSE 实时同步，并带心跳轮询回退）
- 文件快传（拖拽上传、下载、删除，单文件上限 2 GB）
- 设备列表（工具箱在线客户端 + 系统 ARP 缓存）
- 局域网聊天室（SSE 实时消息，保留本次运行最近 200 条）
- 局域网测速（延迟、上传、下载）
- 连接二维码与可选访问密码
- Windows 系统托盘模式

## 使用

直接双击 `NearbyLanToolbox.exe`。窗口上方可以：

- 查看服务状态、在线设备数量和局域网地址
- 复制同一 Wi-Fi 设备使用的访问地址
- 显示连接二维码，并选择开启或关闭访问密码
- 打开接收文件目录 / 更改接收文件目录
- 刷新内嵌页面
- 停止或重新启动局域网服务
- 最小化或最大化软件
- 点击关闭按钮隐藏到系统托盘；在托盘菜单选择"退出"可完全关闭软件

窗口隐藏后可双击系统托盘图标恢复；右键托盘图标可复制地址、打开目录或退出。
窗口异常不可见时，可以运行 `stop.bat`。

### 扫码连接与访问密码

点击软件顶部的"连接二维码"，手机或其他电脑可直接扫描二维码打开局域网地址。

- 访问密码默认关闭，扫码后可直接使用。
- 可勾选"启用访问密码"，设置 4 到 8 位数字，也可以点击"随机生成"。
- 启用后，远程设备需要先输入密码，才能使用剪贴板、文件、聊天室、设备列表和测速。
- 二维码只包含局域网地址，不会把访问密码写进二维码。
- 本机软件窗口通过回环地址访问，不需要输入密码。

访问设置保存在：

```text
%LOCALAPPDATA%\NearbyLanToolbox\access-settings.txt
```

### 接收文件目录

首次运行默认保存到 `C:\Users\当前用户名\Downloads\data\uploads`。
点击"打开目录"可直接查看文件；点击"更改目录"可选择其他文件夹，路径会记住。

```text
%LOCALAPPDATA%\NearbyLanToolbox\upload-path.txt
```

## 从源码构建

### 环境要求

| 依赖 | 说明 |
|---|---|
| Windows | 10 / 11 |
| Visual Studio 2022 及以上，或 Visual Studio Build Tools | 勾选「.NET 桌面生成工具」工作负载即可，无需完整 IDE |
| PowerShell 5.1 | 系统自带 |
| 网络 | 首次构建需联网下载依赖（可用代理） |

> 目标框架为 **.NET Framework 4.8**。如果没装「.NET Framework 4.8 Developer Pack」，
> 构建脚本会自动下载官方参考程序集补齐，**不需要管理员权限安装任何东西**。

### 构建步骤

```powershell
git clone <此仓库地址>
cd NearbyLanToolbox

# 一条命令搞定：还原依赖 -> 编译
powershell -ExecutionPolicy Bypass -File build.ps1
```

代理环境下直连 NuGet 失败时：

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1 -Proxy "http://127.0.0.1:7897"
```

产物：

```text
outputs\NearbyLanToolbox.exe
```

### 改了前端页面记得重新内嵌

页面不走磁盘文件，而是把 `public\` 下的资源 GZip 压缩 + Base64 后
写进 `native\EmbeddedAssets.g.cs`，编译时进 exe。所以**改了 `public\` 之后必须重新生成**：

```powershell
powershell -ExecutionPolicy Bypass -File tools\embed-assets.ps1
powershell -ExecutionPolicy Bypass -File build.ps1 -SkipDeps
```

### 单独还原依赖

```powershell
powershell -ExecutionPolicy Bypass -File tools\fetch-deps.ps1
```

会把以下内容下载到 `deps\`（已在 `.gitignore` 中忽略）：

- `Microsoft.Web.WebView2` 1.0.2535.41 的托管程序集与 x64/x86 原生加载器
- `ZXing.Net` 0.16.10
- .NET Framework 4.8 参考程序集（本机已装 Developer Pack 时自动跳过）

## 项目结构

```text
NearbyLanToolbox/
├── build.ps1                     一键构建（还原依赖 + 编译）
├── start.bat / stop.bat          启动 / 停止（按端口 8787 结束进程）
├── native/
│   ├── NearbyLanToolbox.csproj   构建工程（.NET Framework 4.8 / WinForms）
│   ├── Server.cs                 内嵌 HTTP 服务 + 程序入口（Program.Main）
│   ├── MainForm.cs               WinForms 主窗体、托盘、二维码弹窗
│   ├── WebViewRuntime.cs         内嵌依赖加载（AssemblyResolve）与原生加载器释放
│   ├── EmbeddedAssets.g.cs       自动生成：内嵌的页面/脚本/样式（勿手工编辑）
│   └── app.ico                   程序图标
├── public/                       前端源码（改这里，然后跑 embed-assets.ps1）
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.js                     等价的 Node.js 版后端（备用运行方式，非必需）
├── package.json
├── tools/
│   ├── fetch-deps.ps1            还原依赖到 deps\
│   └── embed-assets.ps1          重新生成 EmbeddedAssets.g.cs
└── deps/                         构建时生成，不入库
```

## 单文件是怎么做出来的

理解这一点，改构建配置时才不会踩坑：

1. `tools\fetch-deps.ps1` 把 WebView2、ZXing 等程序集还原到 `deps\`。
2. `native\NearbyLanToolbox.csproj` 里把它们声明为 `<EmbeddedResource>`，
   并用 `LogicalName` 指定资源名，例如 `NearbyLanToolbox.zxing.dll`。
   这些程序集以 `Private=false` 参与编译，**不复制到输出目录**。
3. 程序启动时 `WebViewRuntime.Initialize()` 注册 `AppDomain.AssemblyResolve`，
   在运行期按需从资源流 `Assembly.Load` 加载这些依赖。
4. `WebView2Loader.dll`（原生 DLL，不能 `Assembly.Load`）会被释放到
   `%LOCALAPPDATA%\NearbyLanToolbox\runtime\1.0.2535.41\{x64,x86}\` 再 `SetDllDirectory`。

因此 **`WebViewRuntime.cs` 中硬编码的资源名与 csproj 里的 `LogicalName` 必须严格一致**，
改名字会直接导致程序启动时报「缺少内嵌组件」。

## 常见问题

**构建报 MSB3644「找不到 .NETFramework,Version=v4.8 的引用程序集」**
依赖没还原完整。执行 `tools\fetch-deps.ps1`（或直接跑 `build.ps1` 不加 `-SkipDeps`）。

**构建报找不到 `HttpUtility` / `JavaScriptSerializer`**
工程必须引用 `System.Web`（`HttpUtility`）与 `System.Web.Extensions`（`JavaScriptSerializer`），
这两个不能省。

**构建成功但 exe 打不开内嵌组件**
检查 `WebViewRuntime.cs` 里的资源名字符串与 csproj 的 `LogicalName` 是否逐字一致。

**端口 8787 被占用**
运行 `stop.bat`，或 `netstat -ano | findstr 8787` 找到 PID 后手动结束。

## 系统要求与注意事项

- 支持 32 位和 64 位 Windows，需要 Microsoft Edge WebView2 Runtime。
  Windows 11 和大多数仍在更新的 Windows 10 通常已经自带。
- Windows 首次运行时，防火墙可能询问是否允许访问，请仅勾选"专用网络"。
- EXE 当前未做数字签名；SmartScreen 提示未知发布者时，请确认文件来源后再运行。
- 未启用访问密码时，所有打开地址的局域网设备都能操作共享内容，请只在可信网络中运行。
- ARP 列表是本机近期通信缓存，不等于路由器的完整在线设备列表。
- 访客 Wi-Fi、校园网或开启 AP 隔离的网络可能阻止设备互访。

## 许可

[MIT](LICENSE)
