// Orquestación de la automatización. Vive en el side panel (página normal,
// no service worker) para no tener el límite de 30s de inactividad de MV3:
// mientras el panel esté abierto, este script puede usar setTimeout/await
// libremente durante todo el proceso, igual que ProcessTasksAsync en el
// SapAutomationService.cs original.

const DEFAULT_TIMEOUT = 15000;
const SAVE_TIMEOUT = 3000;
const OPTIONAL_DIALOG_TIMEOUT = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Vistas válidas de MM02 (lista confirmada, ver comentario original en
// ExcelService.cs). Se usan como opciones del desplegable "Vista" global de
// la carga; si se pega/carga un texto que no calza exactamente, se agrega
// como opción "personalizada" para no perder el dato.
const SAP_VIEWS = [
  "Datos básicos 1",
  "Datos básicos 2",
  "Clasificación",
  "Ventas: Datos org.ventas 1",
  "Ventas: Datos org.ventas 2",
  "Ventas: Datos centro/gral.",
  "Datos básicos SPP ampliados",
  "Comercio exterior: Exportación",
  "Texto comercial",
  "Compras",
  "Comercio exterior: Importación",
  "Texto de pedido de compras",
  "Planif.necesidades 1",
  "Planif.necesidades 2",
  "Planif.necesidades 3",
  "Planif.necesidades 4",
  "Planificación avanzada",
  "SPP ampliado",
  "Preparación de trabajo",
  "Dat.gral.ce./Almacenamiento 1",
  "Dat.gral.ce./Almacenamiento 2",
  "Gestión de calidad",
  "Contabilidad 1",
  "Contabilidad 2",
  "Cálculo coste 1",
  "Cálculo del coste 2",
  "Stock de centro",
  "Stock almacén",
  "Ejecución WM",
  "WM Packaging",
  "Datos de valoración segmento",
];

const SAP_HOST = "fiori.medifarma.com.pe";
const DEFAULT_SAP_URL =
  "https://fiori.medifarma.com.pe/sap/bc/ui2/flp?sap-client=300&sap-language=ES#Material-change?sap-ui-tech-hint=GUI";

// ---------------------------------------------------------------
// Comunicación con los content scripts (broadcast a todos los frames de la
// pestaña, en vez del recorrido recursivo de iframes que hacía Selenium).
// ---------------------------------------------------------------

async function getFrameIds(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames.map((f) => f.frameId);
  } catch {
    return [0];
  }
}

async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    return null; // el frame no tiene content script (cross-origin, no cargó, etc.)
  }
}

async function broadcastOnce(tabId, message) {
  const frameIds = await getFrameIds(tabId);
  const results = await Promise.all(frameIds.map((fid) => sendToFrame(tabId, fid, message)));
  const hit = results.find((r) => r && r.ok);
  if (hit) return hit;
  const diagnostics = results.filter((r) => r && r.diagnostics).flatMap((r) => r.diagnostics);
  return { ok: false, diagnostics };
}

async function waitFor(tabId, message, timeoutMs, stepMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false };
  do {
    last = await broadcastOnce(tabId, message);
    if (last.ok) return last;
    await sleep(stepMs);
  } while (Date.now() < deadline);
  return last;
}

// ---------------------------------------------------------------
// Pasos del flujo SAP (equivalentes a los métodos privados de
// SapAutomationService.cs)
// ---------------------------------------------------------------

async function navigateToMM02(tabId, log) {
  let res = await waitFor(tabId, { type: "CLICK_TILE" }, 5000);
  if (res.ok) {
    log("Tile 'Modificar material' (MM02) localizado. Abriendo...");
    await sleep(700);
    return;
  }
  await broadcastOnce(tabId, { type: "CLICK_HOME" });
  await sleep(700);
  res = await waitFor(tabId, { type: "CLICK_TILE" }, DEFAULT_TIMEOUT);
  if (!res.ok) {
    log("Nota: no se encontró el tile de MM02 explícitamente; se asume que ya está dentro de la transacción.");
    return;
  }
  await sleep(700);
}

async function enterMaterial(tabId, material) {
  const res = await waitFor(tabId, { type: "ENTER_MATERIAL", material }, DEFAULT_TIMEOUT);
  if (!res.ok) throw new Error(`No se encontró el campo Material en ${DEFAULT_TIMEOUT / 1000}s.`);
  await sleep(500);
}

