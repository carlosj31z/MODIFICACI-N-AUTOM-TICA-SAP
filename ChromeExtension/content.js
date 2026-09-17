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
 * envuelve tanto su campo de texto como su botón de confirmar — evita
 * confiar en document.activeElement (que puede no apuntar realmente al
 * diálogo) o en encontrar un input equivocado en otra parte de la página.
 */
function findDialogContainer(titleText, maxLevels = 12) {
  const titleEl = findLabelElement(titleText);
  if (!titleEl) return null;
  let node = titleEl;
  for (let i = 0; i < maxLevels && node; i++) {
    const hasInput = node.querySelector && node.querySelector('input[type="text"]');
    const hasContinuar =
      node.querySelector &&
      (node.querySelector("[lsevents*='GuiOkCodeButton']") ||
        Array.from(node.querySelectorAll("[title]")).some((el) => /Continuar|Enter/i.test(el.title || "")));
    if (hasInput && hasContinuar) return node;
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

  let dialog = null;
  for (let i = 0; i < 8 && !dialog; i++) {
    await delay(200);
    dialog = findDialogContainer("Posicionar sobre caract.");
  }
  if (!dialog) {
    return { ok: false, trace: "Posicionar: se hizo click en la lupa pero no apareció el diálogo 'Posicionar sobre caract.'." };
  }

  const input = Array.from(dialog.querySelectorAll('input[type="text"]')).find((n) => isVisible(n) && !n.disabled);
  if (!input) return { ok: false, trace: "Posicionar: diálogo abierto pero sin campo de texto visible/habilitado." };

  fillAndCommit(input, labelText, null); // solo escribir, el commit lo hace "Continuar"
  await delay(200);

  // Verificar que de verdad quedó escrito antes de confirmar — si no, es
  // mejor abortar (y usar el respaldo de flechas) que confirmar un
  // diálogo vacío.
  if (input.value !== labelText) {
    return { ok: false, trace: `Posicionar: el campo de texto no aceptó el valor (quedó '${input.value}').` };
  }

  const continuar = Array.from(dialog.querySelectorAll("*")).find(
    (n) => isVisible(n) && (n.matches?.("[lsevents*='GuiOkCodeButton']") || /Continuar|Enter/i.test(n.title || ""))
  );
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
    default:
      sendResponse({ ok: false, error: "Acción desconocida: " + msg.type });
  }
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
