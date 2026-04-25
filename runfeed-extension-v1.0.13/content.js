// Runfeed Content Script — bridges web app <-> extension

const SOURCE_WEB = "runfeed-web";
const SOURCE_EXT = "runfeed-extension";

// Forward messages from web to extension
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== SOURCE_WEB) return;

  const { requestId, payload } = event.data;

  try {
    const response = await chrome.runtime.sendMessage(payload);
    window.postMessage({ source: SOURCE_EXT, requestId, payload: response }, "*");
  } catch (error) {
    window.postMessage({
      source: SOURCE_EXT,
      requestId,
      payload: { type: "ERROR", error: error.message },
    }, "*");
  }
});

// Notify web app that extension is ready
window.postMessage({
  source: SOURCE_EXT,
  payload: { type: "EXTENSION_READY", version: chrome.runtime.getManifest().version },
}, "*");
