using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace NearbyLanToolbox
{
    internal static class WebViewRuntime
    {
        private const string Version = "1.0.2535.41";
        private static readonly Dictionary<string, Assembly> LoadedAssemblies = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);

        [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string pathName);

        internal static void Initialize()
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbeddedAssembly;

            string architecture = IntPtr.Size == 8 ? "x64" : "x86";
            string runtimeDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "NearbyLanToolbox",
                "runtime",
                Version,
                architecture);
            Directory.CreateDirectory(runtimeDirectory);

            string loaderPath = Path.Combine(runtimeDirectory, "WebView2Loader.dll");
            string resourceName = "NearbyLanToolbox.WebView2Loader." + architecture + ".dll";
            ExtractResource(resourceName, loaderPath);
            SetDllDirectory(runtimeDirectory);
        }

        private static Assembly ResolveEmbeddedAssembly(object sender, ResolveEventArgs args)
        {
            AssemblyName requested = new AssemblyName(args.Name);
            Assembly loaded;
            if (LoadedAssemblies.TryGetValue(requested.Name, out loaded)) return loaded;

            string resourceName;
            if (requested.Name.Equals("Microsoft.Web.WebView2.Core", StringComparison.OrdinalIgnoreCase))
                resourceName = "NearbyLanToolbox.Microsoft.Web.WebView2.Core.dll";
            else if (requested.Name.Equals("Microsoft.Web.WebView2.WinForms", StringComparison.OrdinalIgnoreCase))
                resourceName = "NearbyLanToolbox.Microsoft.Web.WebView2.WinForms.dll";
            else if (requested.Name.Equals("zxing", StringComparison.OrdinalIgnoreCase))
                resourceName = "NearbyLanToolbox.zxing.dll";
            else
                return null;

            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) return null;
                byte[] bytes = ReadAllBytes(stream);
                loaded = Assembly.Load(bytes);
                LoadedAssemblies[requested.Name] = loaded;
                return loaded;
            }
        }

        private static void ExtractResource(string resourceName, string destination)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidOperationException("缺少内嵌组件：" + resourceName);
                if (File.Exists(destination) && new FileInfo(destination).Length == stream.Length) return;

                string temporary = destination + ".tmp";
                using (FileStream output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                    stream.CopyTo(output);
                if (File.Exists(destination)) File.Delete(destination);
                File.Move(temporary, destination);
            }
        }

        private static byte[] ReadAllBytes(Stream stream)
        {
            using (MemoryStream memory = new MemoryStream())
            {
                stream.CopyTo(memory);
                return memory.ToArray();
            }
        }
    }
}
