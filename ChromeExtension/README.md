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

1. Abre en una pestaña `https://fiori.medifarma.com.pe/sap/bc/ui2/flp?sap-client=300&sap-language=ES` y entra normalmente (SSO/credenciales).
2. Abre el side panel de la extensión.
3. Paso 1: click "Usar pestaña activa de SAP" con esa pestaña como pestaña activa/enfocada.
4. Paso 2: sube el mismo Excel que usas hoy (columnas: `Material, Centro, Transaccion, Vista, CampoTecnico, Valor`) o pega filas copiadas de Excel directamente en el textarea.
5. Paso 3: click "Iniciar". El panel va llenando MM02 material por material, agrupando filas contiguas del mismo material (igual que la app de escritorio), y graba una vez por material.
6. Si algo falla, el estado queda en "Error" con el mensaje de diagnóstico; corrige lo necesario y usa "Reintentar errores" para reprocesar solo esas filas.

### Ejemplo de fila para bloqueo de material (MSTAE)

| Material | Centro | Transaccion | Vista | CampoTecnico | Valor |
|---|---|---|---|---|---|
| 123456 | 1000 | MM02 | Datos básicos 1 | MSTAE | Z2 |

### Ejemplo de fila para una característica de Clasificación (p.ej. EVENTO)

La vista "Clasificación" no tiene campos sueltos, sino una tabla de
características (etiqueta + valor). El bot busca la fila cuya etiqueta
coincide con `CampoTecnico` (tal como se ve en la columna "Denom.
característica") y llena el `Valor` de esa fila:

| Material | Centro | Transaccion | Vista | CampoTecnico | Valor |
|---|---|---|---|---|---|
| 6000003298 |  | MM02 | Clasificación | EVENTO | CAT3 |

No necesita `Centro` porque Clasificación es una vista general del material.

## Arquitectura

- `content.js`: se inyecta en **todos los frames** de `fiori.medifarma.com.pe`
  (`all_frames: true`), incluyendo los `<iframe>` anidados donde SAP GUI for
  HTML renderiza la transacción. Cada frame sabe buscar y llenar sus propios
  campos (por `data-hint`/`lsdata`, igual que hacía Selenium), pero no sabe
  nada del flujo completo.
- `sidepanel.js`: contiene toda la orquestación (temporizadores, reintentos,
  agrupación por material, máquina de estados) — es el equivalente a
  `ProcessTasksAsync` en `SapAutomationService.cs`. Vive en el side panel (una
  página normal) en vez del *service worker* para no toparse con el límite de
  ~30s de inactividad de Manifest V3.
- `background.js`: mínimo, solo configura que el ícono abra el side panel.

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
