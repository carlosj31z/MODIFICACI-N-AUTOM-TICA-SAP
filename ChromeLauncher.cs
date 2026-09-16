using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;

namespace SapFioriAutomation
{
    /// <summary>
    /// Permite abrir Chrome con el puerto de depuración remota habilitado sin que el
    /// usuario tenga que abrir una ventana de comandos manualmente.
    /// </summary>
    public static class ChromeLauncher
    {
        public static string? FindChromePath()
        {
            var candidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"),
            };

            foreach (var path in candidates)
            {
                if (File.Exists(path)) return path;
            }
            return null;
        }

        public static Process LaunchWithDebugPort(string chromePath, int port, string userDataDir, string? startUrl)
        {
            Directory.CreateDirectory(userDataDir);

            var psi = new ProcessStartInfo
            {
                FileName = chromePath,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add($"--remote-debugging-port={port}");
            psi.ArgumentList.Add($"--user-data-dir={userDataDir}");
            psi.ArgumentList.Add("--no-first-run");
            psi.ArgumentList.Add("--no-default-browser-check");
            if (!string.IsNullOrWhiteSpace(startUrl))
            {
                psi.ArgumentList.Add(startUrl);
            }

            return Process.Start(psi) ?? throw new InvalidOperationException("No se pudo iniciar Chrome.");
        }

        /// <summary>Sondea el endpoint de depuración remota hasta que responde o se agota el tiempo.</summary>
        public static async Task<bool> WaitForDebugPortAsync(int port, TimeSpan timeout)
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var deadline = DateTime.UtcNow + timeout;

            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    var response = await http.GetAsync($"http://127.0.0.1:{port}/json/version");
                    if (response.IsSuccessStatusCode) return true;
                }
                catch
                {
                    // Chrome todavía no levantó el endpoint; reintentar.
                }
                await Task.Delay(500);
            }
            return false;
        }

        public static async Task<bool> IsDebugPortAliveAsync(int port)
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(1.5) };
            try
            {
                var response = await http.GetAsync($"http://127.0.0.1:{port}/json/version");
                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }
    }
}
