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
    case "MATCH_STEP": {
      // Fase 1 de la reproducción exacta: este frame busca el elemento del
      // paso y devuelve QUÉ TAN BIEN calza (puntaje), sin tocar nada. El
      // orquestador compara los puntajes de todos los frames y solo manda
      // ejecutar al que mejor calzó — así no se ejecuta en el frame
      // equivocado ni dos veces.
      const result = await matchRecordedStep(msg.step);
      sendResponse(result);
      break;
    }
    case "RUN_MATCHED": {
      // Fase 2: ejecuta sobre el elemento que este mismo frame ya localizó
      // en la fase de match (referenciado por token), sin volver a buscar.
      const result = await runMatchedStep(msg.token, msg.step, msg.overrideValue, msg.dryRun);
      sendResponse(result);
      break;
    }
    default:
      sendResponse({ ok: false, error: "Acción desconocida: " + msg.type });
  }
}

// =================================================================
// GRABADORA (apartado nuevo, independiente de todo lo anterior): graba
// CUALQUIER click, doble click, tecla o cambio de campo que haga el
// usuario a mano, en cualquier vista de MM01 o MM02, y lo reproduce
// después sobre otros materiales. No modifica ni reemplaza nada de lo de
// arriba: los mensajes FILL_FIELD/CLICK_TILE/etc. de "Modificar material"
// siguen intactos.
//
// IDENTIFICACIÓN EXACTA: en vez de reducir cada elemento a una etiqueta
// (ambiguo), se captura una HUELLA completa. La pieza clave es el SID —
// la ruta canónica de SAP GUI que viene dentro de lsdata/data-hint, del
// tipo "wnd[0]/usr/subSUBSCR_BEWERT:SAPLCTMS:5000/.../ctxtRCTMS-MWERT[1,8]".
// Es el mismo identificador que usa SAP GUI Scripting, así que cuando
// está disponible el match es exacto, no heurístico. Al reproducir, cada
// frame puntúa sus candidatos contra la huella y solo actúa el que mejor
// calza (ver MATCH_STEP / RUN_MATCHED).
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

/** Extrae el SID: la ruta canónica de SAP GUI ("wnd[0]/usr/..."), que
 * aparece tanto en lsdata (campos) como en data-hint (botones). Es el
 * identificador más exacto disponible. */
