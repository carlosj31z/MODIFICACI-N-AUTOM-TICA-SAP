# SAP MM02 - Bloqueo de Materiales (Extensión de Chrome)

Extensión Manifest V3 que automatiza el llenado de campos en la transacción
MM02 (SAP GUI for HTML embebido en Fiori Launchpad), **sin lanzar Chromium
aparte, sin ChromeDriver y sin `--remote-debugging-port`**. Corre dentro de
tu Chrome corporativo como una extensión normal.

Es el equivalente funcional de la app de escritorio (`SapAutomationService.cs`
+ `ExcelService.cs`), pero ejecutándose 100% dentro del navegador.

## Instalación (modo desarrollador, sin Chrome Web Store)

1. Abre `chrome://extensions`.
2. Activa "Modo de desarrollador" (interruptor arriba a la derecha).
3. Click en "Cargar descomprimida" y selecciona esta carpeta (`ChromeExtension/`).
4. Debería aparecer "SAP MM02 - Bloqueo de Materiales" en la lista de extensiones.
5. Click en el ícono de la extensión (o en el ícono del side panel) para abrir el panel.

Si tu política corporativa cambia y bloquea "Cargar descomprimida", esta
misma carpeta se puede empaquetar (`.crx`) y distribuir/aprobar vía la
consola de administración de Chrome de tu empresa (Google Admin Console),
sin pasar por la Chrome Web Store pública.

## Uso

1. Abre en una pestaña `https://fiori.medifarma.com.pe/sap/bc/ui2/flp?sap-client=300&sap-language=ES` y entra normalmente (SSO/credenciales). No hace falta seleccionarla a mano: el panel detecta sola cuál es tu pestaña activa cada vez que le das a Iniciar/Reintentar (arriba del todo te muestra cuál detectó, con una advertencia si no parece ser Fiori/SAP).
2. Abre el side panel de la extensión.
3. Paso 1 — **Configuración de esta carga** (aplica a *todas* las filas de la tabla, se define una sola vez):
   - **Vista**: lista desplegable con las vistas válidas de MM02 (si pegas/subes un texto que no calza exactamente con ninguna, se agrega como opción "(personalizada)").
   - **Campo técnico**: el campo SAP que vas a tocar (ej. `MSTAE`, `EVENTO`).
   - **Transacción**: fija en `MM02`, no se edita.
4. Paso 2 — llena la tabla de materiales (grilla editable, no un formulario a ciegas). Cada fila es solo **Material, Centro, Valor**:
   - **Valor vacío**: dejar la celda vacía borra ese campo en SAP (el placeholder gris "(vacío → se borrará en SAP)" te lo recuerda mientras la celda esté vacía).
   - Puedes: escribir directo en las celdas, pegar filas completas copiadas de Excel — **solo Material, Centro y Valor, en ese orden** (haz click en la celda "Material" de la fila donde quieres pegar y usa Ctrl+V; reparte automáticamente columnas y filas, como en una hoja de cálculo; si la primera fila pegada son encabezados, se descarta sola), o cargar un `.xlsx` con el botón "📎 Cargar Excel" (acepta tanto un archivo de 3 columnas como tu formato histórico de 6: Material, Centro, Transaccion, Vista, CampoTecnico, Valor — si usas el de 6 columnas, la Vista/Campo técnico de la primera fila rellenan automáticamente el paso 1 si los dejaste vacíos, y Transacción se ignora).
   - "+ Agregar fila" / "✕" por fila / "🗑 Vaciar tabla" para gestionar filas sueltas.
5. Paso 3: click "Iniciar". El panel va llenando MM02 material por material, agrupando filas contiguas del mismo material (igual que la app de escritorio), y graba una vez por material.
6. Si algo falla, la fila queda en rojo con "Error" y el mensaje de diagnóstico en la columna Mensaje; corrige lo necesario directo en la celda y usa "Reintentar errores" para reprocesar solo esas filas (respeta lo que hayas corregido en la tabla, no repite el valor viejo).

### Ejemplo para bloqueo de material (MSTAE)