async function selectView(tabId, vista, log) {
  const prefix = vista.substring(0, Math.min(10, vista.length));
  const res = await waitFor(tabId, { type: "SELECT_VIEW", prefix }, OPTIONAL_DIALOG_TIMEOUT);
  if (!res.ok) {
    log("No apareció el diálogo de selección de vista; se asume que ya está en la vista correcta.");
    return;
  }
  await sleep(500);
}

async function enterOrganizationalLevels(tabId, centro) {
  if (!centro) return;
  const res = await waitFor(tabId, { type: "ENTER_CENTRO", centro }, OPTIONAL_DIALOG_TIMEOUT);
  if (res.ok) await sleep(500);
}

async function switchToViewTab(tabId, vista) {
  if (!vista) return;
  const res = await waitFor(tabId, { type: "SWITCH_TAB", vista }, OPTIONAL_DIALOG_TIMEOUT);
  if (res.ok) await sleep(500);
}

async function fillSapField(tabId, campoTecnico, valor, log) {
  // content.js resuelve todo en un solo mensaje: campos normales al toque,
  // y para tabla de características (vista "Clasificación") hace su propio
  // scroll a ciegas hasta encontrar la fila antes de responder — por eso
  // cada intento puede tardar unos segundos, y se usa el timeout largo
  // (igual que localizar el campo Material).
  const res = await waitFor(tabId, { type: "FILL_FIELD", campoTecnico, valor }, DEFAULT_TIMEOUT);
  if (res.ok) {
    await sleep(400);
    return true;
  }
  if (res.diagnostics && res.diagnostics.length) {
    log(`Diagnóstico: ${res.diagnostics.length} elemento(s) coinciden con '${campoTecnico}' pero ninguno usable: ${res.diagnostics.join(" | ")}`);
  } else {
    log(`Diagnóstico: 0 elementos coinciden con data-hint conteniendo '${campoTecnico}' en ningún frame.`);
  }
  return false;
}

async function waitForStatusMessage(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const res = await broadcastOnce(tabId, { type: "READ_STATUS" });
    if (res.ok && res.text) return { ok: !res.isError, message: res.text };
    await sleep(400);
  } while (Date.now() < deadline);
  return { ok: true, message: "Exitoso" };
}

async function saveTransaction(tabId, log) {
  let res = await broadcastOnce(tabId, { type: "SAVE" });
  if (!res.ok) {
    log("No se encontró el botón Grabar; usando atajo Ctrl+S.");
    res = await broadcastOnce(tabId, { type: "SAVE_SHORTCUT" });
    if (!res.ok) return { ok: false, message: "No se pudo activar Grabar" };
  }
  return await waitForStatusMessage(tabId, SAVE_TIMEOUT);
}

/**
 * Ante un error, regresa directo a la pantalla inicial de MM02 navegando la
 * pestaña a la URL (más confiable que adivinar cuántos Escape hacen falta o
 * si el botón Home está visible): deja la sesión en un estado conocido para
 * el siguiente material, sin arrastrar el error.
 */
async function safeAbortAndReturnHome(tabId, log) {
  try {
    await chrome.tabs.update(tabId, { url: DEFAULT_SAP_URL });
    await sleep(1500);
  } catch (e) {
    log(`Aviso: no se pudo regresar a la pantalla inicial (${e.message}). Verifique el estado de la pestaña.`);
  }
}

// ---------------------------------------------------------------
// Agrupación por material contiguo (igual que GroupByMaterial en C#)
// ---------------------------------------------------------------

function groupByMaterial(tasks) {
  const groups = [];
  let current = null;
  let lastMaterial = null;
  for (const task of tasks.filter((t) => t.estado === "Pendiente")) {
    if (!current || task.material !== lastMaterial) {
      current = [];
      groups.push(current);
      lastMaterial = task.material;
    }
    current.push(task);
  }
  return groups;
}

// ---------------------------------------------------------------
// Bucle principal (equivalente a ProcessTasksAsync)
// ---------------------------------------------------------------

