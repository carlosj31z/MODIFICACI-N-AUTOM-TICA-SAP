// macro.js — Apartado "Grabar configuración": graba clicks/cambios reales
// del usuario en CUALQUIER vista de MM01 o MM02 y los reproduce después
// sobre una lista de materiales, como una macro. Totalmente aparte del
// apartado "Modificar material" (sidepanel.js) — no lo modifica ni depende
// de su estado, aunque SÍ reutiliza sus funciones de comunicación con
// content.js (broadcastOnce, getActiveSapTab, sleep, SAP_HOST,
// DEFAULT_SAP_URL, safeAbortAndReturnHome, formatEta), ya declaradas como
// top-level en sidepanel.js: al no ser módulos ES, ambos <script> comparten
// el mismo scope global de la página, así que están disponibles aquí sin
// necesidad de duplicarlas.

const macroEls = {
  modeToolBtn: document.getElementById("modeToolBtn"),
  modeMacroBtn: document.getElementById("modeMacroBtn"),
  toolSection: document.getElementById("toolSection"),
  macroSection: document.getElementById("macroSection"),
  pageTitle: document.getElementById("pageTitle"),

  recordBtn: document.getElementById("macroRecordBtn"),
  stopBtn: document.getElementById("macroStopBtn"),
  clearStepsBtn: document.getElementById("macroClearStepsBtn"),
  stepsBody: document.getElementById("macroStepsBody"),
  nameInput: document.getElementById("macroNameInput"),
  saveTemplateBtn: document.getElementById("macroSaveTemplateBtn"),

  templateSelect: document.getElementById("macroTemplateSelect"),
  deleteTemplateBtn: document.getElementById("macroDeleteTemplateBtn"),
  exportBtn: document.getElementById("macroExportBtn"),
  importInput: document.getElementById("macroImportInput"),
  previewBody: document.getElementById("macroPreviewBody"),

  addRowBtn: document.getElementById("macroAddRowBtn"),
  clearGridBtn: document.getElementById("macroClearGridBtn"),
  gridBody: document.getElementById("macroGridBody"),
  detenerCheckbox: document.getElementById("macroDetenerCheckbox"),
  startBtn: document.getElementById("macroStartBtn"),
  stopRunBtn: document.getElementById("macroStopRunBtn"),
  retryBtn: document.getElementById("macroRetryBtn"),
  progressWrap: document.getElementById("macroProgressWrap"),
  progressFill: document.getElementById("macroProgressFill"),
  progressText: document.getElementById("macroProgressText"),
  log: document.getElementById("macroLog"),
};

const macroState = {
  recording: false,
  steps: [],
  stopFlag: false,
  recordTabId: null,
};

// ---------------------------------------------------------------
// Pestañas de modo (Modificar material / Grabar configuración)
// ---------------------------------------------------------------

function setMode(mode) {
  const isMacro = mode === "macro";
  macroEls.toolSection.hidden = isMacro;
  macroEls.macroSection.hidden = !isMacro;
  macroEls.modeToolBtn.classList.toggle("mode-tab-active", !isMacro);
  macroEls.modeMacroBtn.classList.toggle("mode-tab-active", isMacro);
  macroEls.pageTitle.textContent = isMacro ? "Grabar configuración" : "Modificar material";
}
macroEls.modeToolBtn.addEventListener("click", () => setMode("tool"));
macroEls.modeMacroBtn.addEventListener("click", () => setMode("macro"));

function macroLog(text) {
  const stamp = new Date().toLocaleTimeString();
  macroEls.log.textContent += `[${stamp}] ${text}\n`;
  macroEls.log.scrollTop = macroEls.log.scrollHeight;
  if (/error/i.test(text)) {
    macroEls.log.classList.remove("log-collapsed");
    macroEls.log.classList.add("log-expanded");
  }
}

/** Traduce un paso grabado (formato interno) a texto legible para las tablas. */
function describeStep(step) {
  const accionMap = { click: "Click", fill: "Llenar", check: "Marcar" };
  const accion = accionMap[step.action] || step.action;
  let detalle;
  switch (step.kind) {
    case "field":
      detalle = `Campo ${step.tech}`;
      break;
    case "tableField":
      detalle = `Fila "${step.label}"`;
      break;
    case "tile":
      detalle = `Tile "${step.label}"`;
      break;
    case "tab":
      detalle = `Pestaña "${step.label}"`;
      break;
    case "row":
      detalle = `Fila "${step.label}"`;
      break;
    case "save":
      detalle = "Botón Grabar";
      break;
    case "button":
      detalle = `Botón "${step.label}"`;
      break;
    default:
      detalle = step.label || "";
  }
  const valor = step.action === "fill" ? step.value : step.action === "check" ? (step.checked ? "marcado" : "desmarcado") : "";
  return { accion, detalle, valor };
}

