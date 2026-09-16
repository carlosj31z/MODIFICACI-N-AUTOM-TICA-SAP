using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;

namespace SapFioriAutomation
{
    public class AutomationTask : INotifyPropertyChanged
    {
        // Capturado al crear la tarea (en el hilo de UI, al cargar el Excel) para
        // poder marshalear las notificaciones cuando Estado/Mensaje se actualizan
        // desde el hilo de fondo de Selenium; evita cross-thread exceptions en el
        // DataGridView enlazado en vivo.
        private readonly SynchronizationContext? _syncContext = SynchronizationContext.Current;

        private string _estado = "Pendiente";
        private string _mensaje = string.Empty;

        public string Material { get; set; } = string.Empty;
        public string Centro { get; set; } = string.Empty;
        public string Transaccion { get; set; } = string.Empty;
        public string Vista { get; set; } = string.Empty;
        public string CampoTecnico { get; set; } = string.Empty;
        public string Valor { get; set; } = string.Empty;
        public int Orden { get; set; }
        public bool Obligatorio { get; set; } = true;

        public string Estado
        {
            get => _estado;
            set { _estado = value; OnPropertyChanged(); }
        }

        public string Mensaje
        {
            get => _mensaje;
            set { _mensaje = value; OnPropertyChanged(); }
        }

        public event PropertyChangedEventHandler? PropertyChanged;

        private void OnPropertyChanged([CallerMemberName] string? name = null)
        {
            var handler = PropertyChanged;
            if (handler == null) return;

            if (_syncContext != null)
                _syncContext.Post(_ => handler(this, new PropertyChangedEventArgs(name)), null);
            else
                handler(this, new PropertyChangedEventArgs(name));
        }
    }

    public class FieldMapping
    {
        public string FriendlyName { get; set; } = string.Empty;
        public List<SelectorInfo> Selectors { get; set; } = new();
    }

    public class SelectorInfo
    {
        public string Type { get; set; } = "css"; // "css" o "xpath"
        public string Value { get; set; } = string.Empty;
        public int Priority { get; set; }
        public string Description { get; set; } = string.Empty;
    }
}