async function runAutomation(tasks, tabId, detenerEnPrimerError, ui) {
  const groups = groupByMaterial(tasks);
  for (const group of groups) {
    if (ui.stopRequested()) {
      ui.log("⏹ Proceso detenido por el usuario.");
      return;
    }

    const first = group[0];
    const pasos = group.map((t) => `${t.vista}/${t.campoTecnico}`).join(", ");

    try {
      ui.log(`--- [${first.material}] Iniciando (${group.length} paso(s): ${pasos}) ---`);

      await navigateToMM02(tabId, ui.log);
      await enterMaterial(tabId, first.material);
      await selectView(tabId, first.vista, ui.log);
      if (first.centro) await enterOrganizationalLevels(tabId, first.centro);

      const camposNoEncontrados = [];
      const camposLlenados = [];

      for (const task of group) {
        await switchToViewTab(tabId, task.vista);
        const accion = task.valor ? `Buscando campo ${task.campoTecnico} en '${task.vista}'...` : `Borrando campo ${task.campoTecnico} en '${task.vista}'...`;
        ui.log(accion);
        const found = await fillSapField(tabId, task.campoTecnico, task.valor, ui.log);
        if (found) {
          camposLlenados.push(task);
        } else {
          ui.setEstado(task, "Error", "Campo no localizado");
          camposNoEncontrados.push(task.campoTecnico);
          ui.log(`[${first.material}] ERROR: no se encontró el campo ${task.campoTecnico} en '${task.vista}'.`);
        }
      }

      if (camposLlenados.length === 0) {
        await safeAbortAndReturnHome(tabId, ui.log);
      } else {
        const { ok, message } = await saveTransaction(tabId, ui.log);
        const mensaje = message || (ok ? "OK" : "No se pudo confirmar el guardado");
        for (const task of camposLlenados) {
          ui.setEstado(task, ok ? "Procesado" : "Error", mensaje);
        }
        if (ok) {
          ui.log(`[${first.material}] Guardado con éxito (${camposLlenados.length} campo(s)). ${mensaje}`);
        } else {
          ui.log(`[${first.material}] ERROR al guardar: ${mensaje}`);
          await safeAbortAndReturnHome(tabId, ui.log);
        }
      }

      if (camposNoEncontrados.length > 0) {
        ui.log(`[${first.material}] Aviso: ${camposNoEncontrados.length} campo(s) de la secuencia no se pudieron ubicar (${camposNoEncontrados.join(", ")}).`);
      }
    } catch (e) {
      for (const task of group) {
        if (task.estado === "Pendiente") ui.setEstado(task, "Error", `Fallo en navegación: ${e.message}`);
      }
      ui.log(`[${first.material}] ERROR: ${e.message}`);
      await safeAbortAndReturnHome(tabId, ui.log);
    }

    if (detenerEnPrimerError && group.some((t) => t.estado === "Error")) {
      ui.log(`⏹ Proceso detenido: hubo un error en [${first.material}]. Corrige lo necesario y usa 'Reintentar errores' para continuar solo con los pendientes/fallidos.`);
      return;
    }

    await sleep(400);
  }

  ui.log("Proceso finalizado.");
}

// ---------------------------------------------------------------
// Grilla editable: solo Material, Centro, Valor por fila (Transacción,
// Vista y Campo técnico son una configuración única que aplica a todas las
// filas, ver sección 1 del panel). Estado/Mensaje son de solo lectura y se
// actualizan en vivo durante la ejecución.
// ---------------------------------------------------------------

const COLUMN_KEYS = ["material", "centro", "valor"];

