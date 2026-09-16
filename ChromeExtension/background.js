// Service worker mínimo: MV3 mata el service worker a los ~30s de inactividad,
// así que TODA la orquestación (temporizadores, reintentos, estado de tareas)
// vive en sidepanel.js, que corre como una página normal mientras el panel
// esté abierto y no sufre ese ciclo de vida efímero. Este archivo solo
// configura que el ícono de la extensión abra el side panel.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("No se pudo configurar el side panel:", err));
});
