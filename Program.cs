using System;
using System.Windows.Forms;

namespace SapFioriAutomation
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm()); // Aquí le decimos que arranque con tu nueva ventana
        }
    }
}