// Incluye también los nombres del formato histórico de 6 columnas
// (Transaccion/Vista/CampoTecnico) solo para poder reconocer y descartar
// esa fila de encabezado al pegar/subir un Excel viejo; esos valores ya no
// se usan por fila (ver sección 1: Vista y Campo técnico son globales).
const HEADER_ALIASES = {
  material: "material",
  centro: "centro",
  valor: "valor",
  transaccion: "transaccion",
  vista: "vista",
  campotecnico: "campoTecnico",
  campo: "campoTecnico",
};

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function isHeaderRow(cells) {
  const nonEmpty = cells.map((c) => String(c || "").trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((c) => Object.prototype.hasOwnProperty.call(HEADER_ALIASES, normalizeHeader(c)));
}

const els = {
  reloadExtBtn: document.getElementById("reloadExtBtn"),
  tabInfo: document.getElementById("tabInfo"),
  globalVista: document.getElementById("globalVista"),
  globalCampoTecnico: document.getElementById("globalCampoTecnico"),
  fileInput: document.getElementById("fileInput"),
  addRowBtn: document.getElementById("addRowBtn"),
  clearGridBtn: document.getElementById("clearGridBtn"),
  gridBody: document.getElementById("gridBody"),
  detenerCheckbox: document.getElementById("detenerCheckbox"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  retryBtn: document.getElementById("retryBtn"),
  log: document.getElementById("log"),
};

const state = {
  stopFlag: false,
};

function log(text) {
  const stamp = new Date().toLocaleTimeString();
  els.log.textContent += `[${stamp}] ${text}\n`;
  els.log.scrollTop = els.log.scrollHeight;
  // Colapsado por defecto (una fila); se expande solo cuando de verdad hay
  // un error que revisar, para no ocupar espacio mientras todo fluye bien.
  if (/error/i.test(text)) {
    els.log.classList.remove("log-collapsed");
    els.log.classList.add("log-expanded");
  }
}

// ---------------------------------------------------------------
// Pestaña activa de SAP: se detecta sola, sin que el usuario tenga que
// hacer click en ningún botón. Se muestra en vivo y se vuelve a resolver
// justo al iniciar/reintentar, así siempre usa la pestaña que esté activa
// en ese momento.
// ---------------------------------------------------------------

async function getActiveSapTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function describeTab(tab) {
  if (!tab) {
    els.tabInfo.textContent = "Sin pestaña activa";
    els.tabInfo.title = "No se detecta ninguna pestaña activa.";
    els.tabInfo.className = "tab-status tab-missing";
    return;
  }
  const esSap = tab.url && tab.url.includes(SAP_HOST);
  const full = `Pestaña activa: ${tab.title || "(sin título)"} — ${tab.url || ""}`;
  els.tabInfo.title = full;
  els.tabInfo.className = "tab-status" + (esSap ? "" : " tab-warning");
  els.tabInfo.textContent = esSap ? `✓ SAP: ${tab.title || "(sin título)"}` : `⚠️ No es Fiori/SAP: ${tab.title || ""}`;
}

chrome.tabs.onActivated.addListener(async () => describeTab(await getActiveSapTab()));
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete" && !changeInfo.url) return;
  const active = await getActiveSapTab();
  if (active && active.id === tabId) describeTab(active);
});
getActiveSapTab().then(describeTab);

// ---------------------------------------------------------------
// Vista desplegable global
// ---------------------------------------------------------------

function initGlobalVistaSelect() {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "-- Selecciona vista --";
  els.globalVista.appendChild(blank);
  for (const v of SAP_VIEWS) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    els.globalVista.appendChild(opt);
  }
}

function setGlobalVistaValue(rawValue) {
  const val = String(rawValue || "").trim();
  if (!val) return;
  const norm = normalizeHeader(val);
  let match = Array.from(els.globalVista.options).find((o) => normalizeHeader(o.value) === norm);
  if (!match) {
    match = document.createElement("option");
    match.value = val;
    match.textContent = `${val} (personalizada)`;
    els.globalVista.appendChild(match);
  }
  els.globalVista.value = match.value;
}

// ---------------------------------------------------------------
// Grilla
// ---------------------------------------------------------------

function makeTextInput(colKey) {
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.col = colKey;
  if (colKey === "valor") input.placeholder = "(vacío → se borrará en SAP)";
  input.addEventListener("paste", onCellPaste);
  return input;
}

