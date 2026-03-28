// content.js — Bridge ระหว่างหน้าเว็บและ Extension

// ตอบ PING จากเว็บ (เพื่อให้เว็บรู้ว่า extension พร้อม)
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;

  // ตอบ ping
  if (event.data.type === "BP_PING") {
    window.postMessage({ direction: "from-content-script", status: "ready" }, "*");
    return;
  }

  // รับคำสั่งจากเว็บ ส่งต่อไป background.js
  if (event.data.direction !== "from-page-script" || !event.data.message) return;

  chrome.runtime.sendMessage(event.data.message, (response) => {
    window.postMessage({
      direction: "from-content-script",
      response: response,
      messageId: event.data.messageId
    }, "*");
  });
});

// ส่ง ready ทันทีเผื่อเว็บโหลดก่อน
window.postMessage({ direction: "from-content-script", status: "ready" }, "*");
