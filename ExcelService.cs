using ClosedXML.Excel;
using System.Collections.Generic;
using System.Linq;

namespace SapFioriAutomation
{
    public class ExcelService
    {
        // Mapeo automático de tu archivo "Correccion validacion DM Ago26.xlsx".
        // El campo "Vista" debe ser EXACTAMENTE el texto de la pestaña tal como
        // lo muestra SAP en la pantalla de MM02 (no el nombre largo/formal) —
        // así SwitchToViewTab lo encuentra sin necesitar traducción. Lista
        // completa de vistas disponibles en MM02 (cópialas tal cual si agregas
        // más campos):
        //   Datos básicos 1 | Datos básicos 2 | Clasificación
        //   Ventas: Datos org.ventas 1 | Ventas: Datos org.ventas 2 | Ventas: Datos centro/gral.
        //   Datos básicos SPP ampliados
        //   Comercio exterior: Exportación | Texto comercial
        //   Compras | Comercio exterior: Importación | Texto de pedido de compras
        //   Planif.necesidades 1 | Planif.necesidades 2 | Planif.necesidades 3 | Planif.necesidades 4
        //   Planificación avanzada | SPP ampliado | Preparación de trabajo
        //   Dat.gral.ce./Almacenamiento 1 | Dat.gral.ce./Almacenamiento 2
        //   Gestión de calidad
        //   Contabilidad 1 | Contabilidad 2 | Cálculo coste 1 | Cálculo del coste 2
        //   Stock de centro | Stock almacén | Ejecución WM | WM Packaging
        //   Datos de valoración segmento
        private static readonly Dictionary<string, (string Vista, string Campo)> SheetMappings = new()
        {
            { "Grupo art", ("Datos básicos 1", "MATKL") },
            { "Planif", ("Planif.necesidades 1", "DISPO") },
            { "Plazo entr", ("Planif.necesidades 2", "PLIFZ") },
            { "Aprov esp", ("Planif.necesidades 2", "SOBSL") },
            { "Resp prd", ("Preparación de trabajo", "FEVOR") }
            // Agrega el resto de pestañas aquí si lo deseas
        };

        public List<AutomationTask> LoadTasksFromExcel(string filePath)
        {
            var tasks = new List<AutomationTask>();

            using (var workbook = new XLWorkbook(filePath))
            {
                // Detectar si es el formato de Auditoría (multi-pestaña) o formato plano
                if (workbook.Worksheets.Any(ws => SheetMappings.ContainsKey(ws.Name)))
                {
                    return ReadAuditFormat(workbook);
                }
                
                // Lectura de formato Plano Normal (Fila 1 = Encabezados)
                var sheet = workbook.Worksheet(1);
                var rows = sheet.RowsUsed().Skip(1);
                foreach (var row in rows)
                {
                    tasks.Add(new AutomationTask
                    {
                        Material = row.Cell(1).GetValue<string>(),
                        Centro = row.Cell(2).GetValue<string>(),
                        Transaccion = row.Cell(3).GetValue<string>(),
                        Vista = row.Cell(4).GetValue<string>(),
                        CampoTecnico = row.Cell(5).GetValue<string>(),
                        Valor = row.Cell(6).GetValue<string>(),
                        Orden = tasks.Count + 1,
                        Estado = "Pendiente"
                    });
                }
            }
            return tasks;
        }

        private List<AutomationTask> ReadAuditFormat(XLWorkbook workbook)
        {
            var tasks = new List<AutomationTask>();
            foreach (var sheet in workbook.Worksheets)
            {
                if (!SheetMappings.TryGetValue(sheet.Name, out var mapInfo)) continue;

                var firstRow = sheet.FirstRowUsed();
                if (firstRow == null) continue;

                int colMaterial = 0, colCentro = 0, colDebeDecir = 0;
                foreach (var cell in firstRow.CellsUsed())
                {
                    string header = cell.Value.ToString().Trim();
                    if (header.Equals("Material", System.StringComparison.OrdinalIgnoreCase)) colMaterial = cell.Address.ColumnNumber;
                    if (header.Equals("Centro", System.StringComparison.OrdinalIgnoreCase)) colCentro = cell.Address.ColumnNumber;
                    if (header.Equals("Debe decir", System.StringComparison.OrdinalIgnoreCase)) colDebeDecir = cell.Address.ColumnNumber;
                }

                if (colMaterial == 0 || colDebeDecir == 0) continue;

                foreach (var row in sheet.RowsUsed().Skip(1))
                {
                    string material = row.Cell(colMaterial).GetValue<string>().Trim();
                    string centro = colCentro > 0 ? row.Cell(colCentro).GetValue<string>().Trim() : "";
                    string valorNuevo = row.Cell(colDebeDecir).GetValue<string>().Trim();

                    // Ignorar registros de revisión manual o vacíos
                    if (string.IsNullOrWhiteSpace(material) || string.IsNullOrWhiteSpace(valorNuevo) || valorNuevo.Contains("Consultar"))
                        continue;

                    tasks.Add(new AutomationTask
                    {
                        Material = material, Centro = centro, Transaccion = "MM02",
                        Vista = mapInfo.Vista, CampoTecnico = mapInfo.Campo, Valor = valorNuevo,
                        Orden = tasks.Count + 1, Estado = "Pendiente"
                    });
                }
            }
            return tasks;
        }
    }
}