/**
 * Dibuja la tabla de pasos. En modo `editable` (la grabación en curso)
 * agrega un botón para borrar el paso y, si el paso tiene un valor
 * (fill/check), lo vuelve editable — así se puede corregir un dato o
 * sacar un paso de más antes de guardar como plantilla. Las plantillas ya
 * guardadas (vista previa) se muestran de solo lectura.
 */
function renderStepsTable(tbody, steps, options = {}) {
  const { editable = false, onDelete, onValueChange } = options;
  tbody.innerHTML = "";
  steps.forEach((step, i) => {
    const { accion, detalle, valor } = describeStep(step);
    const tr = document.createElement("tr");

    if (editable) {
      const tdDel = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "row-del-btn";
      delBtn.textContent = "✕";
      delBtn.title = "Eliminar este paso";
      delBtn.addEventListener("click", () => onDelete?.(i));
      tdDel.appendChild(delBtn);
      tr.appendChild(tdDel);
    }

    const tdNum = document.createElement("td");
    tdNum.textContent = i + 1;
    tr.appendChild(tdNum);

    const tdAccion = document.createElement("td");
    tdAccion.textContent = accion;
    tr.appendChild(tdAccion);

    const tdDetalle = document.createElement("td");
    tdDetalle.textContent = detalle;
    tr.appendChild(tdDetalle);

    const tdValor = document.createElement("td");
    if (editable && step.action === "fill") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "step-value-input";
      input.value = step.value ?? "";
      input.addEventListener("change", () => onValueChange?.(i, input.value));
      tdValor.appendChild(input);
    } else if (editable && step.action === "check") {
      const label = document.createElement("label");
      label.className = "step-check-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!step.checked;
      checkbox.addEventListener("change", () => onValueChange?.(i, checkbox.checked));
      label.appendChild(checkbox);
      label.append(" marcado");
      tdValor.appendChild(label);
    } else {
      tdValor.textContent = valor;
    }
    tr.appendChild(tdValor);

    tbody.appendChild(tr);
  });
}

function renderRecordedSteps() {
  renderStepsTable(macroEls.stepsBody, macroState.steps, {
    editable: true,
    onDelete: (i) => {
      macroState.steps.splice(i, 1);
      renderRecordedSteps();
    },
    onValueChange: (i, value) => {
      const step = macroState.steps[i];
      if (step.action === "fill") step.value = value;
      else if (step.action === "check") step.checked = value;
    },
  });
}

// ---------------------------------------------------------------
// Grabación: recibe los pasos que content.js va reportando en vivo
// mientras el usuario trabaja normal en su pestaña de SAP.
// ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "RECORDED_STEP" && macroState.recording) {
    macroState.steps.push(msg.step);
    renderRecordedSteps();
  }
});

macroEls.recordBtn.addEventListener("click", async () => {
  const tab = await getActiveSapTab();
  if (!tab) {
    macroLog("No se detecta ninguna pestaña activa. Abre/enfoca la pestaña de SAP.");
    return;
  }
  if (!tab.url || !tab.url.includes(SAP_HOST)) {
    macroLog("⚠️ Aviso: la pestaña activa no parece ser Fiori/SAP. La grabación solo captura acciones ahí.");
  }
  macroState.recordTabId = tab.id;
  macroState.recording = true;
  await broadcastOnce(tab.id, { type: "START_RECORDING" });
  macroEls.recordBtn.disabled = true;
  macroEls.stopBtn.disabled = false;
  macroLog(`Grabando en: ${tab.title || tab.url}. Trabaja normal en SAP (MM01/MM02, cualquier vista) — cada click y campo queda registrado abajo.`);
});

macroEls.stopBtn.addEventListener("click", async () => {
  macroState.recording = false;
  if (macroState.recordTabId) {
    await broadcastOnce(macroState.recordTabId, { type: "STOP_RECORDING" });
  }
  macroEls.recordBtn.disabled = false;
  macroEls.stopBtn.disabled = true;
  macroLog(`Grabación detenida. ${macroState.steps.length} paso(s) registrados.`);
});

macroEls.clearStepsBtn.addEventListener("click", () => {
  macroState.steps = [];
  renderRecordedSteps();
  macroLog("Pasos grabados vaciados.");
});

