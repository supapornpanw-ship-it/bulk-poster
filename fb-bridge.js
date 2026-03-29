// fb-bridge.js — ISOLATED world บน facebook.com
// รับ CustomEvent จาก MAIN world แล้วส่งต่อให้ background.js

window.addEventListener('BP_TOKEN_FOUND', function (e) {
  if (e.detail && e.detail.length > 30) {
    chrome.runtime.sendMessage({ type: 'SET_FB_TOKEN', token: e.detail });
  }
});
