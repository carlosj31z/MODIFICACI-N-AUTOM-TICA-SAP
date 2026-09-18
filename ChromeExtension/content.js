// Content script inyectado en TODOS los frames del dominio Fiori (all_frames:true
// en manifest.json). SAP GUI for HTML embebe la transacción MM02 en <iframe>s
// anidados; en vez de recorrerlos manualmente como hacía Selenium
// (SwitchTo().Frame(...)), cada frame recibe su propia instancia de este script
// y el orquestador (sidepanel.js) hace broadcast del comando a todos los frames
// a la vez — el que tiene el elemento responde ok:true, el resto ok:false.
//
// Selectores y lógica de campos replicados de SapAutomationService.cs, donde
// están confirmados por inspección real del DOM (ver comentarios allí).

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  let style;
  try {
    style = window.getComputedStyle(el);
  } catch {
    return false;
  }
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function xpathAll(expr, root = document) {
  const result = document.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const nodes = [];
  for (let i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
  return nodes;
}

function xpathLiteral(value) {
  const v = String(value);
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  const parts = v.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(", \"'\", ")})`;
}

function nodesFor(sel) {
  return sel.type === "xpath" ? xpathAll(sel.value) : Array.from(document.querySelectorAll(sel.value));
}

function findFirstVisible(selectors, extraCheck) {
  for (const sel of selectors) {
    const found = nodesFor(sel).find((n) => isVisible(n) && (!extraCheck || extraCheck(n)));
    if (found) return found;
  }
  return null;
}

function nativeSetValue(el, value) {
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatchKey(el, key, keyCode, extra) {
  const opts = { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true, ...extra };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

/** Simula: click, borrar, escribir, y confirmar con Enter o Tab — como SendKeys de Selenium. */
function fillAndCommit(el, value, commitKey) {
  el.focus();
  el.click();
  nativeSetValue(el, "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  nativeSetValue(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (commitKey === "Enter") {
    dispatchKey(el, "Enter", 13);
  } else if (commitKey === "Tab") {
    dispatchKey(el, "Tab", 9);
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    el.blur();
  }
}

// ---------------------------------------------------------------
// Selectores (equivalentes a los *_Selectors de SapAutomationService.cs)
// ---------------------------------------------------------------

const MM02_TILE_SELECTORS = [
  { type: "xpath", value: "//a[contains(@href, '#Material-change')]" },
  { type: "xpath", value: "//*[contains(@aria-label, 'MM02')]" },
  { type: "xpath", value: "//*[contains(@aria-label, 'Modificar material')]" },
  {
    type: "xpath",
    value: "//*[@role='link' or @role='button'][contains(., 'Modificar material') or contains(., 'MM02')]",
  },
];

const MATERIAL_FIELD_SELECTORS = [
  { type: "xpath", value: "//input[contains(@data-hint, 'RMMG1-MATNR') or contains(@lsdata, 'RMMG1-MATNR')]" },
  { type: "xpath", value: "//input[contains(translate(@title, 'MATERIAL', 'material'), 'material')]" },
];

const CENTRO_FIELD_SELECTORS = [
  { type: "xpath", value: "//input[contains(@data-hint, 'WERKS') or contains(@lsdata, 'WERKS')]" },
  { type: "xpath", value: "//input[contains(translate(@title, 'CENTRO', 'centro'), 'centro')]" },
];

const SAVE_BUTTON_SELECTORS = [
  { type: "xpath", value: "//*[contains(@data-hint, 'tbar[0]/btn[11]') or contains(@lsdata, 'tbar[0]/btn[11]')]" },
  { type: "xpath", value: "//*[@role='button'][contains(., 'Guardar') or contains(., 'Grabar')]" },
  {
    type: "xpath",
    value:
      "//*[contains(translate(@title, 'GRABARSAVE', 'grabarsave'), 'grabar') or contains(translate(@title, 'GRABARSAVE', 'grabarsave'), 'save')]",
  },
];

const STATUS_SELECTORS = [
  { type: "xpath", value: "//div[contains(@id,'-MESSAGE_AREA')]" },
  { type: "xpath", value: "//span[contains(@id,'-MESSAGE_AREA')]" },
  { type: "css", value: ".sapMMsgStrip" },
  { type: "xpath", value: "//div[@role='status']" },
  { type: "xpath", value: "//div[contains(@class,'lsStatusBarItem')]" },
  { type: "xpath", value: "//div[contains(@class,'urMessageBar')]" },
];

/**
 * Botón "Posicionar" (lupa) de la tabla de características de
 * Clasificación: confirmado por inspección real, su data-hint incluye el
 * campo técnico RCTMS-AUFS (fijo, no depende de la característica que se
 * busque). Abre un diálogo "Posicionar sobre caract." que salta el cursor
 * directo a la fila pedida — mucho más confiable que navegar con flechas.
 */
const POSICIONAR_BUTTON_SELECTORS = [
  { type: "xpath", value: "//*[contains(@data-hint, 'RCTMS-AUFS')]" },
  { type: "xpath", value: "//*[@role='button'][contains(@title, 'Posicionar')]" },
];

// Confirmado por inspección real: el botón "Continuar (Entrada)" del
// diálogo dispara su acción vía lsevents.Press → "GuiOkCodeButton"
// (mecanismo genérico de SAP GUI para el botón de confirmar/Entrada de un
// popup) — más específico y estable que buscar solo por el texto del
// título. Búsqueda global (no acotada a un contenedor), confirmado en
// pruebas reales que encuentra y clica el botón correcto.
const CONTINUAR_BUTTON_SELECTORS = [
  { type: "xpath", value: "//*[contains(@lsevents, 'GuiOkCodeButton')]" },
  { type: "xpath", value: "//*[contains(@title, 'Continuar') or contains(@title, 'Enter')]" },
];

function fieldSelectors(campoTecnico) {
  const lit = xpathLiteral(campoTecnico);
  const cssPart = CSS.escape(campoTecnico);
  return [
    { type: "xpath", value: `//input[contains(@data-hint, ${lit})]` },
    { type: "xpath", value: `//input[contains(@lsdata, ${lit})]` },
    { type: "xpath", value: `//input[contains(@title, ${lit})]` },
    { type: "css", value: `[id*="-${cssPart}"]` },
    { type: "css", value: `[id*="${cssPart}"]` },
  ];
}