// ---------------------------------------------------------------
// Plantillas guardadas (chrome.storage.local, persisten entre sesiones)
// ---------------------------------------------------------------

const TEMPLATES_KEY = "sapMacroTemplates";

async function loadTemplates() {
  const data = await chrome.storage.local.get(TEMPLATES_KEY);
  return data[TEMPLATES_KEY] || {};
}

async function saveTemplatesToStorage(templates) {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

async function refreshTemplateSelect(preferName) {
  const templates = await loadTemplates();
  const names = Object.keys(templates).sort();
  macroEls.templateSelect.innerHTML = "";
  if (names.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(sin plantillas guardadas)";
    macroEls.templateSelect.appendChild(opt);
    renderStepsTable(macroEls.previewBody, []);
    return;
  }
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${name} (${templates[name].length} paso(s))`;
    macroEls.templateSelect.appendChild(opt);
  }
  const toSelect = preferName && names.includes(preferName) ? preferName : names[0];
  macroEls.templateSelect.value = toSelect;
  renderStepsTable(macroEls.previewBody, templates[toSelect] || []);
}

macroEls.templateSelect.addEventListener("change", async () => {
  const templates = await loadTemplates();
  renderStepsTable(macroEls.previewBody, templates[macroEls.templateSelect.value] || []);
});

macroEls.saveTemplateBtn.addEventListener("click", async () => {
  const name = macroEls.nameInput.value.trim();
  if (!name) {
    macroLog("Ponle un nombre a la plantilla antes de guardar.");
    return;
  }
  if (macroState.steps.length === 0) {
    macroLog("No hay pasos grabados para guardar.");
    return;
  }
  const templates = await loadTemplates();
  templates[name] = macroState.steps;
  await saveTemplatesToStorage(templates);
  macroLog(`Plantilla "${name}" guardada (${macroState.steps.length} paso(s)).`);
  await refreshTemplateSelect(name);
});

macroEls.deleteTemplateBtn.addEventListener("click", async () => {
  const name = macroEls.templateSelect.value;
  if (!name) return;
  const templates = await loadTemplates();
  delete templates[name];
  await saveTemplatesToStorage(templates);
  macroLog(`Plantilla "${name}" eliminada.`);
  await refreshTemplateSelect();
});

// Exportar/importar como archivo .json, para compartir plantillas entre
// compañeros o entre distintos perfiles de Chrome (chrome.storage.local es
// por perfil, no viaja solo).

macroEls.exportBtn.addEventListener("click", async () => {
  const name = macroEls.templateSelect.value;
  if (!name) {
    macroLog("Selecciona una plantilla para exportar.");
    return;
  }
  const templates = await loadTemplates();
  const steps = templates[name];
  if (!steps) {
    macroLog("Plantilla no encontrada.");
    return;
  }
  const blob = new Blob([JSON.stringify({ name, steps }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9_-]+/gi, "_")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  macroLog(`Plantilla "${name}" exportada.`);
});

macroEls.importInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.steps)) {
      throw new Error("El archivo no tiene el formato esperado ({ name, steps }).");
    }
    let name = (data.name || file.name.replace(/\.json$/i, "")).trim() || "Importada";
    const templates = await loadTemplates();
    if (templates[name]) {
      let n = 2;
      while (templates[`${name} (${n})`]) n++;
      name = `${name} (${n})`;
    }
    templates[name] = data.steps;
    await saveTemplatesToStorage(templates);
    macroLog(`Plantilla "${name}" importada (${data.steps.length} paso(s)).`);
    await refreshTemplateSelect(name);
  } catch (err) {
    macroLog(`ERROR al importar: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------
// Grilla de materiales (Material, Centro) para aplicar la plantilla
// ---------------------------------------------------------------

const MACRO_COLS = ["material", "centro"];

function macroMakeTextInput(colKey) {
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.col = colKey;
  input.addEventListener("paste", onMacroCellPaste);
  return input;
}

function macroAddRow(initial = {}) {
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
  const inputMaterial = macroMakeTextInput("material");
  inputMaterial.value = initial.material || "";
  tdMaterial.appendChild(inputMaterial);
  tr.appendChild(tdMaterial);

  const tdCentro = document.createElement("td");
  const inputCentro = macroMakeTextInput("centro");
  inputCentro.value = initial.centro || "";
  tdCentro.appendChild(inputCentro);
  tr.appendChild(tdCentro);

  const tdEstado = document.createElement("td");
  tdEstado.className = "estado-cell";
  tdEstado.textContent = "Pendiente";
  tr.appendChild(tdEstado);

  const tdMensaje = document.createElement("td");
  tdMensaje.className = "mensaje-cell";
  tr.appendChild(tdMensaje);

  macroEls.gridBody.appendChild(tr);
  return tr;
}

function onMacroCellPaste(e) {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!text || !/[\t\r\n]/.test(text)) return;
  e.preventDefault();
  const tr = e.target.closest("tr");
  const startRowIndex = Array.from(macroEls.gridBody.children).indexOf(tr);
  const startColIdx = MACRO_COLS.indexOf(e.target.dataset.col);

  let lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return;
  const firstCells = lines[0].split("\t");
  if (firstCells.length && /^material$/i.test((firstCells[0] || "").trim())) lines = lines.slice(1);

  lines.forEach((line, rOffset) => {
    const cells = line.split("\t");
    const targetRow = startRowIndex + rOffset;
    while (macroEls.gridBody.children.length <= targetRow) macroAddRow();
    const trTarget = macroEls.gridBody.children[targetRow];
    cells.forEach((val, cOffset) => {
      const colIdx = startColIdx + cOffset;
      if (colIdx < 0 || colIdx >= MACRO_COLS.length) return;
      const input = trTarget.querySelector(`[data-col="${MACRO_COLS[colIdx]}"]`);
      if (input) input.value = val.trim();
    });
  });
  macroLog(`Pegado(s) ${lines.length} fila(s) en la tabla de materiales.`);
}

macroEls.addRowBtn.addEventListener("click", () => macroAddRow());
macroEls.clearGridBtn.addEventListener("click", () => {
  macroEls.gridBody.innerHTML = "";
  for (let i = 0; i < 4; i++) macroAddRow();
  macroLog("Tabla de materiales vaciada.");
});

function macroCollectTasks() {
  const tasks = [];
  for (const tr of Array.from(macroEls.gridBody.children)) {
    const material = tr.querySelector('[data-col="material"]').value.trim();
    if (!material) continue;
    if (!tr.dataset.estado) tr.dataset.estado = "Pendiente";
    tasks.push({
      material,
      centro: tr.querySelector('[data-col="centro"]').value.trim(),
      estado: tr.dataset.estado,
      _tr: tr,
    });
  }
  return tasks;
}

function macroSetEstado(task, estado, mensaje) {
  task.estado = estado;
  const tr = task._tr;
  if (!tr) return;
  tr.dataset.estado = estado;
  tr.className = "estado-" + estado.toLowerCase();
  tr.querySelector(".estado-cell").textContent = estado;
  tr.querySelector(".mensaje-cell").textContent = mensaje || "";
}

// ---------------------------------------------------------------
// Reproducción de la plantilla sobre cada material
// ---------------------------------------------------------------

function macroSetControlsEnabled(enabled) {
  macroEls.startBtn.disabled = !enabled;
  macroEls.retryBtn.disabled = !enabled;
  macroEls.addRowBtn.disabled = !enabled;
  macroEls.clearGridBtn.disabled = !enabled;
  macroEls.templateSelect.disabled = !enabled;
}

function macroUpdateProgress(done, total, etaMs) {
  if (total === 0) {
    macroEls.progressWrap.hidden = true;
    return;
  }
  macroEls.progressWrap.hidden = false;
  const pct = Math.round((done / total) * 100);
  macroEls.progressFill.style.width = `${pct}%`;
  const etaTxt = done >= total ? "" : etaMs == null ? " · calculando tiempo estimado…" : ` · ~${formatEta(etaMs)} restante`;
  macroEls.progressText.textContent = `${done}/${total} materiales (${pct}%)${etaTxt}`;
}

/** Ejecuta un paso contra la pestaña con reintentos — mismo patrón que
 * waitFor() en sidepanel.js, pero genérico sobre EXECUTE_STEP. */
async function macroRunStep(tabId, step, overrideValue, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false };
  do {
    last = await broadcastOnce(tabId, { type: "EXECUTE_STEP", step, overrideValue });
    if (last.ok) return last;
    await sleep(250);
  } while (Date.now() < deadline);
  return last;
}