Paso 1: Vista = `Datos básicos 1`, Campo técnico = `MSTAE`. Tabla:

| Material | Centro | Valor |
|---|---|---|
| 123456 | 1000 | Z2 |

### Ejemplo para una característica de Clasificación (p.ej. EVENTO)

La vista "Clasificación" no tiene campos sueltos, sino una tabla de
características (etiqueta + valor). El bot busca la fila cuya etiqueta
coincide con el Campo técnico del paso 1 (tal como se ve en la columna
"Denom. característica") y llena el Valor de esa fila.

Paso 1: Vista = `Clasificación`, Campo técnico = `EVENTO`. Tabla:

| Material | Centro | Valor |
|---|---|---|
| 6000003298 |  | CAT3 |

No necesita `Centro` porque Clasificación es una vista general del material.

## Actualizar la extensión tras un cambio de código

Chrome no vigila la carpeta en disco de una extensión "sin empaquetar", así
que no hay una forma verdaderamente automática de que se recargue sola al
hacer `git pull`. Pero nunca hace falta eliminarla y volver a cargarla:

1. `git pull` (o baja el ZIP de nuevo) en la misma carpeta.
2. Click en el botón 🔄 (arriba a la derecha del panel) — llama a
   `chrome.runtime.reload()`, o si prefieres, el ícono de recargar ⟳ en la
   tarjeta de la extensión dentro de `chrome://extensions`. Cualquiera de
   los dos recarga `background.js`/`content.js`/`sidepanel.js` desde disco.
3. Refresca (F5) la pestaña de SAP para que tome el `content.js` actualizado
   ahí también (una extensión recargada no reemplaza sola los content
   scripts ya inyectados en pestañas abiertas).

## Arquitectura

- `content.js`: se inyecta en **todos los frames** de `fiori.medifarma.com.pe`
  (`all_frames: true`), incluyendo los `<iframe>` anidados donde SAP GUI for
  HTML renderiza la transacción. Cada frame sabe buscar y llenar sus propios
  campos (por `data-hint`/`lsdata`, igual que hacía Selenium), pero no sabe
  nada del flujo completo. También expone la lógica de grabación/reproducción
  genérica que usa el apartado "Grabar configuración" (ver abajo).
- `sidepanel.js`: contiene toda la orquestación del apartado "Modificar
  material" (temporizadores, reintentos, agrupación por material, máquina de
  estados) — es el equivalente a `ProcessTasksAsync` en
  `SapAutomationService.cs`. Vive en el side panel (una página normal) en vez
  del *service worker* para no toparse con el límite de ~30s de inactividad
  de Manifest V3.
- `macro.js`: apartado nuevo e independiente ("Grabar configuración", ver
  abajo). Reutiliza las funciones de comunicación con `content.js` ya
  declaradas en `sidepanel.js` (`broadcastOnce`, `getActiveSapTab`, `sleep`,
  etc.) porque ambos `<script>` comparten el mismo scope global de la
  página — no las duplica ni las modifica.
- `background.js`: mínimo, solo configura que el ícono abra el side panel.

## Apartado "Grabar configuración" (macro)

Pestaña nueva en el panel, separada del apartado "Modificar material" (que
sigue intacto). Graba una secuencia completa de pasos —clicks, campos
llenados, pestañas de vista, checkboxes— mientras trabajas **a mano** en
cualquier vista de **MM01 (crear material) o MM02 (modificar material)**, y
la reproduce después sobre una lista de materiales.

1. **Grabar**: click "● Iniciar grabación", trabaja normal en tu pestaña de
   SAP (abre el tile de MM01 o MM02, elige vistas, completa campos, marca
   checkboxes, graba), y "⏹ Detener grabación" cuando termines. Cada acción
   aparece en vivo en la tabla de pasos.
2. **Guardar como plantilla**: ponle un nombre y guárdala — queda persistida
   (`chrome.storage.local`), no se pierde al cerrar el panel.