// ---------------------------------------------------------------
// Respaldo para tablas de características (p.ej. vista "Clasificación"):
// no son <input> sueltos con data-hint, sino filas de una grilla con una
// celda de etiqueta ("Denom.característica", p.ej. "EVENTO") y una celda
// "Valor" editable al lado. En vez de codificar cada característica, se
// busca la fila cuyo texto de etiqueta coincide con el CampoTecnico y se
// llena el primer <input> editable de esa fila.
// ---------------------------------------------------------------

function findRowContainer(el) {
  return el.closest("tr") || el.closest("[role='row']") || null;
}

function findLabelElement(labelText) {
  const exact = xpathAll(`//*[normalize-space(text())=${xpathLiteral(labelText)}]`);
  const visibleExact = exact.find(isVisible);
  if (visibleExact) return visibleExact;
  const contains = xpathAll(`//*[contains(normalize-space(text()), ${xpathLiteral(labelText)})]`);
  return contains.find(isVisible) || null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function findRowInputFor(labelText) {
  const labelEl = findLabelElement(labelText);
  if (!labelEl) return null;
  const row = findRowContainer(labelEl);
  if (!row) return null;
  const inputs = Array.from(row.querySelectorAll("input")).filter(
    (n) => isVisible(n) && !n.disabled && n.type !== "checkbox"
  );
  return inputs[0] || null;
}

/**
 * Sube desde el título del diálogo hasta encontrar el contenedor que
 * envuelve su campo de texto — evita confiar en document.activeElement
 * (que puede no apuntar realmente al diálogo) o en encontrar un input
 * equivocado en otra parte de la página. Solo exige el input (no también
 * el botón Continuar en el mismo nodo: eso causaba falsos positivos que
 * aceptaban un contenedor que en realidad no incluía el botón real).
 */
function findDialogInput(titleText, maxLevels = 12) {
  const titleEl = findLabelElement(titleText);
  if (!titleEl) return null;
  let node = titleEl;
  for (let i = 0; i < maxLevels && node; i++) {
    if (node.querySelectorAll) {
      const input = Array.from(node.querySelectorAll('input[type="text"]')).find((n) => isVisible(n) && !n.disabled);
      if (input) return input;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Usa el botón nativo "Posicionar" (lupa) de la tabla de características
 * para saltar directo a la fila pedida, en vez de navegar a ciegas.
 */
async function tryPositionSearch(labelText) {
  const btn = findFirstVisible(POSICIONAR_BUTTON_SELECTORS);
  if (!btn) return { ok: false, trace: "Posicionar: botón (lupa) no encontrado." };
  btn.click();

  let input = null;
  for (let i = 0; i < 8 && !input; i++) {
    await delay(200);
    input = findDialogInput("Posicionar sobre caract.");
  }
  if (!input) {
    return { ok: false, trace: "Posicionar: se hizo click en la lupa pero no apareció el diálogo 'Posicionar sobre caract.' con un campo de texto." };
  }

  // Tab (no null): además de escribir, dispara blur/focusout — SAP parece
  // necesitar que el campo pierda el foco para registrar internamente el
  // valor antes de aceptar el click en Continuar (si no, el diálogo lo
  // trata como vacío aunque el DOM ya muestre el texto escrito).
  fillAndCommit(input, labelText, "Tab");
  await delay(400);

  // Verificar que de verdad quedó escrito antes de confirmar — si no, es
  // mejor abortar (y usar el respaldo de flechas) que confirmar un
  // diálogo vacío.
  if (input.value !== labelText) {
    return { ok: false, trace: `Posicionar: el campo de texto no aceptó el valor (quedó '${input.value}').` };
  }

  // Búsqueda global del botón (no acotada al mismo contenedor que el
  // input): confirmado en pruebas reales que sí lo encuentra y lo clica.
  const continuar = findFirstVisible(CONTINUAR_BUTTON_SELECTORS);
  if (continuar) continuar.click();
  else dispatchKey(input, "Enter", 13);

  await delay(700);
  return {
    ok: true,
    trace: `Posicionar: escribió '${labelText}' y ${continuar ? "clicó Continuar" : "presionó Enter (no se encontró el botón Continuar)"}.`,
  };
}

/**
 * La tabla de características de "Clasificación" es virtualizada: SAP solo
 * crea en el DOM las filas que están dentro del área visible, y —
 * confirmado por pruebas reales — SOLO la fila con el foco de teclado real
 * tiene un <input> editable; el resto de filas visibles muestran su valor
 * como texto plano. Se intenta primero el botón "Posicionar" (rápido y
 * confiable); si no existe o no funciona, se navega con flecha abajo —
 * igual que haría una persona —, siguiendo en cada paso el foco real que
 * SAP mueve (document.activeElement), no una referencia vieja.
 */
async function findClassificationValueInputAsync(labelText, maxSteps = 45, stepDelay = 150) {
  const trace = [];
  let found = findRowInputFor(labelText);
  if (found) return { input: found, trace };

  const posResult = await tryPositionSearch(labelText);
  trace.push(posResult.trace);
  if (posResult.ok) {
    found = findRowInputFor(labelText);
    if (found) return { input: found, trace };
    for (let i = 0; i < 5; i++) {
      await delay(150);
      found = findRowInputFor(labelText);
      if (found) return { input: found, trace };
    }
    trace.push("Posicionar: se ejecutó pero la fila sigue sin <input> editable después de esperar.");
  }

  // Respaldo: navegación con flecha abajo si el botón "Posicionar" no
  // existe o no funcionó.
  trace.push("Respaldo: navegando con flecha abajo...");
  // Ancla: cualquier fila de la tabla de características ya renderizada
  // (confirmado por inspección real: estas filas llevan el atributo iidx).
  let anchorRow = document.querySelector("tr[iidx]");
  for (let i = 0; i < 10 && !anchorRow; i++) {
    await delay(200);
    anchorRow = document.querySelector("tr[iidx]");
  }
  if (!anchorRow) return { input: null, trace };

  let focusTarget = anchorRow.querySelector("input, [tabindex]") || anchorRow;
  try {
    focusTarget.focus();
  } catch {
    // Si no se puede enfocar, se sigue igual: dispatchKey despacha el
    // evento sobre el elemento de todas formas.
  }
  await delay(stepDelay);

  for (let i = 0; i < maxSteps; i++) {
    found = findRowInputFor(labelText);
    if (found) return { input: found, trace };
    dispatchKey(focusTarget, "ArrowDown", 40);
    await delay(stepDelay);
    // Seguir el foco real que SAP haya movido, no quedarse en la
    // referencia del primer elemento (si no, el "cursor" nunca avanza).
    if (document.activeElement && document.activeElement !== document.body) {
      focusTarget = document.activeElement;
    }
  }
  return { input: findRowInputFor(labelText), trace };
}

// ---------------------------------------------------------------
// Manejo de mensajes: un intento (sin reintentos ni timeouts, eso vive en
// sidepanel.js) por comando.
// ---------------------------------------------------------------

async function handleMessage(msg, sendResponse) {
  switch (msg.type) {
    case "PING": {
      sendResponse({ ok: true, url: location.href });
      break;
    }
    case "CLICK_TILE": {
      const el = findFirstVisible(MM02_TILE_SELECTORS);
      if (el) {
        el.click();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "CLICK_HOME": {
      const el = document.getElementById("homeBtn");
      if (el && isVisible(el)) {
        el.click();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "ENTER_MATERIAL": {
      const el = findFirstVisible(MATERIAL_FIELD_SELECTORS);
      if (el) {
        fillAndCommit(el, msg.material, "Enter");
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "SELECT_VIEW": {
      const xp = `//tbody//tr[contains(., ${xpathLiteral(msg.prefix)})]`;
      const row = findFirstVisible([{ type: "xpath", value: xp }]);
      if (!row) {
        sendResponse({ ok: false });
        break;
      }
      row.click();
      const checkBtn = findFirstVisible([
        { type: "xpath", value: "//div[contains(@title, 'Continuar') or contains(@title, 'Enter')]" },
      ]);
      if (checkBtn) checkBtn.click();
      else dispatchKey(row, "Enter", 13);
      sendResponse({ ok: true });
      break;
    }
    case "ENTER_CENTRO": {
      const el = findFirstVisible(CENTRO_FIELD_SELECTORS);
      if (el) {
        fillAndCommit(el, msg.centro, "Enter");
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "SWITCH_TAB": {
      const xp = `//*[contains(@class, 'lsTabStrip--item-text')][contains(., ${xpathLiteral(msg.vista)})]`;
      const tab = findFirstVisible([{ type: "xpath", value: xp }]);
      if (tab) {
        tab.click();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "FILL_FIELD": {
      const selectors = fieldSelectors(msg.campoTecnico);
      const target = findFirstVisible(selectors, (n) => !n.disabled);
      if (target) {
        fillAndCommit(target, msg.valor, "Tab");
        sendResponse({ ok: true });
        break;
      }
      // No es un <input> con data-hint/lsdata/title/id reconocible (p.ej.
      // campos normales de MM02); probar como fila de tabla de
      // características (vista "Clasificación"): botón "Posicionar" y, si
      // no funciona, navegación con flecha abajo.
      const { input: rowInput, trace } = await findClassificationValueInputAsync(msg.campoTecnico);
      if (rowInput) {
        fillAndCommit(rowInput, msg.valor, "Tab");
        sendResponse({ ok: true });
        break;
      }
      // Diagnóstico: cuántas coincidencias hay para el selector principal
      // (aunque no sean usables), más la traza de lo que se intentó en la
      // tabla de características, para depurar sin abrir DevTools.
      const primary = selectors[0];
      const diagnostics = nodesFor(primary).map(
        (n) => `id='${n.id || ""}' Displayed=${isVisible(n)} Enabled=${!n.disabled}`
      );
      diagnostics.push(...trace);
      const labelEl = findLabelElement(msg.campoTecnico);
      diagnostics.push(
        labelEl
          ? `Etiqueta '${msg.campoTecnico}' encontrada pero sin <input> editable en su fila.`
          : `Ninguna etiqueta de tabla coincide con '${msg.campoTecnico}'.`
      );
      sendResponse({ ok: false, diagnostics });
      break;
    }
    case "SAVE": {
      const btn = findFirstVisible(SAVE_BUTTON_SELECTORS);
      if (btn) {
        btn.click();
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      break;
    }
    case "SAVE_SHORTCUT": {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true, bubbles: true })
      );
      sendResponse({ ok: true });
      break;
    }
    case "READ_STATUS": {
      let responded = false;
      outer: for (const sel of STATUS_SELECTORS) {
        for (const el of nodesFor(sel)) {
          const text = (el.textContent || "").trim();
          if (!text) continue;
          const cls = String(el.className || "");
          const looksError = /error/i.test(cls) || /^error/i.test(text);
          sendResponse({ ok: true, text, isError: looksError });
          responded = true;
          break outer;
        }
      }
      if (!responded) sendResponse({ ok: false });
      break;
    }
    case "ESCAPE": {
      dispatchKey(document.body, "Escape", 27);
      sendResponse({ ok: true });
      break;
    }
    case "START_RECORDING": {
      startRecording();
      chrome.storage.local.set({ macroRecordingActive: true });
      sendResponse({ ok: true });
      break;
    }
    case "STOP_RECORDING": {
      stopRecording();
      chrome.storage.local.set({ macroRecordingActive: false });
      sendResponse({ ok: true });
      break;
    }
    case "EXECUTE_STEP": {
      const result = await executeRecordedStep(msg.step, msg.overrideValue, msg.dryRun);
      sendResponse(result);
      break;
    }
    default:
      sendResponse({ ok: false, error: "Acción desconocida: " + msg.type });
  }
}

// =================================================================
// GRABADORA (apartado nuevo, independiente de todo lo anterior): permite
// grabar CUALQUIER click/cambio de campo que haga el usuario a mano, en
// cualquier vista de MM01 o MM02, extrayendo un identificador reutilizable
// (nombre técnico del campo, o etiqueta de fila para tablas tipo
// Clasificación) para poder reproducir la misma secuencia luego sobre
// otros materiales. No modifica ni reemplaza nada de lo de arriba: los
// mensajes FILL_FIELD/CLICK_TILE/etc. de "Modificar material" siguen
// intactos.
// =================================================================

/** Busca en un string crudo (data-hint o lsdata) el patrón TABLA-CAMPO que
 * SAP usa para nombrar técnicamente sus campos (ej. RMMG1-MATNR,
 * RCTMS-MWERT). Se opera sobre el string crudo del atributo (no hace falta
 * parsear el JSON: el nombre del campo queda intacto como texto plano
 * incluso dentro de JSON anidado/escapado). */
function extractTechFieldFromAttr(raw) {
  if (!raw) return null;
  // Prioridad 1: patrón ".../ctxtTABLA-CAMPO[fila,col]" (campo de tabla).
  let m = raw.match(/([A-Z][A-Z0-9_]{2,9}-[A-Z][A-Z0-9_]{1,25})(?=\[)/);
  if (m) return m[1];
  // Prioridad 2: patrón suelto TABLA-CAMPO (campo normal, sin corchetes).
  m = raw.match(/\b([A-Z][A-Z0-9_]{2,9}-[A-Z][A-Z0-9_]{1,25})\b/);
  return m ? m[1] : null;
}

function extractTechnicalField(el) {
  const dataHint = el.getAttribute("data-hint") || "";
  const lsdata = el.getAttribute("lsdata") || "";
  return extractTechFieldFromAttr(dataHint) || extractTechFieldFromAttr(lsdata);
}

/** Para filas de tabla (Clasificación y similares): el texto de la celda
 * que NO es la celda del propio campo suele ser la etiqueta ("EVENTO",
 * "ORIGEN_MATERIAL", etc.) — igual lógica que ya usa findRowInputFor pero
 * a la inversa (dado el input, encontrar su etiqueta). */
function getRowLabelText(row, valueEl) {
  const cells = Array.from(row.children).filter((c) => c.tagName === "TD");
  const valueCell = valueEl.closest("td");
  const labelCell = cells.find((td) => td !== valueCell && td.textContent.trim().length > 0);
  return labelCell ? labelCell.textContent.trim() : null;
}

/** Identifica un <input>/<textarea> que el usuario acaba de editar:
 * preferencia por etiqueta de fila (más estable en tablas virtualizadas
 * como Clasificación, donde el nombre técnico es el mismo para toda fila),
 * si no hay fila reconocible cae al nombre técnico. */
function describeFieldElement(el) {
  const row = el.closest("tr");
  if (row) {
    const label = getRowLabelText(row, el);
    if (label) return { kind: "tableField", label };
  }
  const tech = extractTechnicalField(el);
  if (tech) return { kind: "field", tech };
  return null;
}

/** Identifica qué clicó el usuario: tile del Launchpad, pestaña de vista,
 * botón Grabar, fila (selección de vistas, resultados de Posicionar), o
 * botón genérico — en ese orden de especificidad. */
function describeClickTarget(el) {
  const tile = el.closest("a[href*='#']");
  if (tile) {
    const href = tile.getAttribute("href") || "";
    const hashMatch = href.match(/#([^?]+)/);
    const label = (tile.getAttribute("aria-label") || tile.title || tile.textContent || "").trim();
    if (label || hashMatch) return { kind: "tile", label: label.slice(0, 80), hash: hashMatch ? hashMatch[1] : href };
  }

  const tab = el.closest("[class*='lsTabStrip']");
  if (tab) {
    const text = tab.textContent.trim();
    if (text) return { kind: "tab", label: text.slice(0, 80) };
  }

  const hintBlob = (el.getAttribute("data-hint") || "") + (el.getAttribute("lsdata") || "");
  const title = el.getAttribute("title") || el.getAttribute("aria-label") || "";
  if (/tbar\[0\]\/btn\[11\]/.test(hintBlob) || /Grabar|Guardar|Save/i.test(title)) {
    return { kind: "save", label: "Grabar" };
  }

  const row = el.closest("tr");
  if (row) {
    const text = row.textContent.trim();
    if (text) return { kind: "row", label: text.slice(0, 80) };
  }

  const label = title || el.textContent.trim();
  if (label) return { kind: "button", label: label.slice(0, 60) };
  return null;
}

let recordingActive = false;
const recordedValueByEl = new WeakMap();

function onRecordClick(e) {
  if (!recordingActive) return;
  const el = e.target;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return; // los inputs se capturan por 'change'
  const desc = describeClickTarget(el);
  if (!desc) return;
  try {
    chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: desc.kind === "save" ? "click" : "click", ...desc } });
  } catch {
    // El panel puede no estar escuchando en este instante; se ignora.
  }
}

function onRecordChange(e) {
  if (!recordingActive) return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return;
  if (el.type === "checkbox" || el.type === "radio") {
    const row = el.closest("tr");
    const label = row ? row.textContent.trim() : el.getAttribute("title") || el.getAttribute("aria-label") || "";
    if (!label) return;
    try {
      chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: "check", label: label.slice(0, 80), checked: el.checked } });
    } catch {
      /* panel no escuchando */
    }
    return;
  }
  const desc = describeFieldElement(el);
  if (!desc) return;
  // Evita registrar dos veces el mismo valor si el 'change' se dispara más
  // de una vez sin que el usuario haya vuelto a tocar el campo.
  if (recordedValueByEl.get(el) === el.value) return;
  recordedValueByEl.set(el, el.value);
  try {
    chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: "fill", ...desc, value: el.value } });
  } catch {
    /* panel no escuchando */
  }
}

/**
 * SAP GUI for HTML procesa la tecla Enter directamente (dispara su propio
 * round-trip/recarga de pantalla) y a veces eso interrumpe el ciclo normal
 * de blur→'change' del navegador antes de que llegue a dispararse — por
 * eso un campo confirmado con Enter (en vez de Tab o click en otro lado)
 * podía perderse en la grabación. Aquí se captura el valor en el momento
 * del keydown, ANTES de que SAP reaccione. También se detecta Ctrl+S como
 * atajo de Grabar, por si el usuario no clica el botón con el mouse.
 */
function onRecordKeydown(e) {
  if (!recordingActive) return;
  const el = e.target;

  if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    try {
      chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: "click", kind: "save", label: "Grabar (Ctrl+S)" } });
    } catch {
      /* panel no escuchando */
    }
    return;
  }

  if (e.key !== "Enter") return;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.type === "checkbox" || el.type === "radio") return; // esos van por 'change'
    const desc = describeFieldElement(el);
    if (!desc) return;
    if (recordedValueByEl.get(el) === el.value) return; // ya registrado (p.ej. por 'change')
    recordedValueByEl.set(el, el.value);
    try {
      chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: "fill", ...desc, value: el.value } });
    } catch {
      /* panel no escuchando */
    }
    return;
  }

  // Enter fuera de un campo de texto (p.ej. una fila de diálogo con foco):
  // equivale a un click sobre lo que tenga el foco en ese momento.
  const desc = describeClickTarget(el);
  if (!desc) return;
  try {
    chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { action: "click", ...desc } });
  } catch {
    /* panel no escuchando */
  }
}

