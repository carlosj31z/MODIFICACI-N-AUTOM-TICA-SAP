using System;
using System.IO;
using System.Text.Json;

namespace SapFioriAutomation
{
    public class AppSettings
    {
        public string ChromePath { get; set; } = string.Empty;
        public string LaunchpadUrl { get; set; } = string.Empty;
        public int DebugPort { get; set; } = 9222;

        private static string ConfigPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "SapFioriAutomation", "config.json");

        public static AppSettings Load()
        {
            try
            {
                if (File.Exists(ConfigPath))
                {
                    var json = File.ReadAllText(ConfigPath);
                    var loaded = JsonSerializer.Deserialize<AppSettings>(json);
                    if (loaded != null) return loaded;
                }
            }
            catch
            {
                // Config corrupta o inaccesible: se usan valores por defecto.
            }
            return new AppSettings();
        }

        public void Save()
        {
            try
            {
                var dir = Path.GetDirectoryName(ConfigPath)!;
                Directory.CreateDirectory(dir);
                var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(ConfigPath, json);
            }
            catch
            {
                // No es crítico si no se puede persistir la configuración.
            }
        }
    }
}
