// fb-token.js — MAIN world content script บน facebook.com
// เข้าถึง window variables โดยตรงเพื่อดึง access token (เหมือน Runfeed)

(function () {
  const isValid = (t) => t && typeof t === 'string' && t.startsWith('EAA') && t.length > 50;

  function findToken() {
    // 1. ลอง window globals ต่างๆ ที่ Facebook ใช้
    const globals = [
      window.__accessToken,
      window.Env && window.Env.accessToken,
      window.__INITIAL_REDUX_STATE__ && window.__INITIAL_REDUX_STATE__.Authentication && window.__INITIAL_REDUX_STATE__.Authentication.accessToken,
    ];
    for (const t of globals) {
      if (isValid(t)) return t;
    }

    // 2. ลอง Facebook internal modules (DTSGInitData, CurrentAccessToken)
    try {
      if (typeof require === 'function') {
        try { const m = require('DTSGInitData'); if (isValid(m?.token)) return m.token; } catch {}
        try { const m = require('CurrentAccessToken'); if (isValid(m?.accessToken)) return m.accessToken; } catch {}
      }
    } catch {}

    // 3. ลอง __comet_infra modules
    try {
      if (window.__comet_infra_fb_dtsg) {
        // dtsg ไม่ใช่ token แต่อาจอยู่ใกล้ๆ access token
      }
    } catch {}

    // 4. สแกน script tags ทั้งหมด — หา EAA tokens
    const scripts = document.querySelectorAll('script:not([src])');
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent;
      if (!text || text.length < 50) continue;

      // ลอง patterns หลายแบบ
      const patterns = [
        /"accessToken":"(EAA[A-Za-z0-9]{50,})"/,
        /"access_token":"(EAA[A-Za-z0-9]{50,})"/,
        /accessToken["']\s*[:=]\s*["'](EAA[A-Za-z0-9]{50,})["']/,
        /access_token=(EAA[A-Za-z0-9]{50,})/,
        /["'](EAAG[A-Za-z0-9]{50,})["']/,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m && isValid(m[1])) return m[1];
      }
    }

    // 5. สแกน global object keys ที่อาจมี token
    try {
      for (const key of Object.keys(window)) {
        if (key.startsWith('__') && typeof window[key] === 'object' && window[key]) {
          const obj = window[key];
          if (isValid(obj.accessToken)) return obj.accessToken;
          if (isValid(obj.access_token)) return obj.access_token;
        }
      }
    } catch {}

    return null;
  }

  function tryAndSend() {
    const token = findToken();
    if (token) {
      window.dispatchEvent(new CustomEvent('BP_TOKEN_FOUND', { detail: token }));
    }
  }

  // ลองทันที + ลองหลายครั้ง (Facebook โหลด JS ช้า)
  tryAndSend();
  if (document.readyState !== 'complete') {
    window.addEventListener('load', tryAndSend, { once: true });
  }
  setTimeout(tryAndSend, 1000);
  setTimeout(tryAndSend, 3000);
  setTimeout(tryAndSend, 6000);
  setTimeout(tryAndSend, 10000);
})();