3. **Aplicar a materiales**: elige la plantilla, carga una tabla de
   Material/Centro (mismo pegado desde Excel que el otro apartado), e
   inicia. El paso grabado del campo Material (técnico `RMMG1-MATNR`) y el
   de Centro (`WERKS`) se sustituyen automáticamente por lo que pongas en
   cada fila; el resto de valores se repite tal como se grabó.

Mientras grabas, la tabla de pasos es editable: el botón ✕ borra un paso
suelto (por si tocaste algo de más sin querer) y el campo "Valor" de cada
paso de tipo llenar/marcar se puede corregir a mano antes de guardar la
plantilla — no hace falta volver a grabar todo por un solo dato mal.

Las plantillas también se pueden **exportar** (botón "⬇ Exportar", baja un
`.json`) e **importar** (botón "⬆ Importar") — útil para compartirlas entre
compañeros o entre distintos perfiles de Chrome, ya que `chrome.storage.local`
es por perfil y no viaja solo.

**Modo prueba ("🧪 Probar plantilla")**: escribe un material real y click en
"Probar" — recorre todos los pasos de la plantilla seleccionada, pero en vez
de escribir los valores solo **verifica** que cada campo/fila/botón se
encuentra (te dice el valor actual del campo sin tocarlo), y nunca presiona
Grabar. Sí navega de verdad por las pantallas (tiles, pestañas, filas de
diálogos) porque los pasos siguientes dependen de estar en la pantalla
correcta — lo único que NO hace es escribir datos ni guardar. Es la forma
recomendada de validar una plantilla nueva antes de correrla en serio sobre
una lista de materiales.

### Cómo identifica un campo "cualquiera" sin que se le programe a mano

- Campos normales: extrae el nombre técnico (ej. `RMMG1-MATNR`, `RCTMS-MWERT`)
  directamente del `data-hint`/`lsdata` del campo que tocaste, con una
  expresión regular sobre el atributo crudo — no hace falta parsear el JSON
  completo, el nombre del campo queda legible como texto plano incluso
  dentro de JSON anidado/escapado.
- Filas de tabla (Clasificación y similares, donde el nombre técnico es el
  mismo para toda la tabla): usa el texto de la celda vecina (la etiqueta,
  ej. "EVENTO") como identificador — misma lógica que ya usa el apartado
  "Modificar material" para Clasificación, con el botón "Posicionar" y la
  navegación por flechas como respaldo si la fila no está renderizada.
- Tiles, pestañas, botones, filas de diálogos: por su `href`/texto visible.

Como MM01 y MM02 usan el mismo motor de renderizado (SAP GUI for HTML
clásico) y los campos se identifican por lo que la propia pantalla expone
(no por selectores fijos que asuman una transacción concreta), la grabación
funciona igual en ambas sin necesitar código específico por transacción.

### Limitación conocida

Es una función nueva (v2.0.0): al reproducir, cada paso se busca por su
identificador grabado (nombre técnico o etiqueta de fila) con reintentos,
pero una vista muy distinta a las ya probadas (Clasificación, campos básicos)
podría necesitar un ajuste puntual la primera vez que falle — el log de
diagnóstico dice exactamente qué paso no se pudo ejecutar y por qué.

## Limitación conocida y cómo probarla

A diferencia de Selenium (que despacha eventos de teclado/mouse a nivel de
sistema operativo vía Chrome DevTools Protocol), esta extensión rellena los
campos con eventos DOM sintéticos (`Event('input')`, `KeyboardEvent`, etc.)
desde el content script. SAP GUI for HTML (WebGUI clásico) generalmente
responde bien a esto porque escucha eventos nativos del navegador, pero
**pruébalo primero con 1-2 materiales no productivos** antes de correrlo en
masa. Si algún campo no dispara la validación de SAP (el valor se ve escrito
pero SAP no lo reconoce al grabar), avísame: existe una alternativa más
robusta usando la API `chrome.debugger` (Chrome DevTools Protocol expuesto
*dentro* de la propia extensión, sin lanzar otro Chromium) que despacha
eventos a nivel de input real, igual que hacía Selenium.