function addRow(initial = {}) {
  const tr = document.createElement("tr");
  tr.dataset.estado = "Pendiente";
  tr.className = "estado-pendiente";

  const tdDel = document.createElement("td");
  const delBtn = document.createElement("button");
  delBtn.className = "row-del-btn";
  delBtn.textContent = "✕";
  delBtn.title = "Eliminar fila";
  delBtn.addEventListener("click", () => tr.remove());
  tdDel.appendChild(delBtn);
  tr.appendChild(tdDel);

  const tdMaterial = document.createElement("td");
  const inputMaterial = makeTextInput("material");
  inputMaterial.value = initial.material || "";
  tdMaterial.appendChild(inputMaterial);
  tr.appendChild(tdMaterial);

  const tdCentro = document.createElement("td");
  const inputCentro = makeTextInput("centro");
  inputCentro.value = initial.centro || "";
  tdCentro.appendChild(inputCentro);
  tr.appendChild(tdCentro);

  const tdValor = document.createElement("td");
  const inputValor = makeTextInput("valor");
  inputValor.value = initial.valor || "";
  tdValor.appendChild(inputValor);
  tr.appendChild(tdValor);

  const tdEstado = document.createElement("td");
  tdEstado.className = "estado-cell";
  tdEstado.textContent = "Pendiente";
  tr.appendChild(tdEstado);

  const tdMensaje = document.createElement("td");
  tdMensaje.className = "mensaje-cell";
  tdMensaje.textContent = "";
  tr.appendChild(tdMensaje);

  els.gridBody.appendChild(tr);
  return tr;
}

function ensureRowExists(index) {
  while (els.gridBody.children.length <= index) addRow();
  return els.gridBody.children[index];
}

function setCellValue(rowIndex, key, value) {
  const tr = ensureRowExists(rowIndex);
  const input = tr.querySelector(`[data-col="${key}"]`);
  if (input) input.value = String(value ?? "").trim();
}

/** Pegado tipo hoja de cálculo: distribuye filas/columnas (Material, Centro, Valor) desde la celda con foco. */
function onCellPaste(e) {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!text || !/[\t\r\n]/.test(text)) return; // valor simple: dejar que el navegador pegue normal

  e.preventDefault();
  const tr = e.target.closest("tr");
  const startRowIndex = Array.from(els.gridBody.children).indexOf(tr);
  const startColKey = e.target.dataset.col;
  const startColIdx = COLUMN_KEYS.indexOf(startColKey);

  let lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return;

  const firstCells = lines[0].split("\t");
  if (isHeaderRow(firstCells)) lines = lines.slice(1);

  lines.forEach((line, rOffset) => {
    const cells = line.split("\t");
    const targetRow = startRowIndex + rOffset;
    cells.forEach((val, cOffset) => {
      const colIdx = startColIdx + cOffset;
      if (colIdx < 0 || colIdx >= COLUMN_KEYS.length) return;
      setCellValue(targetRow, COLUMN_KEYS[colIdx], val);
    });
  });

  log(`Pegado(s) ${lines.length} fila(s) en la tabla.`);
}

function collectTasksFromGrid() {
  const vista = els.globalVista.value.trim();
  const campoTecnico = els.globalCampoTecnico.value.trim();
  const tasks = [];
  for (const tr of Array.from(els.gridBody.children)) {
    const material = tr.querySelector('[data-col="material"]').value.trim();
    if (!material) continue;
    if (!tr.dataset.estado) tr.dataset.estado = "Pendiente";
    tasks.push({
      material,
      centro: tr.querySelector('[data-col="centro"]').value.trim(),
      transaccion: "MM02",
      vista,
      campoTecnico,
      valor: tr.querySelector('[data-col="valor"]').value.trim(),
      estado: tr.dataset.estado,
      mensaje: tr.dataset.mensaje || "",
      _tr: tr,
    });
  }
  return tasks;
}

function setEstado(task, estado, mensaje) {
  task.estado = estado;
  task.mensaje = mensaje || "";
  const tr = task._tr;
  if (!tr) return;
  tr.dataset.estado = estado;
  tr.dataset.mensaje = task.mensaje;
  tr.className = "estado-" + estado.toLowerCase();
  tr.querySelector(".estado-cell").textContent = estado;
  tr.querySelector(".mensaje-cell").textContent = task.mensaje;
}

function setControlsEnabled(enabled) {
  els.startBtn.disabled = !enabled;
  els.retryBtn.disabled = !enabled;
  els.addRowBtn.disabled = !enabled;
  els.clearGridBtn.disabled = !enabled;
  els.fileInput.disabled = !enabled;
  els.globalVista.disabled = !enabled;
  els.globalCampoTecnico.disabled = !enabled;
}

// ---------------------------------------------------------------
// Eventos de UI
// ---------------------------------------------------------------