/** El paso grabado del campo Material (y Centro, si se grabó) se sustituye
 * por el valor de la fila actual; todo lo demás se repite tal como se
 * grabó. Así una sola grabación sirve para cualquier lista de materiales. */
function macroOverrideFor(step, material, centro) {
  if (step.action !== "fill" || step.kind !== "field") return undefined;
  if (step.tech === "RMMG1-MATNR") return material;
  if (step.tech === "WERKS") return centro || undefined;
  return undefined;
}

async function macroRunAutomation(templateSteps, tasks, tabId, detenerEnPrimerError, ui) {
  const total = tasks.length;
  const durations = [];
  let done = 0;
  ui.onProgress?.(0, total, null);

  for (const task of tasks) {
    if (ui.stopRequested()) {
      ui.log("⏹ Proceso detenido por el usuario.");
      return;
    }
    const start = Date.now();
    ui.log(`--- [${task.material}] Reproduciendo plantilla (${templateSteps.length} paso(s)) ---`);
    let stepFailed = false;

    for (let i = 0; i < templateSteps.length; i++) {
      const step = templateSteps[i];
      const overrideValue = macroOverrideFor(step, task.material, task.centro);
      const res = await macroRunStep(tabId, step, overrideValue);
      if (!res.ok) {
        const { accion, detalle } = describeStep(step);
        ui.setEstado(task, "Error", `Paso ${i + 1} (${accion} ${detalle}) falló: ${res.trace || "no encontrado"}`);
        ui.log(`[${task.material}] ERROR en paso ${i + 1} (${accion} ${detalle}): ${res.trace || "no encontrado"}`);
        stepFailed = true;
        break;
      }
      await sleep(300);
    }

    if (!stepFailed) {
      ui.setEstado(task, "Procesado", "Plantilla reproducida");
      ui.log(`[${task.material}] Plantilla reproducida con éxito.`);
    } else {
      await safeAbortAndReturnHome(tabId, ui.log);
    }

    done++;
    durations.push(Date.now() - start);
    const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    const etaMs = Math.max(0, Math.round(avgMs * (total - done)));
    ui.onProgress?.(done, total, etaMs);

    if (detenerEnPrimerError && task.estado === "Error") {
      ui.log(`⏹ Proceso detenido: hubo un error en [${task.material}].`);
      return;
    }
    await sleep(200);
  }
  ui.log("Proceso finalizado.");
}

