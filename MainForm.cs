using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace SapFioriAutomation
{
    public class MainForm : Form
    {
        // ---- Paleta oscura (estilo Claude dark / SAP Fiori dark) ---------
        private static readonly Color ColorAccent = Color.FromArgb(217, 119, 87);     // Terracota (más vivo sobre oscuro)
        private static readonly Color ColorAccentDark = Color.FromArgb(191, 100, 71);
        private static readonly Color ColorAccentSoft = Color.FromArgb(64, 45, 38);   // fondo suave del acento
        private static readonly Color ColorBg = Color.FromArgb(29, 28, 26);           // Carbón cálido
        private static readonly Color ColorCard = Color.FromArgb(38, 37, 34);
        // Más claro que ColorCard a propósito: un campo editable en modo oscuro
        // debe "resaltar hacia adelante" respecto a la tarjeta que lo contiene.
        // El valor anterior (más oscuro que la tarjeta) hacía que los campos se
        // fundieran con el fondo y quedaran casi invisibles.
        private static readonly Color ColorInputBg = Color.FromArgb(52, 50, 46);
        private static readonly Color ColorBorder = Color.FromArgb(82, 79, 72);
        private static readonly Color ColorText = Color.FromArgb(236, 234, 225);      // Crema casi blanco
        private static readonly Color ColorTextMuted = Color.FromArgb(159, 154, 140);
        private static readonly Color ColorSuccessBg = Color.FromArgb(32, 51, 38);
        private static readonly Color ColorSuccessFg = Color.FromArgb(126, 201, 140);
        private static readonly Color ColorErrorBg = Color.FromArgb(59, 36, 32);
        private static readonly Color ColorErrorFg = Color.FromArgb(233, 141, 122);

        // Altura mínima segura para que el texto de un botón (con Segoe UI
        // Semibold ~9.5-10pt) no quede recortado a la mitad: WinForms necesita
        // más margen vertical del que parece a simple vista con FlatStyle.Flat.
        private const int ButtonHeight = 36;
        private const int SmallButtonHeight = 30;

        private DataGridView grid;
        private Button btnLoad, btnConnect, btnStart, btnStop, btnBrowseChrome, btnGenerate, btnRetryErrors;
        private Button btnAgregarPaso, btnQuitarPaso, btnGuardarSecuencia, btnCargarSecuencia, btnToggleConfig;
        private TextBox txtChromePath, txtLaunchpadUrl, txtCampoTecnico, txtPasteData;
        private ComboBox cmbTransaccion, cmbVista;
        private ListBox lstSecuencia;
        private CheckBox chkStopOnError;
        private Panel panelConfigBody;
        private Label lblConnStatus, lblSummary, lblPaste, lblHeaderTitle;
        private RichTextBox txtLog;
        private readonly BindingList<FieldStep> secuencia = new();

        // Vistas reales de MM02 tal como SAP las muestra en pantalla (ver
        // ExcelService.SheetMappings para el detalle) — se ofrecen en el combo
        // para que el usuario no tenga que escribirlas ni adivinar el texto.
        private static readonly string[] VistasConocidas =
        {
            "Datos básicos 1", "Datos básicos 2", "Clasificación",
            "Ventas: Datos org.ventas 1", "Ventas: Datos org.ventas 2", "Ventas: Datos centro/gral.",
            "Datos básicos SPP ampliados",
            "Comercio exterior: Exportación", "Texto comercial",
            "Compras", "Comercio exterior: Importación", "Texto de pedido de compras",
            "Planif.necesidades 1", "Planif.necesidades 2", "Planif.necesidades 3", "Planif.necesidades 4",
            "Planificación avanzada", "SPP ampliado", "Preparación de trabajo",
            "Dat.gral.ce./Almacenamiento 1", "Dat.gral.ce./Almacenamiento 2",
            "Gestión de calidad",
            "Contabilidad 1", "Contabilidad 2", "Cálculo coste 1", "Cálculo del coste 2",
            "Stock de centro", "Stock almacén", "Ejecución WM", "WM Packaging",
            "Datos de valoración segmento",
        };

        private BindingList<AutomationTask> taskList = new();
        private CancellationTokenSource? cts;
        private AppSettings settings = AppSettings.Load();
        private bool chromeConnected = false;

        public MainForm()
        {
            InitializeComponent();
            LoadSettingsIntoUi();
            _ = RefreshConnectionStatusAsync();
        }

        // =================================================================
        //  UI
        // =================================================================

        private void InitializeComponent()
        {
            this.Text = "Automatización SAP · Maestro de Materiales";
            this.Size = new Size(1180, 920);
            this.MinimumSize = new Size(980, 780);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Font = new Font("Segoe UI", 9.5f);
            this.BackColor = ColorBg;

            this.Controls.Add(BuildMainSplit());
            this.Controls.Add(BuildLog());
            this.Controls.Add(BuildConfigCard());
            this.Controls.Add(BuildHeader());
        }

        // ---- División arrastrable: datos/pegado (arriba) vs. resultados (abajo) --

        private SplitContainer BuildMainSplit()
        {
            var split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                BackColor = ColorBorder,
                SplitterWidth = 6
            };
            // Panel1MinSize/Panel2MinSize/SplitterDistance se fijan recién en
            // Load (ver abajo): asignarlos aquí, con el control todavía en 0x0,
            // hace que SplitContainer revalide el SplitterDistance por defecto
            // contra un tamaño inexistente y lance InvalidOperationException
            // ANTES de que la ventana llegue a mostrarse (crash silencioso).
            split.Panel1.BackColor = ColorBg;
            split.Panel2.BackColor = ColorBg;
            split.Panel1.Controls.Add(BuildDataCard());

            var bottomHost = new Panel { Dock = DockStyle.Fill, BackColor = ColorBg };
            bottomHost.Controls.Add(BuildGrid());
            bottomHost.Controls.Add(BuildExecutionBar());
            split.Panel2.Controls.Add(bottomHost);

            this.Load += (_, _) =>
            {
                try
                {
                    split.Panel1MinSize = 320;
                    split.Panel2MinSize = 160;
                    // Por defecto se le da la mayoría del espacio al área de
                    // pegado (arriba): es lo primero que se usa y necesita verse
                    // como una hoja de cálculo completa, no un cuadro chico que
                    // haya que agrandar a mano. Abajo solo queda reservado lo
                    // justo para la barra de ejecución + una vista previa de la
                    // grilla de resultados.
                    split.SplitterDistance = Math.Max(320, split.Height - 190);
                    // Al redimensionar la ventana, que el área de pegado
                    // (Panel1) sea la que absorbe el cambio de tamaño; la franja
                    // de resultados (Panel2) se mantiene con el tamaño que el
                    // usuario le dejó.
                    split.FixedPanel = FixedPanel.Panel2;
                }
                catch { /* deja los valores por defecto si el layout aún no está listo */ }
            };

            return split;
        }

        // ---- Encabezado --------------------------------------------------

        private Panel BuildHeader()
        {
            var header = new Panel { Dock = DockStyle.Top, Height = 60, BackColor = ColorCard };
            header.Paint += (s, e) =>
            {
                using var pen = new Pen(ColorBorder);
                e.Graphics.DrawLine(pen, 0, header.Height - 1, header.Width, header.Height - 1);
            };

            // Pequeña marca de color en vez de logo/emoji: un acento cuadrado
            // redondeado, coherente con el estilo minimalista de Claude.
            var mark = new Panel
            {
                Size = new Size(10, 28),
                Location = new Point(18, 16),
                BackColor = ColorAccent
            };

            lblHeaderTitle = new Label
            {
                Text = "Automatización SAP  ·  Maestro de Materiales",
                AutoSize = true,
                Location = new Point(38, 19),
                ForeColor = ColorText,
                Font = new Font("Segoe UI Semibold", 12.5f, FontStyle.Bold)
            };

            lblConnStatus = new Label
            {
                Text = "●  Verificando Chrome...",
                AutoSize = true,
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                ForeColor = ColorTextMuted,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                BackColor = Color.Transparent
            };
            header.Resize += (_, _) => lblConnStatus.Location =
                new Point(header.Width - lblConnStatus.Width - 190, 22);

            btnConnect = new Button
            {
                Text = "Conectar a SAP",
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                Width = 160,
                Height = ButtonHeight,
                FlatStyle = FlatStyle.Flat,
                BackColor = ColorAccent,
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                Cursor = Cursors.Hand,
                TextAlign = ContentAlignment.MiddleCenter
            };
            btnConnect.FlatAppearance.BorderSize = 0;
            btnConnect.FlatAppearance.MouseOverBackColor = ColorAccentDark;
            btnConnect.Click += BtnConnect_Click;
            header.Resize += (_, _) => btnConnect.Location = new Point(header.Width - btnConnect.Width - 16, 12);

            header.Controls.Add(mark);
            header.Controls.Add(lblHeaderTitle);
            header.Controls.Add(lblConnStatus);
            header.Controls.Add(btnConnect);
            return header;
        }

        // ---- Tarjeta: configuración de conexión (colapsable) --------------

        private const int ConfigBodyHeight = 76;
        private const int ConfigToggleHeight = 30;

        private Panel BuildConfigCard()
        {
            var outer = new Panel { Dock = DockStyle.Top, Height = ConfigToggleHeight, BackColor = ColorBg };

            btnToggleConfig = new Button
            {
                Text = "▸  Configuración de conexión (ruta de Chrome, URL del Launchpad)",
                Dock = DockStyle.Top,
                Height = ConfigToggleHeight,
                TextAlign = ContentAlignment.MiddleLeft,
                FlatStyle = FlatStyle.Flat,
                BackColor = ColorBg,
                ForeColor = ColorTextMuted,
                Font = new Font("Segoe UI", 9f),
                Cursor = Cursors.Hand,
                Padding = new Padding(12, 0, 0, 0)
            };
            btnToggleConfig.FlatAppearance.BorderSize = 0;

            panelConfigBody = new Panel
            {
                Dock = DockStyle.Top,
                Height = ConfigBodyHeight,
                BackColor = ColorCard,
                Padding = new Padding(16, 10, 16, 10),
                Visible = false
            };
            panelConfigBody.Paint += (s, e) => DrawCardBorder(panelConfigBody, e);

            var lblChrome = new Label { Text = "Ruta de Chrome:", AutoSize = true, Location = new Point(0, 6), ForeColor = ColorTextMuted };
            txtChromePath = ThemedTextBox();
            txtChromePath.Location = new Point(120, 3);
            txtChromePath.Width = 500;
            txtChromePath.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            btnBrowseChrome = SecondaryButton("...");
            btnBrowseChrome.Location = new Point(626, 1);
            btnBrowseChrome.Width = 32;
            btnBrowseChrome.Height = SmallButtonHeight;
            btnBrowseChrome.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnBrowseChrome.Click += BtnBrowseChrome_Click;

            var lblUrl = new Label { Text = "URL Launchpad SAP:", AutoSize = true, Location = new Point(0, 38), ForeColor = ColorTextMuted };
            txtLaunchpadUrl = ThemedTextBox();
            txtLaunchpadUrl.Location = new Point(120, 35);
            txtLaunchpadUrl.Width = 536;
            txtLaunchpadUrl.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtLaunchpadUrl.Leave += (_, _) => PersistSettingsFromUi();
            txtChromePath.Leave += (_, _) => PersistSettingsFromUi();

            panelConfigBody.Controls.Add(lblChrome);
            panelConfigBody.Controls.Add(txtChromePath);
            panelConfigBody.Controls.Add(btnBrowseChrome);
            panelConfigBody.Controls.Add(lblUrl);
            panelConfigBody.Controls.Add(txtLaunchpadUrl);

            btnToggleConfig.Click += (_, _) =>
            {
                panelConfigBody.Visible = !panelConfigBody.Visible;
                btnToggleConfig.Text = (panelConfigBody.Visible ? "▾" : "▸") +
                    "  Configuración de conexión (ruta de Chrome, URL del Launchpad)";
                outer.Height = ConfigToggleHeight + (panelConfigBody.Visible ? ConfigBodyHeight : 0);
            };

            outer.Controls.Add(panelConfigBody);
            outer.Controls.Add(btnToggleConfig);
            return outer;
        }

        // ---- Barra de ejecución ------------------------------------------

        private Panel BuildExecutionBar()
        {
            var bar = new Panel { Dock = DockStyle.Top, Height = 64, BackColor = ColorCard, Padding = new Padding(16, 10, 16, 10) };
            bar.Paint += (s, e) => DrawCardBorder(bar, e);

            btnStart = PrimaryButton("▶  Iniciar corrección", ColorAccent);
            btnStart.Location = new Point(0, 4);
            btnStart.Width = 170;
            btnStart.Enabled = false;
            btnStart.Click += BtnStart_Click;

            btnStop = PrimaryButton("⏹  Detener", Color.FromArgb(180, 76, 56));
            btnStop.Location = new Point(178, 4);
            btnStop.Width = 110;
            btnStop.Enabled = false;
            btnStop.Click += BtnStop_Click;

            btnRetryErrors = PrimaryButton("Reintentar errores", Color.FromArgb(184, 138, 61));
            btnRetryErrors.Location = new Point(296, 4);
            btnRetryErrors.Width = 170;
            btnRetryErrors.Enabled = false;
            btnRetryErrors.Click += BtnRetryErrors_Click;

            chkStopOnError = new CheckBox
            {
                Text = "Detener al primer error",
                Checked = true,
                AutoSize = true,
                Location = new Point(480, 12),
                ForeColor = ColorTextMuted
            };

            lblSummary = new Label
            {
                Text = "",
                AutoSize = true,
                Anchor = AnchorStyles.Top | AnchorStyles.Right,
                Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold),
                ForeColor = ColorText,
                Location = new Point(700, 13)
            };
            bar.Resize += (_, _) => lblSummary.Location = new Point(Math.Max(700, bar.Width - lblSummary.Width - 18), 13);

            bar.Controls.Add(btnStart);
            bar.Controls.Add(btnStop);
            bar.Controls.Add(btnRetryErrors);
            bar.Controls.Add(chkStopOnError);
            bar.Controls.Add(lblSummary);
            return bar;
        }

        private static Button PrimaryButton(string text, Color color) => new Button
        {
            Text = text,
            Height = ButtonHeight,
            FlatStyle = FlatStyle.Flat,
            BackColor = color,
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
            Cursor = Cursors.Hand,
            TextAlign = ContentAlignment.MiddleCenter,
            UseCompatibleTextRendering = false,
            FlatAppearance = { BorderSize = 0 }
        };

        private static Button SecondaryButton(string text) => new Button
        {
            Text = text,
            Height = ButtonHeight,
            FlatStyle = FlatStyle.Flat,
            BackColor = ColorCard,
            ForeColor = ColorText,
            Font = new Font("Segoe UI", 9.5f),
            Cursor = Cursors.Hand,
            TextAlign = ContentAlignment.MiddleCenter,
            UseCompatibleTextRendering = false,
            FlatAppearance = { BorderSize = 1, BorderColor = ColorBorder }
        };

        /// <summary>
        /// El BorderStyle.FixedSingle nativo de un TextBox usa el color de borde
        /// del tema de Windows, que en modo oscuro suele resultar casi invisible
        /// contra el fondo oscuro de la app. Se envuelve el control en un panel
        /// de 1px con el color de borde propio de la paleta para garantizar que
        /// se vea, sin importar el tema del sistema.
        /// </summary>
        private static Panel WithBorder(Control inner)
        {
            var wrapper = new Panel { Dock = inner.Dock, Padding = new Padding(1), BackColor = ColorBorder };
            inner.Dock = DockStyle.Fill;
            wrapper.Controls.Add(inner);
            return wrapper;
        }

        private static TextBox ThemedTextBox() => new TextBox
        {
            BackColor = ColorInputBg,
            ForeColor = ColorText,
            BorderStyle = BorderStyle.FixedSingle
        };

        private static ComboBox ThemedComboBox(ComboBoxStyle style)
        {
            var combo = new ComboBox
            {
                DropDownStyle = style,
                BackColor = ColorInputBg,
                ForeColor = ColorText,
                FlatStyle = FlatStyle.Flat,
                // El BackColor/ForeColor de arriba solo pinta el cuadro cerrado;
                // la lista desplegable la dibuja Windows en blanco nativo salvo
                // que se dibuje a mano.
                DrawMode = DrawMode.OwnerDrawFixed,
                ItemHeight = 18
            };
            combo.DrawItem += (s, e) =>
            {
                if (e.Index < 0) return;
                bool highlighted = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
                using var bg = new SolidBrush(highlighted ? ColorAccentSoft : ColorInputBg);
                e.Graphics.FillRectangle(bg, e.Bounds);
                var text = combo.Items[e.Index]?.ToString() ?? string.Empty;
                TextRenderer.DrawText(e.Graphics, text, combo.Font, e.Bounds, ColorText,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPrefix);
            };
            return combo;
        }

        // ---- Tarjeta principal: pestañas de datos -------------------------

        private Control BuildDataCard()
        {
            // Vive dentro del panel superior del SplitContainer (ver
            // BuildMainSplit): llena todo el espacio disponible, y el usuario
            // puede arrastrar la barra divisoria para darle más lugar al área
            // de pegado de materiales (necesita espacio tipo Excel para
            // cientos de filas).
            var outer = new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 10, 16, 8), BackColor = ColorBg };

            var tabs = new TabControl
            {
                Dock = DockStyle.Fill,
                Font = new Font("Segoe UI", 9.5f),
                DrawMode = TabDrawMode.OwnerDrawFixed,
                ItemSize = new Size(190, 30),
                Padding = new Point(14, 6)
            };
            // Windows pinta la fila de pestañas con el tema claro del sistema
            // sin importar BackColor; se dibuja a mano para que combine con el
            // resto de la interfaz oscura.
            tabs.DrawItem += (s, e) =>
            {
                var page = tabs.TabPages[e.Index];
                bool selected = e.Index == tabs.SelectedIndex;
                using var bg = new SolidBrush(selected ? ColorCard : ColorBg);
                e.Graphics.FillRectangle(bg, e.Bounds);
                TextRenderer.DrawText(e.Graphics, page.Text, tabs.Font, e.Bounds,
                    selected ? ColorAccent : ColorTextMuted,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            };

            tabs.TabPages.Add(BuildSequenceTab());
            tabs.TabPages.Add(BuildExcelTab());

            outer.Controls.Add(tabs);
            return outer;
        }

        private TabPage BuildSequenceTab()
        {
            var page = new TabPage("Definir qué corregir") { BackColor = ColorCard, Padding = new Padding(0) };

            // ---- Parte superior: definición de la secuencia (altura fija) ----
            var topPanel = new Panel { Dock = DockStyle.Top, Height = 172, BackColor = ColorCard, Padding = new Padding(14, 14, 14, 0) };

            var lblStep1 = new Label
            {
                Text = "1. Arma la secuencia de campos a corregir (el orden en que se llenan por material):",
                AutoSize = true,
                Location = new Point(0, 0),
                ForeColor = ColorText,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold)
            };

            var lblTransaccion = new Label { Text = "Transacción:", AutoSize = true, Location = new Point(0, 28), ForeColor = ColorTextMuted };
            cmbTransaccion = ThemedComboBox(ComboBoxStyle.DropDownList);
            cmbTransaccion.Location = new Point(90, 25);
            cmbTransaccion.Width = 70;
            cmbTransaccion.Items.Add("MM02");
            cmbTransaccion.SelectedIndex = 0;

            var lblVista = new Label { Text = "Vista:", AutoSize = true, Location = new Point(175, 28), ForeColor = ColorTextMuted };
            cmbVista = ThemedComboBox(ComboBoxStyle.DropDown);
            cmbVista.Location = new Point(215, 25);
            cmbVista.Width = 260;
            cmbVista.Items.AddRange(VistasConocidas);

            var lblCampo = new Label { Text = "Campo técnico:", AutoSize = true, Location = new Point(485, 28), ForeColor = ColorTextMuted };
            txtCampoTecnico = ThemedTextBox();
            txtCampoTecnico.Location = new Point(580, 25);
            txtCampoTecnico.Width = 90;
            txtCampoTecnico.CharacterCasing = CharacterCasing.Upper;

            btnAgregarPaso = SecondaryButton("+ Agregar paso");
            btnAgregarPaso.Location = new Point(680, 22);
            btnAgregarPaso.Width = 120;
            btnAgregarPaso.Height = SmallButtonHeight;
            btnAgregarPaso.Click += BtnAgregarPaso_Click;

            btnQuitarPaso = SecondaryButton("Quitar seleccionado");
            btnQuitarPaso.Location = new Point(806, 22);
            btnQuitarPaso.Width = 140;
            btnQuitarPaso.Height = SmallButtonHeight;
            btnQuitarPaso.Click += BtnQuitarPaso_Click;

            var lblSecuenciaLbl = new Label
            {
                Text = "Pasos definidos (orden de llenado):",
                AutoSize = true,
                Location = new Point(0, 58),
                ForeColor = ColorTextMuted
            };

            lstSecuencia = new ListBox
            {
                Location = new Point(0, 76),
                Height = 55,
                Width = 940,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
                DataSource = secuencia,
                BorderStyle = BorderStyle.FixedSingle,
                BackColor = ColorInputBg,
                ForeColor = ColorText
            };

            btnGuardarSecuencia = SecondaryButton("Guardar secuencia...");
            btnGuardarSecuencia.Location = new Point(0, 137);
            btnGuardarSecuencia.Width = 165;
            btnGuardarSecuencia.Height = SmallButtonHeight;
            btnGuardarSecuencia.Click += BtnGuardarSecuencia_Click;

            btnCargarSecuencia = SecondaryButton("Cargar secuencia...");
            btnCargarSecuencia.Location = new Point(171, 137);
            btnCargarSecuencia.Width = 165;
            btnCargarSecuencia.Height = SmallButtonHeight;
            btnCargarSecuencia.Click += BtnCargarSecuencia_Click;

            topPanel.Controls.Add(lblStep1);
            topPanel.Controls.Add(lblTransaccion);
            topPanel.Controls.Add(cmbTransaccion);
            topPanel.Controls.Add(lblVista);
            topPanel.Controls.Add(cmbVista);
            topPanel.Controls.Add(lblCampo);
            topPanel.Controls.Add(txtCampoTecnico);
            topPanel.Controls.Add(btnAgregarPaso);
            topPanel.Controls.Add(btnQuitarPaso);
            topPanel.Controls.Add(lblSecuenciaLbl);
            topPanel.Controls.Add(lstSecuencia);
            topPanel.Controls.Add(btnGuardarSecuencia);
            topPanel.Controls.Add(btnCargarSecuencia);

            // ---- Parte inferior: pegado de materiales (ocupa todo el resto) --
            var bottomPanel = new Panel { Dock = DockStyle.Fill, BackColor = ColorCard, Padding = new Padding(14, 4, 14, 14) };

            var lblStep2 = new Label
            {
                Text = "2. Pega los materiales a corregir (tipo hoja de cálculo, admite cientos de filas):",
                Dock = DockStyle.Top,
                Height = 22,
                ForeColor = ColorText,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold)
            };

            lblPaste = new Label
            {
                Dock = DockStyle.Top,
                AutoSize = false,
                Height = 40,
                ForeColor = ColorTextMuted
            };

            btnGenerate = PrimaryButton("Generar tareas ▸", ColorAccentDark);
            btnGenerate.Width = 200;
            btnGenerate.Margin = new Padding(0, 8, 0, 0);
            btnGenerate.Click += BtnGenerate_Click;
            // Envuelto en un FlowLayoutPanel Dock.Bottom para que ocupe solo su
            // ancho natural en vez de estirarse a todo lo ancho del panel.
            var btnGenerateWrap = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom,
                Height = ButtonHeight + 10,
                FlowDirection = FlowDirection.LeftToRight,
                BackColor = ColorCard
            };
            btnGenerateWrap.Controls.Add(btnGenerate);

            txtPasteData = ThemedTextBox();
            txtPasteData.BorderStyle = BorderStyle.None;
            txtPasteData.Dock = DockStyle.Fill;
            txtPasteData.Multiline = true;
            txtPasteData.ScrollBars = ScrollBars.Both;
            txtPasteData.WordWrap = false;
            txtPasteData.Font = new Font("Consolas", 9.5f);
            txtPasteData.AcceptsReturn = true;

            bottomPanel.Controls.Add(WithBorder(txtPasteData));
            bottomPanel.Controls.Add(btnGenerateWrap);
            bottomPanel.Controls.Add(lblPaste);
            bottomPanel.Controls.Add(lblStep2);

            secuencia.ListChanged += (_, _) => UpdatePasteLabel();
            UpdatePasteLabel();

            page.Controls.Add(bottomPanel);
            page.Controls.Add(topPanel);
            return page;
        }

        private TabPage BuildExcelTab()
        {
            var page = new TabPage("Cargar Excel de auditoría") { BackColor = ColorCard, Padding = new Padding(14) };

            var lblInfo = new Label
            {
                Text = "Carga el archivo de auditoría multi-pestaña (una pestaña por campo a corregir). " +
                       "El sistema detecta automáticamente el formato y genera las tareas por ti.",
                AutoSize = false,
                Size = new Size(700, 50),
                Location = new Point(0, 4),
                ForeColor = ColorTextMuted
            };

            btnLoad = PrimaryButton("Cargar archivo Excel...", ColorAccentDark);
            btnLoad.Location = new Point(0, 60);
            btnLoad.Width = 220;
            btnLoad.Click += BtnLoad_Click;

            page.Controls.Add(lblInfo);
            page.Controls.Add(btnLoad);
            return page;
        }

        // ---- Grilla y log --------------------------------------------------

        private DataGridView BuildGrid()
        {
            grid = new DataGridView
            {
                Dock = DockStyle.Fill,
                AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
                AllowUserToAddRows = false,
                ReadOnly = true,
                SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                BackgroundColor = ColorCard,
                BorderStyle = BorderStyle.None,
                GridColor = ColorBorder,
                RowHeadersVisible = false,
                Font = new Font("Segoe UI", 9.5f)
            };
            grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(48, 47, 43);
            grid.ColumnHeadersDefaultCellStyle.ForeColor = ColorTextMuted;
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);
            grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.ColumnHeadersHeight = 32;
            grid.EnableHeadersVisualStyles = false;
            grid.DefaultCellStyle.BackColor = ColorCard;
            grid.DefaultCellStyle.ForeColor = ColorText;
            grid.DefaultCellStyle.SelectionBackColor = ColorAccentSoft;
            grid.DefaultCellStyle.SelectionForeColor = ColorText;
            grid.CellFormatting += Grid_CellFormatting;
            return grid;
        }

        private Panel BuildLog()
        {
            var wrapper = new Panel { Dock = DockStyle.Bottom, Height = 150, BackColor = ColorInputBg, Padding = new Padding(0) };

            var lblLogTitle = new Label
            {
                Text = "  Registro de actividad",
                Dock = DockStyle.Top,
                Height = 22,
                ForeColor = ColorTextMuted,
                BackColor = ColorBg,
                Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold)
            };

            txtLog = new RichTextBox
            {
                Dock = DockStyle.Fill,
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                BackColor = ColorInputBg,
                ForeColor = ColorText,
                Font = new Font("Consolas", 9.5f)
            };

            wrapper.Controls.Add(txtLog);
            wrapper.Controls.Add(lblLogTitle);
            return wrapper;
        }

        private static void DrawCardBorder(Control c, PaintEventArgs e)
        {
            using var pen = new Pen(ColorBorder);
            e.Graphics.DrawRectangle(pen, 0, 0, c.Width - 1, c.Height - 1);
        }

        // =================================================================
        //  Lógica (sin cambios funcionales respecto a la versión anterior)
        // =================================================================

        private void LoadSettingsIntoUi()
        {
            txtChromePath.Text = string.IsNullOrWhiteSpace(settings.ChromePath)
                ? (ChromeLauncher.FindChromePath() ?? string.Empty)
                : settings.ChromePath;
            txtLaunchpadUrl.Text = settings.LaunchpadUrl;
        }

        private void PersistSettingsFromUi()
        {
            settings.ChromePath = txtChromePath.Text.Trim();
            settings.LaunchpadUrl = txtLaunchpadUrl.Text.Trim();
            settings.Save();
        }

        private void BtnBrowseChrome_Click(object? sender, EventArgs e)
        {
            using var ofd = new OpenFileDialog { Filter = "chrome.exe|chrome.exe|Ejecutables|*.exe" };
            if (ofd.ShowDialog() == DialogResult.OK)
            {
                txtChromePath.Text = ofd.FileName;
                PersistSettingsFromUi();
            }
        }

        private async void BtnConnect_Click(object? sender, EventArgs e)
        {
            PersistSettingsFromUi();
            btnConnect.Enabled = false;

            try
            {
                if (await ChromeLauncher.IsDebugPortAliveAsync(settings.DebugPort))
                {
                    Log("Ya hay una sesión de Chrome con depuración remota activa.");
                }
                else
                {
                    if (string.IsNullOrWhiteSpace(settings.ChromePath) || !File.Exists(settings.ChromePath))
                    {
                        MessageBox.Show(this, "No se encontró chrome.exe. Selecciónalo en 'Configuración de conexión'.",
                            "Ruta de Chrome inválida", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }

                    Log("Abriendo Chrome con depuración remota (sin ventana de comandos)...");
                    var profileDir = Path.Combine(Path.GetTempPath(), "SapFioriAutomation_Profile");
                    ChromeLauncher.LaunchWithDebugPort(settings.ChromePath, settings.DebugPort, profileDir,
                        string.IsNullOrWhiteSpace(settings.LaunchpadUrl) ? null : settings.LaunchpadUrl);

                    bool ready = await ChromeLauncher.WaitForDebugPortAsync(settings.DebugPort, TimeSpan.FromSeconds(20));
                    Log(!ready
                        ? "No se pudo confirmar que Chrome quedó listo para depuración. Verifica manualmente."
                        : "Chrome listo. Inicia sesión en SAP si es necesario y luego presiona Iniciar.");
                }
            }
            finally
            {
                btnConnect.Enabled = true;
                await RefreshConnectionStatusAsync();
            }
        }

        private async Task RefreshConnectionStatusAsync()
        {
            bool alive = await ChromeLauncher.IsDebugPortAliveAsync(settings.DebugPort);
            chromeConnected = alive;
            lblConnStatus.Text = alive ? "●  Chrome conectado" : "●  Chrome desconectado";
            lblConnStatus.ForeColor = alive ? Color.FromArgb(140, 235, 160) : Color.FromArgb(255, 190, 150);
            UpdateStartEnabled();
        }

        private void UpdateStartEnabled()
        {
            btnStart.Enabled = chromeConnected && taskList.Count > 0 && (cts == null);
            btnRetryErrors.Enabled = taskList.Any(t => t.Estado == "Error");
        }

        private void BtnLoad_Click(object? sender, EventArgs e)
        {
            using var ofd = new OpenFileDialog { Filter = "Excel Files|*.xlsx" };
            if (ofd.ShowDialog() == DialogResult.OK)
            {
                Log($"Cargando archivo: {ofd.FileName}");
                try
                {
                    var excelService = new ExcelService();
                    var loaded = excelService.LoadTasksFromExcel(ofd.FileName);
                    taskList = new BindingList<AutomationTask>(loaded);
                    grid.DataSource = taskList;
                    Log($"Se cargaron {taskList.Count} registros exitosamente.");
                }
                catch (Exception ex)
                {
                    Log($"ERROR al leer el Excel: {ex.Message}");
                    MessageBox.Show(this, $"No se pudo leer el archivo:\n{ex.Message}", "Error",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                UpdateStartEnabled();
            }
        }

        private void BtnAgregarPaso_Click(object? sender, EventArgs e)
        {
            var vista = cmbVista.Text.Trim();
            var campo = txtCampoTecnico.Text.Trim();

            if (string.IsNullOrWhiteSpace(vista) || string.IsNullOrWhiteSpace(campo))
            {
                MessageBox.Show(this, "Completa Vista y Campo técnico antes de agregar el paso.", "Faltan datos",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            secuencia.Add(new FieldStep { Vista = vista, CampoTecnico = campo });
            txtCampoTecnico.Clear();
            txtCampoTecnico.Focus();
        }

        private void BtnQuitarPaso_Click(object? sender, EventArgs e)
        {
            if (lstSecuencia.SelectedIndex >= 0)
            {
                secuencia.RemoveAt(lstSecuencia.SelectedIndex);
            }
        }

        private void UpdatePasteLabel()
        {
            lblPaste.Text = secuencia.Count == 0
                ? "Agrega al menos un paso arriba. Luego pega aquí: Material [Tab] Centro [Tab] Valor..."
                : "Pega aquí: Material [Tab] Centro [Tab] " +
                  string.Join(" [Tab] ", secuencia.Select(s => $"Valor({s.CampoTecnico})")) +
                  " — una fila por material (se puede copiar y pegar directo desde Excel):";
        }

        private void BtnGuardarSecuencia_Click(object? sender, EventArgs e)
        {
            if (secuencia.Count == 0)
            {
                MessageBox.Show(this, "No hay ningún paso definido para guardar.", "Secuencia vacía",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            using var sfd = new SaveFileDialog { Filter = "Secuencia SAP (*.json)|*.json", FileName = "secuencia.json" };
            if (sfd.ShowDialog() != DialogResult.OK) return;

            try
            {
                var json = System.Text.Json.JsonSerializer.Serialize(secuencia.ToList(),
                    new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(sfd.FileName, json);
                Log($"Secuencia guardada en: {sfd.FileName}");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, $"No se pudo guardar la secuencia:\n{ex.Message}", "Error",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void BtnCargarSecuencia_Click(object? sender, EventArgs e)
        {
            using var ofd = new OpenFileDialog { Filter = "Secuencia SAP (*.json)|*.json" };
            if (ofd.ShowDialog() != DialogResult.OK) return;

            try
            {
                var json = File.ReadAllText(ofd.FileName);
                var loaded = System.Text.Json.JsonSerializer.Deserialize<System.Collections.Generic.List<FieldStep>>(json);
                if (loaded == null || loaded.Count == 0)
                {
                    MessageBox.Show(this, "El archivo no contiene ningún paso válido.", "Archivo vacío",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                secuencia.Clear();
                foreach (var step in loaded) secuencia.Add(step);
                Log($"Secuencia cargada ({secuencia.Count} paso(s)) desde: {ofd.FileName}");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, $"No se pudo cargar la secuencia:\n{ex.Message}", "Error",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void BtnGenerate_Click(object? sender, EventArgs e)
        {
            if (secuencia.Count == 0)
            {
                MessageBox.Show(this, "Agrega al menos un paso a la secuencia antes de generar tareas.", "Sin pasos",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var transaccion = cmbTransaccion.Text.Trim();
            var pasos = secuencia.ToList();
            var minColumnas = 2 + pasos.Count; // Material + Centro + un Valor por paso

            var lines = txtPasteData.Text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var generated = new System.Collections.Generic.List<AutomationTask>();
            int skippedLines = 0, skippedByOrder = 0;

            foreach (var rawLine in lines)
            {
                var line = rawLine.Trim();
                if (line.Length == 0) continue;

                // Prioriza Tab (pegado directo de Excel); si no hay, intenta ; o ,
                var parts = line.Split('\t');
                if (parts.Length < minColumnas) parts = line.Split(';');
                if (parts.Length < minColumnas) parts = line.Split(',');
                if (parts.Length < minColumnas) { skippedLines++; continue; }

                var material = parts[0].Trim();
                var centro = parts[1].Trim();

                // Omite una posible fila de encabezado pegada por accidente.
                if (material.Equals("Material", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrWhiteSpace(material)) { skippedLines++; continue; }

                // Cada paso de la secuencia se convierte en una tarea propia para
                // este material; SapAutomationService las agrupa por Material
                // contiguo y las llena todas antes de grabar una sola vez.
                var orderIndex = 0;
                foreach (var paso in pasos)
                {
                    var valor = parts[2 + orderIndex].Trim();
                    orderIndex++;
                    if (string.IsNullOrWhiteSpace(valor)) { skippedByOrder++; continue; }

                    generated.Add(new AutomationTask
                    {
                        Material = material,
                        Centro = centro,
                        Transaccion = transaccion,
                        Vista = paso.Vista,
                        CampoTecnico = paso.CampoTecnico,
                        Valor = valor,
                        Orden = generated.Count + 1,
                        Estado = "Pendiente"
                    });
                }
            }

            if (generated.Count == 0)
            {
                MessageBox.Show(this,
                    $"No se generó ninguna tarea. Verifica que cada línea tenga Material, Centro y {pasos.Count} valor(es) (uno por paso definido), separados por Tab.",
                    "Sin datos", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            taskList = new BindingList<AutomationTask>(generated);
            grid.DataSource = taskList;
            var aviso = (skippedLines > 0 ? $" ({skippedLines} línea(s) omitida(s) por formato inválido)" : "") +
                        (skippedByOrder > 0 ? $" ({skippedByOrder} valor(es) vacío(s) omitido(s))" : "");
            Log($"Se generaron {generated.Count} tarea(s) desde {pasos.Count} paso(s) de secuencia{aviso}.");
            UpdateStartEnabled();
        }

        private async void BtnStart_Click(object? sender, EventArgs e)
        {
            if (taskList.Count == 0) return;

            if (!await ChromeLauncher.IsDebugPortAliveAsync(settings.DebugPort))
            {
                MessageBox.Show(this, "No hay una sesión de Chrome conectada. Usa 'Conectar a SAP' primero.",
                    "Sin conexión", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            btnStart.Enabled = false;
            btnStop.Enabled = true;
            btnLoad.Enabled = false;
            btnConnect.Enabled = false;
            btnRetryErrors.Enabled = false;
            cts = new CancellationTokenSource();

            var progress = new Progress<string>(Log);
            var sapService = new SapAutomationService();
            var summaryTimer = new System.Windows.Forms.Timer { Interval = 700 };
            summaryTimer.Tick += (_, _) => UpdateSummary();
            summaryTimer.Start();

            try
            {
                await Task.Run(() => sapService.ProcessTasksAsync(
                    new System.Collections.Generic.List<AutomationTask>(taskList), progress, cts.Token, chkStopOnError.Checked));
            }
            catch (OperationCanceledException)
            {
                Log("⚠️ Operación cancelada por el usuario.");
            }
            catch (Exception ex)
            {
                Log($"ERROR CRÍTICO: {ex.Message}");
            }
            finally
            {
                summaryTimer.Stop();
                UpdateSummary();
                cts = null;
                btnLoad.Enabled = true;
                btnConnect.Enabled = true;
                btnStop.Enabled = false;
                UpdateStartEnabled();
            }
        }

        private void BtnRetryErrors_Click(object? sender, EventArgs e)
        {
            var errores = taskList.Where(t => t.Estado == "Error").ToList();
            if (errores.Count == 0)
            {
                MessageBox.Show(this, "No hay tareas en estado Error para reintentar.", "Nada que reintentar",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            foreach (var task in errores)
            {
                task.Estado = "Pendiente";
                task.Mensaje = string.Empty;
            }

            Log($"{errores.Count} tarea(s) marcada(s) para reintentar (vuelven a Pendiente).");
            UpdateStartEnabled();
        }

        private void BtnStop_Click(object? sender, EventArgs e)
        {
            cts?.Cancel();
            Log("Deteniendo proceso... Esperando que termine el material actual.");
        }

        private void UpdateSummary()
        {
            if (lblSummary.InvokeRequired)
            {
                lblSummary.Invoke(new Action(UpdateSummary));
                return;
            }
            int ok = 0, err = 0, pend = 0;
            foreach (var t in taskList)
            {
                if (t.Estado == "Procesado") ok++;
                else if (t.Estado == "Error") err++;
                else pend++;
            }
            lblSummary.Text = $"✓ {ok}   ✗ {err}   … {pend}   Total {taskList.Count}";
            lblSummary.ForeColor = err > 0 ? ColorErrorFg : ColorTextMuted;
        }

        private void Grid_CellFormatting(object? sender, DataGridViewCellFormattingEventArgs e)
        {
            if (grid.Rows.Count <= e.RowIndex || e.RowIndex < 0) return;
            if (grid.Rows[e.RowIndex].DataBoundItem is not AutomationTask task) return;

            switch (task.Estado)
            {
                case "Procesado":
                    grid.Rows[e.RowIndex].DefaultCellStyle.BackColor = ColorSuccessBg;
                    grid.Rows[e.RowIndex].DefaultCellStyle.ForeColor = ColorSuccessFg;
                    break;
                case "Error":
                    grid.Rows[e.RowIndex].DefaultCellStyle.BackColor = ColorErrorBg;
                    grid.Rows[e.RowIndex].DefaultCellStyle.ForeColor = ColorErrorFg;
                    break;
                default:
                    grid.Rows[e.RowIndex].DefaultCellStyle.BackColor = ColorCard;
                    grid.Rows[e.RowIndex].DefaultCellStyle.ForeColor = ColorText;
                    break;
            }
        }

        private void Log(string message)
        {
            if (txtLog.InvokeRequired)
            {
                txtLog.Invoke(new Action(() => Log(message)));
                return;
            }
            txtLog.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}\n");
            txtLog.ScrollToCaret();
        }
    }
}
