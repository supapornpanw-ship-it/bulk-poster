// content.js - Bridge ระหว่างหน้าเว็บและ Extension
// ทำให้หน้าเว็บสามารถส่งคำสั่งไปหา background.js ได้โดยไม่ต้องรู้ Extension ID

window.addEventListener("message", (event) => {
    // รับเฉพาะข้อความที่มาจากหน้าเว็บเดียวกัน และมีทิศทางถูกต้อง
    if (event.source !== window || !event.data || event.data.direction !== "from-page-script") {
        return;
    }

    // ส่งต่อข้อความไปที่ background.js
    chrome.runtime.sendMessage(event.data.message, (response) => {
        // เมื่อพื้นหลังตอบกลับ ส่งคำตอบนั้นกลับคืนไปที่หน้าเว็บ
        window.postMessage({
            direction: "from-content-script",
            response: response,
            messageId: event.data.messageId
        }, "*");
    });
});

// ส่งสัญญาณบอกหน้าเว็บว่า Extension พร้อมทำงานแล้ว
window.postMessage({ direction: "from-content-script", status: "ready" }, "*");
