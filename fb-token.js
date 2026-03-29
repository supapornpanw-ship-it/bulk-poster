// fb-token.js — Content script ที่รันบน facebook.com
// ดึง access token จาก JavaScript context ของหน้าเว็บแล้วส่งให้ background.js

(function () {
  // inject script tag เข้าไปใน page context เพื่อเข้าถึง window variables
  const s = document.createElement('script');
  s.textContent = `(function(){
    var tryFind = function(){
      var token = null;
      try {
        // Method 1: window.__accessToken
        if(window.__accessToken) return window.__accessToken;

        // Method 2: Env object
        if(window.Env && window.Env.accessToken) return window.Env.accessToken;

        // Method 3: scan all script tags for accessToken pattern
        var scripts = document.querySelectorAll('script');
        for(var i=0; i<scripts.length; i++){
          var t = scripts[i].textContent;
          var m = t.match(/"accessToken":"([^"]{30,})"/) ||
                  t.match(/"access_token":"([^"]{30,})"/) ||
                  t.match(/access_token=([^&"'\s]{30,})/);
          if(m && m[1]) return m[1];
        }

        // Method 4: scan page source
        var html = document.documentElement.innerHTML;
        var m2 = html.match(/"accessToken":"([^"]{30,})"/) ||
                 html.match(/"access_token":"([^"]{30,})"/) ||
                 html.match(/\\"accessToken\\":\\"([^\\\\]{30,})\\"/);
        if(m2 && m2[1]) return m2[1];

      } catch(e) {}
      return null;
    };
    var token = tryFind();
    if(token) window.postMessage({type:'BP_TOKEN_FOUND', token:token}, '*');
  })();`;
  (document.head || document.documentElement).appendChild(s);
  s.remove();

  // รับ token จาก injected script แล้วส่งให้ background.js
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.type !== 'BP_TOKEN_FOUND') return;
    chrome.runtime.sendMessage({ type: 'SET_FB_TOKEN', token: e.data.token });
  });
})();