els.reloadExtBtn.addEventListener("click", () => {
  log("Recargando extensión (recuerda refrescar también la pestaña de SAP para que tome los cambios)...");
  chrome.runtime.reload();
});

els.addRowBtn.addEventListener("click", () => addRow());

els.clearGridBtn.addEventListener("click", () => {
  els.gridBody.innerHTML = "";
  for (let i = 0; i < 6; i++) addRow();
  log("Tabla vaciada.");
});

els.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    if (matrix.length === 0) {
      log(`El archivo "${file.name}" no tiene filas.`);
      return;
    }
    // Compatible con el formato histórico de 6 columnas
    // (Material, Centro, Transaccion, Vista, CampoTecnico, Valor): la Vista
    // y el CampoTecnico de la primera fila con datos rellenan la
    // configuración global (si está vacía); el resto de columnas se ignora.
    let rows = matrix;
    if (isHeaderRow(matrix[0])) rows = matrix.slice(1);

    els.gridBody.innerHTML = "";
    let count = 0;
    let vistaFromFile = "";
    let campoFromFile = "";
    for (const row of rows) {
      if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
      if (!vistaFromFile) vistaFromFile = String(row[3] ?? "").trim();
      if (!campoFromFile) campoFromFile = String(row[4] ?? "").trim();
      addRow({
        material: row[0],
        centro: row[1],
        valor: row[5] !== undefined ? row[5] : row[2],
      });
      count++;
    }
    if (count === 0) addRow();
    if (!els.globalVista.value && vistaFromFile) setGlobalVistaValue(vistaFromFile);
    if (!els.globalCampoTecnico.value && campoFromFile) els.globalCampoTecnico.value = campoFromFile;
    log(`${count} fila(s) cargada(s) desde "${file.name}".`);
  } catch (err) {
    log(`ERROR al leer el Excel: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

async function startRun(tasks) {
  const vista = els.globalVista.value.trim();
  const campoTecnico = els.globalCampoTecnico.value.trim();
  if (!vista || !campoTecnico) {
    log("Completa la Vista y el Campo técnico (paso 1) antes de iniciar — aplican a todas las filas.");
    return;
  }
  if (tasks.length === 0) {
    log("No hay materiales con la columna 'Material' completa en la tabla.");
    return;
  }
  const tab = await getActiveSapTab();
  if (!tab) {
    log("No se detecta ninguna pestaña activa. Abre/enfoca la pestaña de SAP e inténtalo de nuevo.");
    return;
  }
  describeTab(tab);
  if (!tab.url || !tab.url.includes(SAP_HOST)) {
    log("⚠️ Aviso: la pestaña activa no parece ser la de Fiori/SAP. Verifica antes de continuar.");
  }

  state.stopFlag = false;
  setControlsEnabled(false);
  try {
    await runAutomation(tasks, tab.id, els.detenerCheckbox.checked, {
      log,
      setEstado,
      stopRequested: () => state.stopFlag,
    });
  } catch (e) {
    log(`ERROR CRÍTICO: ${e.message}`);
  } finally {
    setControlsEnabled(true);
  }
}

els.startBtn.addEventListener("click", () => startRun(collectTasksFromGrid()));

els.stopBtn.addEventListener("click", () => {
  state.stopFlag = true;
  log("Deteniendo tras el material en curso...");
});

els.retryBtn.addEventListener("click", () => {
  for (const tr of Array.from(els.gridBody.children)) {
    if (tr.dataset.estado === "Error") {
      tr.dataset.estado = "Pendiente";
      tr.dataset.mensaje = "";
      tr.className = "estado-pendiente";
      tr.querySelector(".estado-cell").textContent = "Pendiente";
      tr.querySelector(".mensaje-cell").textContent = "";
    }
  }
  const tasks = collectTasksFromGrid();
  const pendientes = tasks.filter((t) => t.estado === "Pendiente").length;
  if (pendientes === 0) {
    log("No hay tareas en estado Error para reintentar.");
    return;
  }
  startRun(tasks);
});

initGlobalVistaSelect();
for (let i = 0; i < 6; i++) addRow();
log("Panel listo. Completa la Vista y el Campo técnico, y la tabla de materiales.");
