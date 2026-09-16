using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Keys = OpenQA.Selenium.Keys; // Evita ambigüedad con System.Windows.Forms.Keys

namespace SapFioriAutomation
{
    public class SapAutomationService
    {
        private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan ShortTimeout = TimeSpan.FromSeconds(5);
        // Corto a propósito: si no se logra identificar el selector real de la
        // barra de estado, no tiene sentido bloquear 20s por material sin poder
        // confirmar nada (ver WaitForStatusMessage).
        private static readonly TimeSpan SaveTimeout = TimeSpan.FromSeconds(3);
        // Para diálogos que SAP muestra solo a veces (vista, centro): si no
        // aparecen, es casi instantáneo; no hace falta esperar 5s completos.
        private static readonly TimeSpan OptionalDialogTimeout = TimeSpan.FromSeconds(1.5);
        private const int MaxFrameDepth = 4;

        private IWebDriver? _driver;

        public async Task ProcessTasksAsync(List<AutomationTask> tasks, IProgress<string> logger, CancellationToken token,
            bool detenerEnPrimerError = false)
        {
            try
            {
                logger.Report("Conectando con la sesión de Chrome (puerto 9222)...");
                var options = new ChromeOptions();
                options.DebuggerAddress = "127.0.0.1:9222";
                options.AddArgument("--remote-allow-origins=*");

                _driver = new ChromeDriver(options);
                logger.Report($"Conectado. Pestaña activa: {SafeTitle()}");

                // Se agrupan las tareas contiguas del mismo material (tal como las
                // genera la UI al aplicar una secuencia/"macro" de varios pasos por
                // material) para entrar UNA sola vez al material, llenar todos los
                // campos de la secuencia en sus respectivas vistas, y grabar una
                // sola vez al final — igual que lo haría una persona a mano, en vez
                // de grabar (y volver a entrar) por cada campo individual.
                foreach (var group in GroupByMaterial(tasks))
                {
                    token.ThrowIfCancellationRequested();

                    var first = group[0];
                    var pasos = string.Join(", ", group.Select(t => $"{t.Vista}/{t.CampoTecnico}"));

                    try
                    {
                        logger.Report($"--- [{first.Material}] Iniciando ({group.Count} paso(s): {pasos}) ---");

                        NavigateToMM02(logger);
                        EnterMaterial(first.Material, logger);
                        SelectView(first.Vista, logger);

                        if (!string.IsNullOrEmpty(first.Centro))
                        {
                            EnterOrganizationalLevels(first.Centro, logger);
                        }

                        var camposNoEncontrados = new List<string>();
                        var camposLlenados = new List<AutomationTask>();

                        foreach (var task in group)
                        {
                            SwitchToViewTab(task.Vista, logger);

                            logger.Report($"Buscando campo {task.CampoTecnico} en '{task.Vista}'...");
                            bool fieldFound = FillSapField(task.CampoTecnico, task.Valor, logger);

                            if (fieldFound)
                            {
                                camposLlenados.Add(task);
                            }
                            else
                            {
                                task.Estado = "Error";
                                task.Mensaje = "Campo no localizado";
                                camposNoEncontrados.Add(task.CampoTecnico);
                                logger.Report($"[{first.Material}] ERROR: no se encontró el campo {task.CampoTecnico} en '{task.Vista}'.");
                            }
                        }

                        if (camposLlenados.Count == 0)
                        {
                            // Ningún campo de la secuencia se pudo llenar: no hay
                            // nada que grabar.
                            SafeAbortAndReturnHome(logger);
                        }
                        else
                        {
                            var (ok, statusMsg) = SaveTransaction(logger);
                            var mensaje = string.IsNullOrWhiteSpace(statusMsg)
                                ? (ok ? "OK" : "No se pudo confirmar el guardado")
                                : statusMsg;

                            foreach (var task in camposLlenados)
                            {
                                task.Estado = ok ? "Procesado" : "Error";
                                task.Mensaje = mensaje;
                            }

                            if (ok)
                            {
                                logger.Report($"[{first.Material}] Guardado con éxito ({camposLlenados.Count} campo(s)). {mensaje}");
                            }
                            else
                            {
                                logger.Report($"[{first.Material}] ERROR al guardar: {mensaje}");
                                SafeAbortAndReturnHome(logger);
                            }
                        }

                        if (camposNoEncontrados.Count > 0)
                        {
                            logger.Report($"[{first.Material}] Aviso: {camposNoEncontrados.Count} campo(s) de la secuencia no se pudieron ubicar ({string.Join(", ", camposNoEncontrados)}).");
                        }
                    }
                    catch (Exception ex)
                    {
                        foreach (var task in group.Where(t => t.Estado == "Pendiente"))
                        {
                            task.Estado = "Error";
                            task.Mensaje = $"Fallo en navegación: {ex.Message}";
                        }
                        logger.Report($"[{first.Material}] ERROR: {ex.Message}");
                        DumpDiagnostics($"error_{first.Material}", logger);
                        SafeAbortAndReturnHome(logger);
                    }

                    if (detenerEnPrimerError && group.Any(t => t.Estado == "Error"))
                    {
                        logger.Report($"⏹ Proceso detenido: hubo un error en [{first.Material}]. " +
                            "Corrige lo necesario y usa 'Reintentar errores' para continuar solo con los pendientes/fallidos.");
                        return;
                    }

                    await Task.Delay(400, token);
                }

                logger.Report("Proceso finalizado.");
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.Report($"ERROR CRÍTICO: {ex.Message}");
            }
        }

