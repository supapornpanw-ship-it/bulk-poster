// fb-token.js — MAIN world content script บน facebook.com
// เข้าถึง window variables โดยตรงเพื่อดึง access token

(function () {
  function findToken() {
    // ลอง window globals ต่างๆ ที่ Facebook ใช้
    const candidates = [
      window.__accessToken,
      window.Env && window.Env.accessToken,
      window.__INITIAL_REDUX_STATE__ && window.__INITIAL_REDUX_STATE__.Authentication && window.__INITIAL_REDUX_STATE__.Authentication.accessToken,
    ];

    for (const t of candidates) {
      if (t && typeof t === 'string' && t.length > 30) return t;
    }

    // สแกน script tags ที่ embed ไว้ใน page
    const scripts = document.querySelectorAll('script:not([src])');
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent;
      const m = text.match(/"accessToken":"([^"]{50,})"/) ||
                text.match(/"access_token":"([^"]{50,})"/) ||
                text.match(/\\"accessToken\\":\\"([^"\\]{50,})\\"/);
      if (m && m[1]) return m[1];
    }

    return null;
  }

  function tryAndSend() {
    const token = findToken();
    if (token) {
      // ส่งผ่าน CustomEvent ไปยัง isolated world bridge
      window.dispatchEvent(new CustomEvent('BP_TOKEN_FOUND', { detail: token }));
    }
  }

  // ลองทันที
  tryAndSend();
  // ลองอีกครั้งหลัง page โหลดเสร็จ
  if (document.readyState !== 'complete') {
    window.addEventListener('load', tryAndSend, { once: true });
  }
  setTimeout(tryAndSend, 2000);
  setTimeout(tryAndSend, 5000);
})();
