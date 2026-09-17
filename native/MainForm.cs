using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using ZXing;
using ZXing.Common;
using ZXing.QrCode;

[assembly: AssemblyTitle("近邻 · 局域网工具箱")]
[assembly: AssemblyDescription("局域网共享剪贴板、文件快传、设备列表、聊天室和测速工具")]
[assembly: AssemblyCompany("Nearby LAN Toolbox")]
[assembly: AssemblyProduct("近邻 · 局域网工具箱")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace NearbyLanToolbox
{
    internal static class GuiApplication
    {
        internal static void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 browser;
        private readonly Label statusText;
        private readonly Button serviceButton;
        private readonly Button refreshButton;
        private readonly System.Windows.Forms.Timer statusTimer;
        private readonly NotifyIcon trayIcon;
        private bool browserReady;
        private bool closing;
        private bool allowExit;
        private bool trayHintShown;

        internal MainForm()
        {
            Text = "近邻 · 局域网工具箱";
            ClientSize = new Size(1180, 760);
            MinimumSize = new Size(900, 620);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(247, 248, 245);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            Panel toolbar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 50,
                BackColor = Color.White,
                Padding = new Padding(16, 8, 12, 8)
            };

            Label brand = new Label
            {
                Dock = DockStyle.Left,
                Width = 188,
                Text = "近邻 · 局域网工具箱",
                TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font(Font.FontFamily, 11F, FontStyle.Bold),
                ForeColor = Color.FromArgb(30, 38, 43)
            };
            toolbar.Controls.Add(brand);

            statusText = new Label
            {
                Dock = DockStyle.Fill,
                Text = "正在启动服务...",
                TextAlign = ContentAlignment.MiddleLeft,
                ForeColor = Color.FromArgb(92, 104, 110),
                AutoEllipsis = true,
                Padding = new Padding(8, 0, 8, 0)
            };
            toolbar.Controls.Add(statusText);

            FlowLayoutPanel actions = new FlowLayoutPanel
            {
                Dock = DockStyle.Right,
                Width = 578,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                Padding = new Padding(0),
                Margin = new Padding(0)
            };

            Button copyButton = CreateButton("复制访问地址", 104);
            copyButton.Click += delegate { CopyLanAddress(); };
            actions.Controls.Add(copyButton);

            Button connectButton = CreateButton("连接二维码", 96);
            connectButton.Click += delegate { ShowConnectionDialog(); };
            actions.Controls.Add(connectButton);

            Button folderButton = CreateButton("打开目录", 82);
            folderButton.Click += delegate { OpenUploadDirectory(); };
            actions.Controls.Add(folderButton);

            Button chooseFolderButton = CreateButton("更改目录", 86);
            chooseFolderButton.Click += delegate { ChooseUploadDirectory(); };
            actions.Controls.Add(chooseFolderButton);

            refreshButton = CreateButton("刷新", 66);
            refreshButton.Enabled = false;
            refreshButton.Click += delegate { ReloadBrowser(); };
            actions.Controls.Add(refreshButton);

            serviceButton = CreateButton("停止服务", 88);
            serviceButton.Click += delegate { ToggleService(); };
            actions.Controls.Add(serviceButton);
            toolbar.Controls.Add(actions);

            browser = new WebView2
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(247, 248, 245),
                DefaultBackgroundColor = Color.FromArgb(247, 248, 245)
            };

            Controls.Add(browser);
            Controls.Add(toolbar);

            statusTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            statusTimer.Tick += delegate { RefreshStatus(); };

            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("显示主窗口", null, delegate { RestoreFromTray(); });
            trayMenu.Items.Add("复制访问地址", null, delegate { CopyLanAddress(); });
            trayMenu.Items.Add("打开接收目录", null, delegate { OpenUploadDirectory(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("退出", null, delegate
            {
                allowExit = true;
                Close();
            });
            trayIcon = new NotifyIcon
            {
                Icon = Icon ?? SystemIcons.Application,
                Text = "近邻 · 局域网工具箱",
                ContextMenuStrip = trayMenu,
                Visible = true
            };
            trayIcon.DoubleClick += delegate { RestoreFromTray(); };

            Shown += async delegate { await StartApplicationAsync(); };
            FormClosing += OnFormClosing;
        }

        private Button CreateButton(string text, int width)
        {
            return new Button
            {
                Text = text,
                Width = width,
                Height = 32,
                Margin = new Padding(4, 1, 0, 0),
                FlatStyle = FlatStyle.System,
                UseVisualStyleBackColor = true
            };
        }

        private async Task StartApplicationAsync()
        {
            string error;
            if (!Program.StartServer(out error))
            {
                SetStoppedState("无法监听端口 8787：" + error);
                return;
            }

            RefreshStatus();
            statusTimer.Start();
            await InitializeBrowserAsync();
        }

        private async Task InitializeBrowserAsync()
        {
            if (browserReady || closing) return;
            try
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NearbyLanToolbox",
                    "WebView2");
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await browser.EnsureCoreWebView2Async(environment);
                if (closing) return;

                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                browser.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
                {
                    e.Handled = true;
                    browser.CoreWebView2.Navigate(e.Uri);
                };
                browser.CoreWebView2.ProcessFailed += delegate
                {
                    BeginInvoke(new Action(delegate
                    {
                        statusText.Text = "页面内核意外停止，请点击刷新重试";
                    }));
                };

                browserReady = true;
                refreshButton.Enabled = true;
                browser.Source = new Uri("http://127.0.0.1:" + Program.Port + "/");
            }
            catch (Exception ex)
            {
                browserReady = false;
                refreshButton.Enabled = false;
                statusText.Text = "内嵌页面启动失败";
                MessageBox.Show(
                    "无法启动软件内嵌页面。请确认电脑已安装 Microsoft Edge WebView2 Runtime。\r\n\r\n" + ex.Message,
                    "近邻 · 局域网工具箱",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private async void ToggleService()
        {
            serviceButton.Enabled = false;
            try
            {
                if (Program.IsRunning)
                {
                    statusTimer.Stop();
                    Program.StopServer();
                    SetStoppedState("服务已停止，局域网设备暂时无法访问");
                    if (browserReady) browser.CoreWebView2.NavigateToString(StoppedPage());
                }
                else
                {
                    string error;
                    if (!Program.StartServer(out error))
                    {
                        SetStoppedState("启动失败：" + error);
                        return;
                    }
                    RefreshStatus();
                    statusTimer.Start();
                    if (!browserReady) await InitializeBrowserAsync();
                    else browser.CoreWebView2.Navigate("http://127.0.0.1:" + Program.Port + "/");
                }
            }
            finally
            {
                serviceButton.Enabled = true;
            }
        }

        private void ReloadBrowser()
        {
            if (!browserReady) return;
            if (Program.IsRunning) browser.CoreWebView2.Navigate("http://127.0.0.1:" + Program.Port + "/");
            else browser.CoreWebView2.NavigateToString(StoppedPage());
        }

        private void RefreshStatus()
        {
            if (!Program.IsRunning)
            {
                SetStoppedState("服务已停止");
                return;
            }

            string address = Program.NetworkUrls().FirstOrDefault(delegate(string url)
            {
                return !url.Contains("127.0.0.1") && !url.Contains("localhost");
            }) ?? ("http://127.0.0.1:" + Program.Port);
            int clients = Program.ConnectedClientCount();
            statusText.Text = "服务运行中 · " + clients + " 台设备在线 · " + address;
            statusText.ForeColor = Color.FromArgb(42, 111, 83);
            serviceButton.Text = "停止服务";
        }

        private void SetStoppedState(string text)
        {
            statusText.Text = text;
            statusText.ForeColor = Color.FromArgb(166, 74, 64);
            serviceButton.Text = "启动服务";
        }

        private void CopyLanAddress()
        {
            string address = LanAddress();
            try
            {
                Clipboard.SetText(address);
                statusText.Text = "访问地址已复制 · " + address;
            }
            catch (Exception ex)
            {
                MessageBox.Show("复制失败：" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private string LanAddress()
        {
            return Program.NetworkUrls().FirstOrDefault(delegate(string url)
            {
                return !url.Contains("127.0.0.1") && !url.Contains("localhost");
            }) ?? ("http://127.0.0.1:" + Program.Port);
        }

        private void ShowConnectionDialog()
        {
            string address = LanAddress();
            using (Form dialog = new Form())
            {
                dialog.Text = "扫码连接与访问密码";
                dialog.ClientSize = new Size(500, 590);
                dialog.MinimumSize = dialog.MaximumSize = dialog.Size;
                dialog.StartPosition = FormStartPosition.CenterParent;
                dialog.ShowInTaskbar = false;
                dialog.Font = Font;
                dialog.BackColor = Color.White;
                try { dialog.Icon = Icon; } catch { }

                Label title = new Label
                {
                    Text = "同一 Wi-Fi 设备扫码连接",
                    Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
                    AutoSize = true,
                    Location = new Point(28, 22)
                };
                dialog.Controls.Add(title);

                Label tip = new Label
                {
                    Text = "二维码只包含局域网访问地址，密码可按需启用。",
                    ForeColor = Color.FromArgb(92, 104, 110),
                    AutoSize = true,
                    Location = new Point(30, 57)
                };
                dialog.Controls.Add(tip);

                PictureBox qrBox = new PictureBox
                {
                    Location = new Point(120, 88),
                    Size = new Size(260, 260),
                    SizeMode = PictureBoxSizeMode.Zoom,
                    BackColor = Color.White
                };
                try { qrBox.Image = CreateQrCode(address, 260); }
                catch (Exception ex)
                {
                    MessageBox.Show("二维码生成失败：" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                dialog.Controls.Add(qrBox);

                TextBox addressBox = new TextBox
                {
                    ReadOnly = true,
                    Text = address,
                    Location = new Point(28, 362),
                    Size = new Size(348, 27)
                };
                dialog.Controls.Add(addressBox);

                Button copyButton = CreateButton("复制地址", 84);
                copyButton.Location = new Point(388, 359);
                copyButton.Click += delegate
                {
                    try { Clipboard.SetText(address); statusText.Text = "访问地址已复制 · " + address; }
                    catch (Exception ex) { MessageBox.Show("复制失败：" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                };
                dialog.Controls.Add(copyButton);

                CheckBox enablePassword = new CheckBox
                {
                    Text = "启用访问密码",
                    Checked = Program.IsAccessPasswordEnabled,
                    AutoSize = true,
                    Location = new Point(30, 414)
                };
                dialog.Controls.Add(enablePassword);

                TextBox passwordBox = new TextBox
                {
                    Text = Program.CurrentAccessPassword,
                    MaxLength = 8,
                    UseSystemPasswordChar = true,
                    Location = new Point(30, 449),
                    Size = new Size(260, 27)
                };
                dialog.Controls.Add(passwordBox);

                Button generateButton = CreateButton("随机生成", 84);
                generateButton.Location = new Point(302, 446);
                generateButton.Click += delegate { passwordBox.Text = Program.NewAccessPassword(); };
                dialog.Controls.Add(generateButton);

                Button revealButton = CreateButton("显示", 72);
                revealButton.Location = new Point(398, 446);
                revealButton.Click += delegate
                {
                    passwordBox.UseSystemPasswordChar = !passwordBox.UseSystemPasswordChar;
                    revealButton.Text = passwordBox.UseSystemPasswordChar ? "显示" : "隐藏";
                };
                dialog.Controls.Add(revealButton);

                Label passwordTip = new Label
                {
                    Text = "启用后，手机和其他电脑需要输入 4 到 8 位数字密码。",
                    ForeColor = Color.FromArgb(92, 104, 110),
                    AutoSize = true,
                    Location = new Point(30, 484)
                };
                dialog.Controls.Add(passwordTip);

                Action updatePasswordControls = delegate
                {
                    passwordBox.Enabled = enablePassword.Checked;
                    generateButton.Enabled = enablePassword.Checked;
                    revealButton.Enabled = enablePassword.Checked;
                };
                enablePassword.CheckedChanged += delegate { updatePasswordControls(); };
                updatePasswordControls();

                Button cancelButton = CreateButton("取消", 84);
                cancelButton.Location = new Point(298, 532);
                cancelButton.DialogResult = DialogResult.Cancel;
                dialog.Controls.Add(cancelButton);

                Button applyButton = CreateButton("应用", 84);
                applyButton.Location = new Point(388, 532);
                applyButton.Click += delegate
                {
                    if (enablePassword.Checked && String.IsNullOrWhiteSpace(passwordBox.Text))
                        passwordBox.Text = Program.NewAccessPassword();
                    string error;
                    if (!Program.SetAccessPassword(enablePassword.Checked, passwordBox.Text, out error))
                    {
                        MessageBox.Show(error, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        passwordBox.Focus();
                        return;
                    }
                    statusText.Text = enablePassword.Checked
                        ? "访问密码已启用 · 远程设备需要密码"
                        : "访问密码已关闭 · 同一局域网设备可直接连接";
                    dialog.DialogResult = DialogResult.OK;
                    dialog.Close();
                };
                dialog.Controls.Add(applyButton);
                dialog.AcceptButton = applyButton;
                dialog.CancelButton = cancelButton;

                dialog.FormClosed += delegate
                {
                    Image image = qrBox.Image;
                    qrBox.Image = null;
                    if (image != null) image.Dispose();
                };
                dialog.ShowDialog(this);
            }
        }

        private static Bitmap CreateQrCode(string text, int size)
        {
            BarcodeWriter writer = new BarcodeWriter
            {
                Format = BarcodeFormat.QR_CODE,
                Options = new QrCodeEncodingOptions
                {
                    Width = size,
                    Height = size,
                    Margin = 1,
                    CharacterSet = "UTF-8"
                }
            };
            return writer.Write(text);
        }

        private void OpenUploadDirectory()
        {
            try
            {
                Directory.CreateDirectory(Program.UploadDirectoryPath);
                Process.Start("explorer.exe", "\"" + Program.UploadDirectoryPath + "\"");
            }
            catch (Exception ex)
            {
                MessageBox.Show("无法打开接收目录：" + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void ChooseUploadDirectory()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择接收文件保存目录";
                dialog.SelectedPath = Program.UploadDirectoryPath;
                dialog.ShowNewFolderButton = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;

                bool wasRunning = Program.IsRunning;
                if (wasRunning)
                {
                    statusTimer.Stop();
                    Program.StopServer();
                }

                string error;
                if (!Program.SetUploadDirectory(dialog.SelectedPath, out error))
                {
                    MessageBox.Show("无法使用所选目录：" + error, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }

                if (wasRunning)
                {
                    string startError;
                    if (Program.StartServer(out startError))
                    {
                        statusTimer.Start();
                        RefreshStatus();
                        if (browserReady) browser.CoreWebView2.Navigate("http://127.0.0.1:" + Program.Port + "/");
                    }
                    else
                    {
                        SetStoppedState("目录已更改，但服务重启失败：" + startError);
                    }
                }
                else
                {
                    SetStoppedState("接收目录已更改，服务仍处于停止状态");
                }
            }
        }

        private string StoppedPage()
        {
            return "<!doctype html><html><head><meta charset='utf-8'><style>body{margin:0;display:grid;place-items:center;height:100vh;font-family:'Microsoft YaHei UI',sans-serif;background:#f7f8f5;color:#273139}main{text-align:center}h2{font-size:24px;margin:0 0 10px}p{color:#69747a}</style></head><body><main><h2>局域网服务已停止</h2><p>点击窗口右上方的“启动服务”即可继续使用。</p></main></body></html>";
        }

        private void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            if (!trayHintShown)
            {
                trayHintShown = true;
                trayIcon.BalloonTipTitle = "近邻仍在运行";
                trayIcon.BalloonTipText = "双击托盘图标可恢复窗口，右键菜单可以退出。";
                trayIcon.ShowBalloonTip(2500);
            }
        }

        private void RestoreFromTray()
        {
            if (closing) return;
            ShowInTaskbar = true;
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!allowExit && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            closing = true;
            statusTimer.Stop();
            Program.StopServer();
            trayIcon.Visible = false;
            try { trayIcon.Dispose(); } catch { }
            try { browser.Dispose(); } catch { }
        }
    }
}
