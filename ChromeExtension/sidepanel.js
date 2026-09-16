// Orquestación de la automatización. Vive en el side panel (página normal,
// no service worker) para no tener el límite de 30s de inactividad de MV3:
// mientras el panel esté abierto, este script puede usar setTimeout/await
// libremente durante todo el proceso, igual que ProcessTasksAsync en el
// SapAutomationService.cs original.

const DEFAULT_TIMEOUT = 15000;
const SHORT_TIMEOUT = 5000;
const SAVE_TIMEOUT = 3000;
const OPTIONAL_DIALOG_TIMEOUT = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let res = await waitFor(tabId, { type: "CLICK_TILE" }, SHORT_TIMEOUT);
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
  const res = await waitFor(tabId, { type: "FILL_FIELD", campoTecnico, valor }, SHORT_TIMEOUT);
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
  return { ok: true, message: "Guardado (sin confirmación de barra de estado)" };
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

async function safeAbortAndReturnHome(tabId, log) {
  try {
    await broadcastOnce(tabId, { type: "ESCAPE" });
    await sleep(400);
    await broadcastOnce(tabId, { type: "ESCAPE" });
    await sleep(400);
    await broadcastOnce(tabId, { type: "CLICK_HOME" });
    await sleep(800);
  } catch (e) {
    log(`Aviso: no se pudo recuperar automáticamente la sesión (${e.message}). Verifique el estado de la pestaña.`);
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
        ui.log(`Buscando campo ${task.campoTecnico} en '${task.vista}'...`);
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
// UI: carga de Excel/CSV, tabla de tareas, log, botones
// ---------------------------------------------------------------

const HEADER_ALIASES = {
  material: "material",
  centro: "centro",
  transaccion: "transaccion",
  vista: "vista",
  campotecnico: "campoTecnico",
  campo: "campoTecnico",
  valor: "valor",
};

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function matrixToTasks(matrix) {
  if (!matrix || matrix.length === 0) return [];
  const header = matrix[0].map(normalizeHeader);
  const colIndex = {};
  header.forEach((h, i) => {
    const key = HEADER_ALIASES[h];
    if (key) colIndex[key] = i;
  });

  const tasks = [];
  for (const row of matrix.slice(1)) {
    if (!row || row.every((c) => c === undefined || c === null || String(c).trim() === "")) continue;
    const get = (key) => {
      const idx = colIndex[key];
      return idx === undefined ? "" : String(row[idx] ?? "").trim();
    };
    const material = get("material");
    if (!material) continue;
    tasks.push({
      material,
      centro: get("centro"),
      transaccion: get("transaccion") || "MM02",
      vista: get("vista"),
      campoTecnico: get("campoTecnico"),
      valor: get("valor"),
      estado: "Pendiente",
      mensaje: "",
    });
  }
  return tasks;
}

const state = {
  tasks: [],
  tabId: null,
  rows: [],
  stopFlag: false,
};

const els = {
  useActiveTabBtn: document.getElementById("useActiveTabBtn"),
  tabInfo: document.getElementById("tabInfo"),
  fileInput: document.getElementById("fileInput"),
  pasteArea: document.getElementById("pasteArea"),
  pasteBtn: document.getElementById("pasteBtn"),
  detenerCheckbox: document.getElementById("detenerCheckbox"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  retryBtn: document.getElementById("retryBtn"),
  taskCount: document.getElementById("taskCount"),
  taskBody: document.getElementById("taskBody"),
  log: document.getElementById("log"),
};

function log(text) {
  const stamp = new Date().toLocaleTimeString();
  els.log.textContent += `[${stamp}] ${text}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function renderTable() {
  els.taskBody.innerHTML = "";
  state.rows = [];
  for (const task of state.tasks) {
    const tr = document.createElement("tr");
    tr.className = "estado-" + task.estado.toLowerCase();
    tr.innerHTML = `
      <td>${escapeHtml(task.material)}</td>
      <td>${escapeHtml(task.centro)}</td>
      <td>${escapeHtml(task.vista)}</td>
      <td>${escapeHtml(task.campoTecnico)}</td>
      <td>${escapeHtml(task.valor)}</td>
      <td>${escapeHtml(task.estado)}</td>
      <td>${escapeHtml(task.mensaje)}</td>
    `;
    els.taskBody.appendChild(tr);
    state.rows.push(tr);
  }
  els.taskCount.textContent = String(state.tasks.length);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setEstado(task, estado, mensaje) {
  task.estado = estado;
  task.mensaje = mensaje || "";
  const idx = state.tasks.indexOf(task);
  if (idx === -1) return;
  const tr = state.rows[idx];
  if (!tr) return;
  tr.className = "estado-" + estado.toLowerCase();
  tr.children[5].textContent = estado;
  tr.children[6].textContent = task.mensaje;
}

function setControlsEnabled(enabled) {
  els.startBtn.disabled = !enabled;
  els.retryBtn.disabled = !enabled;
  els.fileInput.disabled = !enabled;
  els.pasteBtn.disabled = !enabled;
}

function loadTasks(matrix, source) {
  const tasks = matrixToTasks(matrix);
  if (tasks.length === 0) {
    log(`No se encontraron filas válidas en ${source}. Verifica que la primera fila tenga los encabezados Material, Centro, Transaccion, Vista, CampoTecnico, Valor.`);
    return;
  }
  state.tasks = tasks;
  renderTable();
  log(`${tasks.length} tarea(s) cargada(s) desde ${source}.`);
}

els.useActiveTabBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    log("No se pudo obtener la pestaña activa.");
    return;
  }
  state.tabId = tab.id;
  els.tabInfo.textContent = `Pestaña: ${tab.title || "(sin título)"} — ${tab.url || ""}`;
  if (!tab.url || !tab.url.includes("fiori.medifarma.com.pe")) {
    log("⚠️ Aviso: la pestaña activa no parece ser la de Fiori/SAP (fiori.medifarma.com.pe). Verifica antes de iniciar.");
  } else {
    log("Pestaña de SAP seleccionada.");
  }
});

els.fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    loadTasks(matrix, `el archivo "${file.name}"`);
  } catch (err) {
    log(`ERROR al leer el Excel: ${err.message}`);
  }
});

els.pasteBtn.addEventListener("click", () => {
  const text = els.pasteArea.value.trim();
  if (!text) {
    log("No hay texto pegado para cargar.");
    return;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const matrix = lines.map((l) => l.split(sep));
  loadTasks(matrix, "el texto pegado");
});

els.startBtn.addEventListener("click", async () => {
  if (!state.tabId) {
    log("Primero selecciona la pestaña activa de SAP (paso 1).");
    return;
  }
  if (state.tasks.length === 0) {
    log("No hay tareas cargadas (paso 2).");
    return;
  }
  state.stopFlag = false;
  setControlsEnabled(false);
  try {
    await runAutomation(state.tasks, state.tabId, els.detenerCheckbox.checked, {
      log,
      setEstado,
      stopRequested: () => state.stopFlag,
    });
  } catch (e) {
    log(`ERROR CRÍTICO: ${e.message}`);
  } finally {
    setControlsEnabled(true);
  }
});

els.stopBtn.addEventListener("click", () => {
  state.stopFlag = true;
  log("Deteniendo tras el material en curso...");
});

els.retryBtn.addEventListener("click", async () => {
  const errored = state.tasks.filter((t) => t.estado === "Error");
  if (errored.length === 0) {
    log("No hay tareas en estado Error para reintentar.");
    return;
  }
  errored.forEach((t) => setEstado(t, "Pendiente", ""));
  if (!state.tabId) {
    log("Primero selecciona la pestaña activa de SAP (paso 1).");
    return;
  }
  state.stopFlag = false;
  setControlsEnabled(false);
  try {
    await runAutomation(state.tasks, state.tabId, els.detenerCheckbox.checked, {
      log,
      setEstado,
      stopRequested: () => state.stopFlag,
    });
  } catch (e) {
    log(`ERROR CRÍTICO: ${e.message}`);
  } finally {
    setControlsEnabled(true);
  }
});

renderTable();
log("Panel listo. Selecciona la pestaña de SAP y carga los materiales a bloquear.");