function extractSid(el) {
  const blob = (el.getAttribute("lsdata") || "") + " " + (el.getAttribute("data-hint") || "");
  const m = blob.match(/wnd\[\d+\][^"\\]*/);
  return m ? m[0] : null;
}

/** El SID sin las coordenadas finales [fila,col]: identifica el control
 * dentro de la pantalla sin atarse a la posición visible del scroll (las
 * tablas virtualizadas cambian esas coordenadas según lo que esté a la
 * vista). */
function sidWithoutCoords(sid) {
  return sid ? sid.replace(/\[\d+,\d+\]\s*$/, "") : null;
}

/** Programa:pantalla:transacción (ej. "SAPLCLFM:1101:MM02"), dentro de
 * data-hint. Sirve para confirmar que estamos en la misma pantalla. */
function extractDynp(el) {
  const hint = el.getAttribute("data-hint") || "";
  const m = hint.match(/"dynp"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Para filas de tabla (Clasificación y similares): el texto de la celda
 * que NO es la celda del propio campo suele ser la etiqueta ("EVENTO",
 * "ORIGEN_MATERIAL", etc.). */
function getRowLabelText(row, valueEl) {
  const cells = Array.from(row.children).filter((c) => c.tagName === "TD");
  const valueCell = valueEl.closest ? valueEl.closest("td") : null;
  const labelCell = cells.find((td) => td !== valueCell && td.textContent.trim().length > 0);
  return labelCell ? labelCell.textContent.trim() : null;
}

/** ¿Está dentro de una tabla REALMENTE virtualizada? El discriminador
 * confirmado por inspección es el atributo `iidx` en la fila: solo lo
 * tienen los controles de tabla dinámicos de SAP. Muchas pantallas usan
 * <table> nada más para alinear campos normales, y ahí el nombre técnico
 * sí es único y confiable. */
function virtualizedRowOf(el) {
  const row = el.closest ? el.closest("tr") : null;
  return row && row.hasAttribute("iidx") ? row : null;
}

const SEMANTIC_CLASS_RE = /^(ls|ur)[A-Za-z]/;

/**
 * Huella completa de un elemento: todas las señales disponibles, para
 * poder comparar candidatos por puntaje al reproducir en vez de
 * quedarnos con "el primero que calce más o menos".
 */
function fingerprintOf(el) {
  if (!el || el.nodeType !== 1) return {};
  const sid = extractSid(el);
  const vRow = virtualizedRowOf(el);
  const row = el.closest ? el.closest("tr") : null;
  const classes = String(el.className || "")
    .split(/\s+/)
    .filter((c) => SEMANTIC_CLASS_RE.test(c))
    .slice(0, 6);
  return {
    sid,
    sidBase: sidWithoutCoords(sid),
    dynp: extractDynp(el),
    tech: extractTechnicalField(el),
    elId: el.id || null,
    tag: el.tagName,
    type: el.getAttribute("type") || null,
    name: el.getAttribute("name") || null,
    role: el.getAttribute("role") || null,
    title: (el.getAttribute("title") || "").trim() || null,
    ariaLabel: (el.getAttribute("aria-label") || "").trim() || null,
    text: (el.textContent || "").trim().slice(0, 80) || null,
    href: el.getAttribute("href") || null,
    inVirtualTable: !!vRow,
    rowLabel: row ? getRowLabelText(row, el) : null,
    classes,
  };
}

/** Puntaje de qué tan bien un candidato calza con la huella grabada. */
function scoreCandidate(el, fp) {
  const c = fingerprintOf(el);
  let s = 0;
  if (fp.sid && c.sid && c.sid === fp.sid) s += 100;
  else if (fp.sidBase && c.sidBase && c.sidBase === fp.sidBase) s += 55;
  if (fp.tech && c.tech === fp.tech) s += 25;
  if (fp.dynp && c.dynp === fp.dynp) s += 10;
  if (fp.elId && c.elId === fp.elId) s += 15;
  if (fp.rowLabel && c.rowLabel && c.rowLabel === fp.rowLabel) s += 40;
  if (fp.href && c.href && c.href === fp.href) s += 35;
  if (fp.title && c.title === fp.title) s += 20;
  if (fp.ariaLabel && c.ariaLabel === fp.ariaLabel) s += 18;
  if (fp.text && c.text === fp.text) s += 15;
  if (fp.role && c.role === fp.role) s += 5;
  if (fp.tag && c.tag === fp.tag) s += 5;
  if (fp.type && c.type === fp.type) s += 4;
  if (fp.name && c.name === fp.name) s += 3;
  if (fp.classes && fp.classes.length && c.classes) {
    const shared = fp.classes.filter((x) => c.classes.includes(x)).length;
    s += Math.min(shared * 2, 8);
  }
  if (!isVisible(el)) s -= 60;
  if (el.disabled) s -= 30;
  return s;
}

const MATCH_MIN_SCORE = 35;

/** Reúne candidatos plausibles por cada señal disponible de la huella. */
function collectCandidates(fp) {
  const set = new Set();
  const add = (nodes) => {
    for (const n of nodes) if (n && n.nodeType === 1) set.add(n);
  };
  if (fp.sid) add(xpathAll(`//*[contains(@lsdata, ${xpathLiteral(fp.sid)}) or contains(@data-hint, ${xpathLiteral(fp.sid)})]`));
  if (fp.sidBase) add(xpathAll(`//*[contains(@lsdata, ${xpathLiteral(fp.sidBase)}) or contains(@data-hint, ${xpathLiteral(fp.sidBase)})]`));
  if (fp.tech) add(xpathAll(`//*[contains(@lsdata, ${xpathLiteral(fp.tech)}) or contains(@data-hint, ${xpathLiteral(fp.tech)})]`));
  if (fp.elId) {
    const byId = document.getElementById(fp.elId);
    if (byId) set.add(byId);
  }
  if (fp.href) add(xpathAll(`//*[contains(@href, ${xpathLiteral(fp.href)})]`));
  if (fp.title) add(xpathAll(`//*[@title=${xpathLiteral(fp.title)}]`));
  if (fp.ariaLabel) add(xpathAll(`//*[@aria-label=${xpathLiteral(fp.ariaLabel)}]`));
  if (fp.text) {
    add(xpathAll(`//*[normalize-space(text())=${xpathLiteral(fp.text)}]`));
    add(xpathAll(`//*[contains(@class,'lsTabStrip')][contains(., ${xpathLiteral(fp.text)})]`));
  }
  if (fp.rowLabel) add(xpathAll(`//tr[contains(., ${xpathLiteral(fp.rowLabel)})]`));
  return [...set];
}

/** Mejor candidato del frame para una huella: devuelve {el, score}. */
function bestMatchFor(fp) {
  let best = null;
  let bestScore = -Infinity;
  for (const el of collectCandidates(fp)) {
    const s = scoreCandidate(el, fp);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  return { el: best, score: bestScore === -Infinity ? 0 : bestScore };
}

// ---------------------------------------------------------------
// Captura de acciones del usuario
// ---------------------------------------------------------------

let recordingActive = false;
const recordedValueByEl = new WeakMap();

function sendStep(step) {
  try {
    chrome.runtime.sendMessage({ type: "RECORDED_STEP", step: { ...step, t: Date.now() } });
  } catch {
    // El panel puede no estar escuchando en este instante; se ignora.
  }
}

/** Etiqueta legible del elemento, solo para mostrar en la tabla de pasos. */
function humanLabelFor(el, fp) {
  if (fp.rowLabel && fp.inVirtualTable) return fp.rowLabel;
  return fp.title || fp.ariaLabel || fp.rowLabel || (fp.text || "").slice(0, 60) || fp.tech || fp.elId || fp.tag;
}

/** Clasificación gruesa (solo para que el paso se describa bien en la UI y
 * para elegir la estrategia de búsqueda en tablas virtualizadas). */
function kindOf(el, fp) {
  if (fp.inVirtualTable) return "tableField";
  if (el.closest && el.closest("a[href*='#']")) return "tile";
  if (el.closest && el.closest("[class*='lsTabStrip']")) return "tab";
  const blob = (el.getAttribute("data-hint") || "") + (el.getAttribute("lsdata") || "");
  if (/tbar\[0\]\/btn\[11\]/.test(blob) || /Grabar|Guardar|Save/i.test(fp.title || "")) return "save";
  if (fp.tech) return "field";
  if (el.closest && el.closest("tr")) return "row";
  return "button";
}

/**
 * Al clicar un ícono, e.target suele ser un <svg>/<span> interno sin
 * identidad propia; la identidad real (data-hint/lsdata con el SID, el
 * role, el href) vive en el contenedor. Sube hasta el primer ancestro que
 * sí tenga con qué identificarse — sin esto, el click en la lupa
 * "Posicionar" se grababa como un <svg> anónimo imposible de reencontrar.
 */
function actionableAncestor(el) {
  let node = el;
  for (let i = 0; i < 6 && node && node.nodeType === 1; i++) {
    const hasIdentity =
      extractSid(node) ||
      node.getAttribute("role") === "button" ||
      node.getAttribute("role") === "link" ||
      (node.tagName === "A" && node.getAttribute("href")) ||
      node.getAttribute("title") ||
      node.getAttribute("aria-label");
    if (hasIdentity) return node;
    node = node.parentElement;
  }
  return el;
}

function recordInteraction(el, action, extra) {
  if (!el || el.nodeType !== 1) return;
  const fp = fingerprintOf(el);
  const kind = kindOf(el, fp);
  sendStep({
    action,
    kind,
    fp,
    label: humanLabelFor(el, fp),
    tech: fp.tech || undefined,
    ...extra,
  });
}

function onRecordClick(e) {
  if (!recordingActive) return;
  const el = e.target;
  // Los campos no se graban al clicarlos (eso solo posiciona el cursor):
  // el dato real se captura al confirmarlos (change/focusout/Enter), y los
  // checkbox/radio por su evento 'change'.
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
  recordInteraction(actionableAncestor(el), "click", { clickType: "single" });
}

function onRecordDblClick(e) {
  if (!recordingActive) return;
  // SAP usa doble click como acción propia (p.ej. lsevents DoubleClick en
  // las etiquetas de características), así que se graba aparte.
  recordInteraction(actionableAncestor(e.target), "click", { clickType: "double" });
}

function onRecordChange(e) {
  if (!recordingActive) return;
  const el = e.target;
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
  if (!isField) return;

  if (el.type === "checkbox" || el.type === "radio") {
    const fp = fingerprintOf(el);
    sendStep({
      action: "check",
      kind: "check",
      fp,
      label: humanLabelFor(el, fp),
      checked: el.checked,
    });
    return;
  }

  // Evita registrar dos veces el mismo valor cuando llegan varios eventos
  // (change + focusout + Enter) sin que el usuario haya vuelto a escribir.
  if (recordedValueByEl.get(el) === el.value) return;
  recordedValueByEl.set(el, el.value);
  recordInteraction(el, "fill", { value: el.value });
}

/** Teclas que en SAP son acciones reales (no texto): F1–F12, Escape,
 * navegación, y cualquier combinación con Ctrl/Alt/Meta. Se graban tal
 * cual para poder reproducirlas idénticas. */
function isFunctionalKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  if (/^F\d{1,2}$/.test(e.key)) return true;
  return [
    "Escape",
    "Enter",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Insert",
    "Delete",
  ].includes(e.key);
}

function onRecordKeydown(e) {
  if (!recordingActive) return;
  const el = e.target;
  const isTextField =
    (el instanceof HTMLInputElement && el.type !== "checkbox" && el.type !== "radio") || el instanceof HTMLTextAreaElement;

  // Enter dentro de un campo: SAP procesa el Enter directamente (dispara su
  // propio round-trip) y eso puede saltarse el 'change' nativo antes de que
  // llegue a dispararse — se captura el valor AQUÍ, antes de que pase.
  if (e.key === "Enter" && isTextField && recordedValueByEl.get(el) !== el.value) {
    recordedValueByEl.set(el, el.value);
    recordInteraction(el, "fill", { value: el.value });
  }

  // Tab sin modificadores se omite: es solo mover el cursor, y el paso de
  // llenado ya confirma el campo con Tab al reproducir.
  if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return;
  if (!isFunctionalKey(e)) return;

  // Escribir texto dentro de un campo no se graba tecla por tecla (se graba
  // el valor final), pero las teclas funcionales sí, con su target.
  const fp = fingerprintOf(el);
  sendStep({
    action: "key",
    kind: "key",
    fp,
    label: `${e.ctrlKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}${e.key}`,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
  });
}

function startRecording() {
  if (recordingActive) return;
  recordingActive = true;
  document.addEventListener("click", onRecordClick, true);
  document.addEventListener("dblclick", onRecordDblClick, true);
  document.addEventListener("change", onRecordChange, true);
  // Respaldo de 'change': algunos controles de SAP no lo disparan al salir
  // del campo, pero sí pierden el foco. El deduplicado por valor evita
  // registrar el mismo dato dos veces.
  document.addEventListener("focusout", onRecordChange, true);
  document.addEventListener("keydown", onRecordKeydown, true);
}

function stopRecording() {
  recordingActive = false;
  document.removeEventListener("click", onRecordClick, true);
  document.removeEventListener("dblclick", onRecordDblClick, true);
  document.removeEventListener("change", onRecordChange, true);
  document.removeEventListener("focusout", onRecordChange, true);
  document.removeEventListener("keydown", onRecordKeydown, true);
}

// ---------------------------------------------------------------
// Reproducción exacta en dos fases: MATCH_STEP puntúa (sin tocar nada) y
// RUN_MATCHED ejecuta solo en el frame ganador.
// ---------------------------------------------------------------

const matchCache = new Map();

/** Si el mejor candidato es el contenedor y no el campo en sí (pasa cuando
 * el SID vive en un wrapper), baja al <input>/<select> editable de adentro,
 * o al de su misma fila. */
function resolveEditableTarget(el, action) {
  const wantsCheckbox = action === "check";
  const usable = (n) =>
    n && isVisible(n) && !n.disabled && (wantsCheckbox ? n.type === "checkbox" : n.type !== "checkbox" && n.type !== "radio");

  if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && usable(el)) return el;

  const inside = Array.from(el.querySelectorAll("input, textarea, select")).find(usable);
  if (inside) return inside;

  const row = el.closest ? el.closest("tr") : null;
  if (row) {
    const inRow = Array.from(row.querySelectorAll("input, textarea, select")).find(usable);
    if (inRow) return inRow;
  }
  return el;
}

/** Compatibilidad: plantillas grabadas antes de que existiera la huella
 * completa (solo tech/label) se convierten a una huella mínima. */
function fingerprintFromStep(step) {
  if (step.fp) return step.fp;
  const fp = {};
  if (step.tech) fp.tech = step.tech;
  if (step.label) {
    if (step.kind === "tableField") fp.rowLabel = step.label;
    else {
      fp.title = step.label;
      fp.text = step.label;
    }
  }
  if (step.hash) fp.href = step.hash;
  if (step.kind === "tableField") fp.inVirtualTable = true;
  return fp;
}

async function matchRecordedStep(step) {
  const fp = fingerprintFromStep(step);

  // Tablas virtualizadas: la fila puede no existir aún en el DOM. Se usa la
  // misma lógica ya probada (botón Posicionar y, si no, flechas) para
  // traerla a la vista antes de puntuar.
  if (fp.inVirtualTable && fp.rowLabel && step.action === "fill") {
    const { input, trace } = await findClassificationValueInputAsync(fp.rowLabel);
    if (!input) return { ok: false, score: 0, trace: `Fila '${fp.rowLabel}' no localizada. ${trace.join(" | ")}` };
    const token = String(Math.random()).slice(2);
    matchCache.set(token, input);
    return { ok: true, score: scoreCandidate(input, fp) + 40, token, trace: `Fila '${fp.rowLabel}' localizada.` };
  }

  // Paso de tecla sin un target reconocible: se despacha al elemento con
  // foco, así que siempre puede ejecutarse (puntaje bajo, por si otro frame
  // tiene un target mejor).
  let { el, score } = bestMatchFor(fp);
  if (el && (step.action === "fill" || step.action === "check")) {
    el = resolveEditableTarget(el, step.action);
  }
  if (!el || score < MATCH_MIN_SCORE) {
    if (step.action === "key") {
      const token = String(Math.random()).slice(2);
      matchCache.set(token, document.activeElement || document.body);
      return { ok: true, score: 1, token, trace: "Tecla al elemento con foco (sin target exacto)." };
    }
    return { ok: false, score: Math.max(score, 0), trace: `Sin coincidencia suficiente (mejor puntaje: ${Math.max(score, 0)}).` };
  }

  const token = String(Math.random()).slice(2);
  matchCache.set(token, el);
  return { ok: true, score, token, trace: `Coincidencia con puntaje ${score}.` };
}

/** Dispara una secuencia de teclado completa (keydown/keypress/keyup) con
 * los modificadores tal como se grabaron. */
function dispatchRecordedKey(el, step) {
  const opts = {
    key: step.key,
    code: step.code || step.key,
    keyCode: step.keyCode,
    which: step.keyCode,
    ctrlKey: !!step.ctrl,
    altKey: !!step.alt,
    shiftKey: !!step.shift,
    metaKey: !!step.meta,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

/** Doble click real: la secuencia completa que espera el navegador. */
function dispatchDoubleClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", { ...opts, detail: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", { ...opts, detail: 2 }));
  el.dispatchEvent(new MouseEvent("dblclick", { ...opts, detail: 2 }));
}

/**
 * @param {boolean} dryRun Modo prueba: los pasos de navegación (click en
 * tile, pestaña, fila, tecla) SÍ se ejecutan — hacen falta para poder
 * validar los pasos siguientes —, pero los que escriben datos (fill/check)
 * solo verifican, y "Grabar" nunca se presiona.
 */
async function runMatchedStep(token, step, overrideValue, dryRun = false) {
  const el = matchCache.get(token);
  matchCache.delete(token);
  if (!el || !el.isConnected) return { ok: false, trace: "El elemento localizado ya no está en la página." };

  const value = overrideValue !== undefined && overrideValue !== null ? overrideValue : step.value;

  if (step.action === "fill") {
    if (dryRun) return { ok: true, trace: `Campo localizado (valor actual: '${el.value}'). No se modificó (modo prueba).` };
    if (el instanceof HTMLSelectElement) {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    fillAndCommit(el, value, "Tab");
    return { ok: true };
  }

  if (step.action === "check") {
    if (dryRun) {
      return { ok: true, trace: `Checkbox localizado (estado actual: ${el.checked ? "marcado" : "desmarcado"}). No se modificó (modo prueba).` };
    }
    if (el.checked !== step.checked) el.click();
    return { ok: true };
  }

  if (step.action === "key") {
    dispatchRecordedKey(el, step);
    return { ok: true };
  }

  if (step.action === "click") {
    if (step.kind === "save" && dryRun) {
      return { ok: true, trace: "Botón Grabar localizado. NO se presionó (modo prueba)." };
    }
    if (step.clickType === "double") dispatchDoubleClick(el);
    else el.click();
    return { ok: true };
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
// <iframe> de la transacción que se crea al abrir un tile), arranca sin
// haber recibido el START_RECORDING — por eso consulta el flag persistido
// apenas carga, para sumarse solo.
try {
  chrome.storage.local.get("macroRecordingActive", (data) => {
    if (data && data.macroRecordingActive) startRecording();
  });
} catch {
  // chrome.storage no disponible en este contexto; sin grabación entre
  // navegaciones, pero el resto de la extensión sigue funcionando normal.
}