function startRecording() {
  if (recordingActive) return;
  recordingActive = true;
  document.addEventListener("click", onRecordClick, true);
  document.addEventListener("change", onRecordChange, true);
  document.addEventListener("keydown", onRecordKeydown, true);
}

function stopRecording() {
  recordingActive = false;
  document.removeEventListener("click", onRecordClick, true);
  document.removeEventListener("change", onRecordChange, true);
  document.removeEventListener("keydown", onRecordKeydown, true);
}

/** Ejecuta un paso grabado (reproducción). Reutiliza fieldSelectors,
 * findClassificationValueInputAsync, SAVE_BUTTON_SELECTORS, etc. — la misma
 * lógica ya probada del apartado "Modificar material", solo que ahora
 * parametrizada por lo que quedó grabado en vez de un campo fijo. */
/**
 * @param {boolean} dryRun Modo prueba: los pasos de navegación (tile,
 * pestaña, fila de diálogo) SÍ se clican de verdad (hace falta para poder
 * validar los pasos siguientes, que dependen de estar en la pantalla
 * correcta), pero los pasos que escriben datos (fill/check) solo
 * VERIFICAN que el campo existe sin modificarlo, y "Grabar" nunca se
 * clica — así no se guarda ningún cambio real en SAP.
 */
async function executeRecordedStep(step, overrideValue, dryRun = false) {
  const value = overrideValue !== undefined && overrideValue !== null ? overrideValue : step.value;
  if (step.action === "fill") {
    if (step.kind === "field") {
      const el = findFirstVisible(fieldSelectors(step.tech), (n) => !n.disabled);
      if (!el) return { ok: false, trace: `No se encontró el campo técnico '${step.tech}'.` };
      if (dryRun) return { ok: true, trace: `Campo '${step.tech}' encontrado (valor actual: '${el.value}'). No se modificó (modo prueba).` };
      fillAndCommit(el, value, "Tab");
      return { ok: true };
    }
    if (step.kind === "tableField") {
      const { input, trace } = await findClassificationValueInputAsync(step.label);
      if (!input) return { ok: false, trace: `No se encontró la fila '${step.label}'. ${trace.join(" | ")}` };
      if (dryRun) return { ok: true, trace: `Fila '${step.label}' encontrada (valor actual: '${input.value}'). No se modificó (modo prueba).` };
      fillAndCommit(input, value, "Tab");
      return { ok: true };
    }
    return { ok: false, trace: "Paso 'fill' sin campo reconocible." };
  }
  if (step.action === "check") {
    const xp = `//tr[contains(., ${xpathLiteral(step.label.slice(0, 30))})]//input[@type='checkbox']`;
    const el = findFirstVisible([{ type: "xpath", value: xp }]);
    if (!el) return { ok: false, trace: `No se encontró el checkbox de '${step.label}'.` };
    if (dryRun) return { ok: true, trace: `Checkbox de '${step.label}' encontrado (estado actual: ${el.checked ? "marcado" : "desmarcado"}). No se modificó (modo prueba).` };
    if (el.checked !== step.checked) el.click();
    return { ok: true };
  }
  if (step.action === "click") {
    switch (step.kind) {
      case "tile": {
        const selectors = [
          { type: "xpath", value: `//a[contains(@href, ${xpathLiteral(step.hash || "")})]` },
          { type: "xpath", value: `//*[contains(@aria-label, ${xpathLiteral(step.label || "")})]` },
        ];
        const el = findFirstVisible(selectors);
        if (!el) return { ok: false, trace: `No se encontró el tile '${step.label}'.` };
        el.click(); // navegación: se clica igual en modo prueba (no escribe datos)
        return { ok: true };
      }
      case "tab": {
        const xp = `//*[contains(@class, 'lsTabStrip')][contains(., ${xpathLiteral(step.label)})]`;
        const el = findFirstVisible([{ type: "xpath", value: xp }]);
        if (!el) return { ok: false, trace: `No se encontró la pestaña '${step.label}'.` };
        el.click(); // navegación: se clica igual en modo prueba
        return { ok: true };
      }
      case "row": {
        const prefix = step.label.slice(0, 30);
        const xp = `//tr[contains(., ${xpathLiteral(prefix)})]`;
        const el = findFirstVisible([{ type: "xpath", value: xp }]);
        if (!el) return { ok: false, trace: `No se encontró la fila '${prefix}'.` };
        el.click(); // navegación (p.ej. selección de vista): se clica igual en modo prueba
        return { ok: true };
      }
      case "save": {
        const el = findFirstVisible(SAVE_BUTTON_SELECTORS);
        if (!el) return { ok: false, trace: "No se encontró el botón Grabar." };
        if (dryRun) return { ok: true, trace: "Botón Grabar encontrado. NO se presionó (modo prueba)." };
        el.click();
        return { ok: true };
      }
      default: {
        const xp = `//*[contains(@title, ${xpathLiteral(step.label)}) or contains(@aria-label, ${xpathLiteral(step.label)}) or normalize-space(text())=${xpathLiteral(step.label)}]`;
        const el = findFirstVisible([{ type: "xpath", value: xp }]);
        if (!el) return { ok: false, trace: `No se encontró el botón '${step.label}'.` };
        el.click(); // botón genérico (p.ej. "Posicionar", "Continuar"): se clica igual en modo prueba
        return { ok: true };
      }
    }
  }
  return { ok: false, trace: `Acción de paso desconocida: ${step.action}.` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  Promise.resolve(handleMessage(msg, sendResponse)).catch((e) => {
    try {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    } catch {
      // El canal ya se cerró (por ejemplo, la pestaña navegó); no hay nada más que hacer.
    }
  });
  return true; // mantiene el canal abierto para la respuesta asíncrona
});

// Si un frame NUEVO aparece durante una grabación en curso (p.ej. el
// <iframe> de la transacción que se crea al abrir un tile desde el
// Launchpad), este frame arranca sin haber recibido el START_RECORDING —
// por eso se consulta el flag persistido apenas carga, para sumarse solo.
try {
  chrome.storage.local.get("macroRecordingActive", (data) => {
    if (data && data.macroRecordingActive) startRecording();
  });
} catch {
  // chrome.storage no disponible en este contexto; sin grabación entre
  // navegaciones, pero el resto de la extensión sigue funcionando normal.
}