async function macroStartRun(tasks) {
  const name = macroEls.templateSelect.value;
  if (!name) {
    macroLog("Selecciona una plantilla guardada antes de iniciar.");
    return;
  }
  const templates = await loadTemplates();
  const steps = templates[name];
  if (!steps || steps.length === 0) {
    macroLog("La plantilla seleccionada no tiene pasos.");
    return;
  }
  if (tasks.length === 0) {
    macroLog("No hay materiales con la columna 'Material' completa en la tabla.");
    return;
  }
  const tab = await getActiveSapTab();
  if (!tab) {
    macroLog("No se detecta ninguna pestaña activa. Abre/enfoca la pestaña de SAP.");
    return;
  }
  if (!tab.url || !tab.url.includes(SAP_HOST)) {
    macroLog("⚠️ Aviso: la pestaña activa no parece ser Fiori/SAP.");
  }

  macroState.stopFlag = false;
  macroSetControlsEnabled(false);
  try {
    await macroRunAutomation(steps, tasks, tab.id, macroEls.detenerCheckbox.checked, {
      log: macroLog,
      setEstado: macroSetEstado,
      stopRequested: () => macroState.stopFlag,
      onProgress: macroUpdateProgress,
    });
  } catch (e) {
    macroLog(`ERROR CRÍTICO: ${e.message}`);
  } finally {
    macroSetControlsEnabled(true);
  }
}

macroEls.startBtn.addEventListener("click", () => macroStartRun(macroCollectTasks()));

macroEls.stopRunBtn.addEventListener("click", () => {
  macroState.stopFlag = true;
  macroLog("Deteniendo tras el material en curso...");
});

macroEls.retryBtn.addEventListener("click", () => {
  for (const tr of Array.from(macroEls.gridBody.children)) {
    if (tr.dataset.estado === "Error") {
      tr.dataset.estado = "Pendiente";
      tr.className = "estado-pendiente";
      tr.querySelector(".estado-cell").textContent = "Pendiente";
      tr.querySelector(".mensaje-cell").textContent = "";
    }
  }
  const tasks = macroCollectTasks();
  if (tasks.filter((t) => t.estado === "Pendiente").length === 0) {
    macroLog("No hay tareas en estado Error para reintentar.");
    return;
  }
  macroStartRun(tasks);
});

// ---------------------------------------------------------------
// Init
// ---------------------------------------------------------------
for (let i = 0; i < 4; i++) macroAddRow();
refreshTemplateSelect();
macroLog("Apartado de grabación listo. Graba una configuración nueva o elige una plantilla guardada.");