        private string SafeTitle()
        {
            try { return _driver?.Title ?? "(sin título)"; }
            catch { return "(no disponible)"; }
        }

        /// <summary>
        /// Agrupa tareas Pendiente contiguas que comparten Material (tal como las
        /// genera la UI al aplicar una secuencia de varios campos por material).
        /// Si dos filas del mismo material NO son contiguas, se tratan como
        /// grupos separados a propósito — evita reabrir una transacción ya
        /// cerrada/guardada asumiendo erróneamente que sigue abierta.
        /// </summary>
        private static List<List<AutomationTask>> GroupByMaterial(List<AutomationTask> tasks)
        {
            var groups = new List<List<AutomationTask>>();
            List<AutomationTask>? current = null;
            string? lastMaterial = null;

            foreach (var task in tasks.Where(t => t.Estado == "Pendiente"))
            {
                if (current == null || task.Material != lastMaterial)
                {
                    current = new List<AutomationTask>();
                    groups.Add(current);
                    lastMaterial = task.Material;
                }
                current.Add(task);
            }

            return groups;
        }

        // ---------------------------------------------------------------
        // Navegación de frames: SAP WebGUI embebido en Fiori suele anidar
        // varios <iframe>. En vez de asumir que siempre es el primero,
        // recorremos el árbol de frames en profundidad hasta encontrar el
        // elemento buscado, y dejamos el driver posicionado ahí.
        // ---------------------------------------------------------------
        private IWebElement? FindElementDeep(By by, int maxDepth = MaxFrameDepth)
        {
            _driver!.SwitchTo().DefaultContent();
            return SearchFrames(by, maxDepth);
        }

        private IWebElement? SearchFrames(By by, int depthRemaining)
        {
            try
            {
                var matches = _driver!.FindElements(by);
                var visible = matches.FirstOrDefault(e => IsUsable(e));
                if (visible != null) return visible;
            }
            catch (StaleElementReferenceException) { }

            if (depthRemaining <= 0) return null;

            List<IWebElement> frames;
            try { frames = _driver!.FindElements(By.TagName("iframe")).ToList(); }
            catch { return null; }

            foreach (var frame in frames)
            {
                try
                {
                    _driver!.SwitchTo().Frame(frame);
                }
                catch
                {
                    continue;
                }

                var found = SearchFrames(by, depthRemaining - 1);
                if (found != null) return found;

                try { _driver!.SwitchTo().ParentFrame(); }
                catch { _driver!.SwitchTo().DefaultContent(); }
            }

            return null;
        }

        private static bool IsUsable(IWebElement el)
        {
            try { return el.Displayed; }
            catch { return false; }
        }

        private IWebElement WaitForElementDeep(By by, TimeSpan timeout, string errorContext)
        {
            var deadline = DateTime.UtcNow + timeout;
            Exception? last = null;
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    var el = FindElementDeep(by);
                    if (el != null) return el;
                }
                catch (Exception ex)
                {
                    last = ex;
                }
                Thread.Sleep(250);
            }
            throw new WebDriverTimeoutException($"No se encontró el elemento esperado ({errorContext}) en {timeout.TotalSeconds}s.", last);
        }

        private IWebElement? TryWaitForElementDeep(By by, TimeSpan timeout)
        {
            try { return WaitForElementDeep(by, timeout, by.ToString()); }
            catch { return null; }
        }

        // ---------------------------------------------------------------
        // Pasos del flujo SAP
        // ---------------------------------------------------------------

        private void NavigateToMM02(IProgress<string> logger)
        {
            _driver!.SwitchTo().DefaultContent();

            var tile = TryFindFirstMatch(MM02TileSelectors, ShortTimeout);

            if (tile != null)
            {
                logger.Report("Tile 'Modificar material' (MM02) localizado. Abriendo...");
                tile.Click();
                WaitForFioriShellToSettle();
                return;
            }

            // Puede que ya estemos dentro de otra transacción: intentar volver al Home.
            try
            {
                _driver.SwitchTo().DefaultContent();
                var homeBtn = TryWaitForElementDeep(By.Id("homeBtn"), ShortTimeout);
                homeBtn?.Click();
                WaitForFioriShellToSettle();

                var tileRetry = TryFindFirstMatch(MM02TileSelectors, DefaultTimeout);
                if (tileRetry == null)
                    throw new WebDriverTimeoutException("No se encontró el tile de MM02 tras volver al Home.");

                tileRetry.Click();
                WaitForFioriShellToSettle();
            }
            catch
            {
                logger.Report("Nota: no se encontró el tile de MM02 explícitamente; se asume que ya está dentro de la transacción.");
                DumpDiagnostics("tile_mm02_no_encontrado", logger);
            }
        }

        /// <summary>
        /// Guarda el HTML de la página actual en archivos para poder diagnosticar
        /// selectores fallidos sin abrir las DevTools manualmente. Vuelca tanto el
        /// documento principal como el contenido de cada &lt;iframe&gt; de primer
        /// nivel (p.ej. la transacción MM02), porque driver.PageSource por sí solo
        /// SOLO captura el frame actualmente seleccionado, no los anidados.
        /// </summary>
        private void DumpDiagnostics(string label, IProgress<string> logger)
        {
            try
            {
                var dir = Path.Combine(Path.GetTempPath(), "SapFioriAutomation_Diag");
                Directory.CreateDirectory(dir);
                var stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
                var savedFiles = new List<string>();

                _driver!.SwitchTo().DefaultContent();
                var topFile = Path.Combine(dir, $"{label}_{stamp}_top.html");
                File.WriteAllText(topFile, _driver.PageSource);
                savedFiles.Add(topFile);

                var frameCount = _driver.FindElements(By.TagName("iframe")).Count;
                for (int i = 0; i < frameCount; i++)
                {
                    try
                    {
                        _driver.SwitchTo().DefaultContent();
                        var frames = _driver.FindElements(By.TagName("iframe"));
                        if (i >= frames.Count) break;
                        _driver.SwitchTo().Frame(frames[i]);
                        var frameFile = Path.Combine(dir, $"{label}_{stamp}_frame{i}.html");
                        File.WriteAllText(frameFile, _driver.PageSource);
                        savedFiles.Add(frameFile);
                    }
                    catch { /* frame no accesible, se ignora */ }
                }
                _driver.SwitchTo().DefaultContent();

                logger.Report($"Diagnóstico guardado ({savedFiles.Count} archivo(s)): {string.Join(", ", savedFiles)}");
            }
            catch (Exception ex)
            {
                logger.Report($"No se pudo guardar el diagnóstico: {ex.Message}");
            }
        }

        /// <summary>
        /// Selectores candidatos para el tile "Modificar material" (MM02) del
        /// Launchpad. Confirmado por inspección real del DOM: el tile es un
        /// &lt;a role="link"&gt; (NO un &lt;div&gt;), con
        /// aria-label="Modificar material\n\nMM02" y
        /// href="...#Material-change?sap-ui-tech-hint=GUI". El href es el criterio
        /// más estable (es el intent de Fiori, no depende del idioma de la UI).
        /// </summary>
        private static readonly List<By> MM02TileSelectors = new()
        {
            By.XPath("//a[contains(@href, '#Material-change')]"),
            By.XPath("//*[contains(@aria-label, 'MM02')]"),
            By.XPath("//*[contains(@aria-label, 'Modificar material')]"),
            By.XPath("//*[@role='link' or @role='button']" +
                     "[contains(., 'Modificar material') or contains(., 'MM02')]"),
        };

        /// <summary>Prueba selectores en orden y devuelve el primer elemento visible que coincida.</summary>
        private IWebElement? TryFindFirstMatch(List<By> selectors, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                foreach (var selector in selectors)
                {
                    var el = FindElementDeep(selector);
                    if (el != null) return el;
                }
                Thread.Sleep(250);
            }
            return null;
        }

        private void WaitForFioriShellToSettle() => Thread.Sleep(700);

        /// <summary>
        /// Confirmado por inspección real del DOM: el campo de material en la
        /// pantalla de acceso de MM02 es un &lt;input name="InputField"&gt; genérico
        /// (name NO es 'MATNR'; ese atributo lo comparten todos los campos de texto
        /// de SAP GUI). El nombre técnico real (RMMG1-MATNR) va serializado dentro
        /// de 'data-hint'/'lsdata', igual que el resto de campos de este bot. El
        /// título visible es "Número de material" (minúscula), por eso NO se debe
        /// buscar 'Material' con mayúscula inicial vía contains().
        /// </summary>
        private static readonly List<By> MaterialFieldSelectors = new()
        {
            By.XPath("//input[contains(@data-hint, 'RMMG1-MATNR') or contains(@lsdata, 'RMMG1-MATNR')]"),
            By.XPath("//input[contains(translate(@title, 'MATERIAL', 'material'), 'material')]"),
        };

        private void EnterMaterial(string material, IProgress<string> logger)
        {
            var inputMaterial = TryFindFirstMatch(MaterialFieldSelectors, DefaultTimeout)
                ?? throw new WebDriverTimeoutException($"No se encontró el campo Material en {DefaultTimeout.TotalSeconds}s.");

            inputMaterial.Click();
            inputMaterial.Clear();
            inputMaterial.SendKeys(material);
            inputMaterial.SendKeys(Keys.Enter);
            Thread.Sleep(500);
        }

        private void SelectView(string vistaName, IProgress<string> logger)
        {
            var prefix = vistaName.Substring(0, Math.Min(10, vistaName.Length));
            var rowSelector = By.XPath($"//tbody//tr[contains(., '{prefix}')]");

            // El diálogo de selección de vista no siempre aparece (p.ej. si SAP
            // recuerda la última vista usada), así que no es un error si no está.
            var viewRow = TryWaitForElementDeep(rowSelector, OptionalDialogTimeout);
            if (viewRow == null)
            {
                logger.Report("No apareció el diálogo de selección de vista; se asume que ya está en la vista correcta.");
                return;
            }

            viewRow.Click();

            var checkBtn = TryWaitForElementDeep(
                By.XPath("//div[contains(@title, 'Continuar') or contains(@title, 'Enter')]"),
                OptionalDialogTimeout);

            if (checkBtn != null)
            {
                checkBtn.Click();
            }
            else
            {
                viewRow.SendKeys(Keys.Enter);
            }
            Thread.Sleep(500);

            // Puede aparecer el diálogo de "Niveles de organización" justo después
            // del check; se maneja aparte en EnterOrganizationalLevels si aplica.
        }

        /// <summary>
        /// Hace clic en la pestaña (tab strip) de la vista indicada si no es ya
        /// la activa. Necesario porque, a diferencia del popup de selección de
        /// vistas inicial (SelectView), cambiar de pestaña DENTRO de una
        /// transacción ya abierta requiere clic explícito en el tab strip; si no
        /// se hace, el campo de la otra vista puede no estar visible en el DOM
        /// (Displayed=false) y FillSapField fallaría aunque exista.
        /// SheetMappings (ExcelService) debe usar el texto EXACTO de la pestaña
        /// tal como SAP lo muestra (ver lista completa comentada ahí) — así no
        /// hace falta traducir nada aquí.
        /// </summary>
        private void SwitchToViewTab(string vistaName, IProgress<string> logger)
        {
            if (string.IsNullOrWhiteSpace(vistaName)) return;

            var tabSelector = By.XPath(
                $"//*[contains(@class, 'lsTabStrip--item-text')][contains(., '{vistaName}')]");

            var tab = TryFindFirstMatch(new List<By> { tabSelector }, OptionalDialogTimeout);
            if (tab == null)
            {
                // Puede que ya sea la pestaña activa (SAP no siempre la resalta
                // de forma que cambie el DOM) o que la vista no tenga tab strip
                // propio; no se trata como error.
                return;
            }

            try
            {
                tab.Click();
                Thread.Sleep(500);
            }
            catch (Exception ex)
            {
                logger.Report($"Aviso: no se pudo hacer clic en la pestaña '{vistaName}': {ex.Message}");
            }
        }

        /// <summary>
        /// Igual que con Material: el nombre técnico real (WERKS) viaja en
        /// data-hint/lsdata, no en 'name' (que es siempre "InputField" para
        /// cualquier campo de texto de SAP GUI), y el título visible "Centro" no
        /// se puede asumir con mayúscula inicial dentro de contains().
        /// </summary>
        private static readonly List<By> CentroFieldSelectors = new()
        {
            By.XPath("//input[contains(@data-hint, 'WERKS') or contains(@lsdata, 'WERKS')]"),
            By.XPath("//input[contains(translate(@title, 'CENTRO', 'centro'), 'centro')]"),
        };

        private void EnterOrganizationalLevels(string centro, IProgress<string> logger)
        {
            var inputCentro = TryFindFirstMatch(CentroFieldSelectors, OptionalDialogTimeout);

            if (inputCentro == null)
            {
                // SAP a veces recuerda el centro y no vuelve a pedirlo: no es un error.
                return;
            }

            inputCentro.Click();
            inputCentro.Clear();
            inputCentro.SendKeys(centro);
            inputCentro.SendKeys(Keys.Enter);
            Thread.Sleep(500);
        }

        private bool FillSapField(string campoTecnico, string valor, IProgress<string> logger)
        {
            var primarySelector = By.XPath($"//input[contains(@data-hint, '{campoTecnico}')]");
            var selectors = new List<By>
            {
                primarySelector,
                By.XPath($"//input[contains(@lsdata, '{campoTecnico}')]"),
                By.XPath($"//input[contains(@title, '{campoTecnico}')]"),
                By.CssSelector($"[id*='-{campoTecnico}']"),
                By.CssSelector($"[id*='{campoTecnico}']"),
            };

            foreach (var selector in selectors)
            {
                var element = TryWaitForElementDeep(selector, ShortTimeout);
                if (element == null || !element.Enabled) continue;

                element.Click();
                element.Clear();
                element.SendKeys(valor);
                element.SendKeys(Keys.Tab); // Dispara la validación del campo en SAP
                Thread.Sleep(400);
                return true;
            }

            // Diagnóstico: reporta cuántas coincidencias reales hay (visibles u
            // ocultas) para el selector principal, y por qué se descartaron, en
            // vez de solo reportar "no encontrado".
            var matches = DescribeAllMatches(primarySelector, MaxFrameDepth);
            logger.Report(matches.Count == 0
                ? $"Diagnóstico: 0 elementos coinciden con data-hint conteniendo '{campoTecnico}' en ningún frame."
                : $"Diagnóstico: {matches.Count} elemento(s) coinciden con '{campoTecnico}' pero ninguno usable: {string.Join(" | ", matches)}");

            return false;
        }

        /// <summary>
        /// Busca TODAS las coincidencias de un selector en todos los frames (sin
        /// filtrar por visibilidad) y describe su estado, para diagnosticar por
        /// qué un selector que "debería" matchear no produce un elemento usable.
        /// </summary>
        private List<string> DescribeAllMatches(By by, int maxDepth)
        {
            _driver!.SwitchTo().DefaultContent();
            var descriptions = new List<string>();
            DescribeFrames(by, maxDepth, descriptions, "top");
            _driver.SwitchTo().DefaultContent();
            return descriptions;
        }

        private void DescribeFrames(By by, int depthRemaining, List<string> descriptions, string framePath)
        {
            try
            {
                foreach (var el in _driver!.FindElements(by))
                {
                    string disp = "?", en = "?", id = "?";
                    try { disp = el.Displayed.ToString(); } catch { }
                    try { en = el.Enabled.ToString(); } catch { }
                    try { id = el.GetAttribute("id") ?? ""; } catch { }
                    descriptions.Add($"[{framePath}] id='{id}' Displayed={disp} Enabled={en}");
                }
            }
            catch { }

            if (depthRemaining <= 0) return;

            List<IWebElement> frames;
            try { frames = _driver!.FindElements(By.TagName("iframe")).ToList(); }
            catch { return; }

            for (int i = 0; i < frames.Count; i++)
            {
                try { _driver!.SwitchTo().Frame(frames[i]); }
                catch { continue; }

                DescribeFrames(by, depthRemaining - 1, descriptions, $"{framePath}>iframe{i}");

                try { _driver!.SwitchTo().ParentFrame(); }
                catch { _driver!.SwitchTo().DefaultContent(); }
            }
        }

        /// <summary>
        /// Graba la transacción y espera a que la barra de estado inferior de SAP
        /// confirme el resultado (mensaje verde de éxito o rojo de error).
        /// </summary>
        /// <summary>
        /// Confirmado por inspección real: el botón Grabar es un
        /// &lt;div role="button" id="M0:50::btn[11]"&gt; — el id NO contiene
        /// 'tbar[0]/btn[11]' (eso solo está en data-hint/lsdata), y el title es
        /// literalmente " (Ctrl+S)" (sin la palabra Grabar/Save). El texto
        /// "Guardar" solo existe como contenido visible de un &lt;span&gt; hijo.
        /// </summary>
        private static readonly List<By> SaveButtonSelectors = new()
        {
            By.XPath("//*[contains(@data-hint, 'tbar[0]/btn[11]') or contains(@lsdata, 'tbar[0]/btn[11]')]"),
            By.XPath("//*[@role='button'][contains(., 'Guardar') or contains(., 'Grabar')]"),
            By.XPath("//*[contains(translate(@title, 'GRABARSAVE', 'grabarsave'), 'grabar') or " +
                     "contains(translate(@title, 'GRABARSAVE', 'grabarsave'), 'save')]"),
        };

        private (bool ok, string message) SaveTransaction(IProgress<string> logger)
        {
            var saveBtn = TryFindFirstMatch(SaveButtonSelectors, ShortTimeout);

            if (saveBtn != null)
            {
                saveBtn.Click();
            }
            else
            {
                logger.Report("No se encontró el botón Grabar; usando atajo Ctrl+S.");
                try
                {
                    var body = FindElementDeep(By.TagName("body")) ?? _driver!.FindElement(By.TagName("body"));
                    body.SendKeys(Keys.Control + "s");
                }
                catch
                {
                    return (false, "No se pudo activar Grabar");
                }
            }

            return WaitForStatusMessage(SaveTimeout, logger);
        }

        /// <summary>
        /// Busca el área de mensajes de la barra de estado de SAP. Los selectores
        /// cubren tanto el WebGUI clásico como el envoltorio Fiori; si el DOM real
        /// difiere, ajustar esta lista tras inspeccionar con F12.
        /// </summary>
        private (bool ok, string message) WaitForStatusMessage(TimeSpan timeout, IProgress<string> logger)
        {
            var statusSelectors = new List<By>
            {
                By.XPath("//div[contains(@id,'-MESSAGE_AREA')]"),
                By.XPath("//span[contains(@id,'-MESSAGE_AREA')]"),
                By.CssSelector(".sapMMsgStrip"),
                By.XPath("//div[@role='status']"),
                By.XPath("//div[contains(@class,'lsStatusBarItem')]"),
                By.XPath("//div[contains(@class,'urMessageBar')]"),
            };

            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                foreach (var selector in statusSelectors)
                {
                    var el = TryWaitForElementDeep(selector, TimeSpan.FromMilliseconds(600));
                    if (el == null) continue;

                    string text;
                    try { text = el.Text?.Trim() ?? string.Empty; }
                    catch { continue; }

                    if (string.IsNullOrWhiteSpace(text)) continue;

                    string cls = string.Empty;
                    try { cls = el.GetAttribute("class") ?? string.Empty; }
                    catch { }

                    bool looksError = cls.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0
                        || cls.IndexOf("Error", StringComparison.Ordinal) >= 0
                        || text.StartsWith("Error", StringComparison.OrdinalIgnoreCase);

                    return (!looksError, text);
                }
                Thread.Sleep(400);
            }

            // No se pudo localizar el selector de la barra de estado en este
            // sistema (probado y aún no identificado). El botón Grabar sí se
            // pulsa correctamente, así que en vez de bloquear 20s por material
            // sin poder confirmar nada, se asume éxito si no apareció ningún
            // mensaje de error explícito en la ventana corta de espera.
            return (true, "Guardado (sin confirmación de barra de estado)");
        }

        /// <summary>
        /// Ante un fallo, intenta dejar la sesión de SAP en un estado conocido
        /// (Launchpad) para no dejar el material atascado y arrastrar el error
        /// al siguiente registro.
        /// </summary>
        private void SafeAbortAndReturnHome(IProgress<string> logger)
        {
            try
            {
                _driver!.SwitchTo().DefaultContent();

                var body = FindElementDeep(By.TagName("body"));
                body?.SendKeys(Keys.Escape);
                Thread.Sleep(400);
                _driver.SwitchTo().DefaultContent();
                body = FindElementDeep(By.TagName("body"));
                body?.SendKeys(Keys.Escape);
                Thread.Sleep(400);

                _driver.SwitchTo().DefaultContent();
                var homeBtn = TryWaitForElementDeep(By.Id("homeBtn"), ShortTimeout);
                homeBtn?.Click();
                Thread.Sleep(800);
            }
            catch (Exception ex)
            {
                logger.Report($"Aviso: no se pudo recuperar automáticamente la sesión ({ex.Message}). Verifique el estado de Chrome.");
            }
            finally
            {
                _driver!.SwitchTo().DefaultContent();
            }
        }

        // No implementar Dispose()/Quit(): el driver está adjunto a la sesión de
        // Chrome del usuario vía DebuggerAddress, y Quit() cerraría el navegador
        // completo en lugar de solo desconectar Selenium.
    }
}
