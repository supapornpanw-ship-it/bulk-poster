// ===== Bulk Poster — background.js =====
// Service Worker: จัดการ Cookie, Facebook API, โพสต์, ตั้งเวลา

const WEB_URL = 'https://bulk-poster.vercel.app';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: WEB_URL });
});

// ─── Cookie & Auth Setup ───────────────────────────────────────────────────

async function getFacebookCookies() {
  return new Promise(resolve => {
    chrome.cookies.getAll({ domain: '.facebook.com' }, cookies => resolve(cookies));
  });
}

function formatCookieString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function setupCookieRules(cookieString) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1, priority: 1,
        condition: {
          urlFilter: '||facebook.com',
          resourceTypes: ['xmlhttprequest', 'other', 'main_frame', 'sub_frame']
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Cookie', operation: 'set', value: cookieString },
            { header: 'Origin', operation: 'set', value: 'https://business.facebook.com' },
            { header: 'Referer', operation: 'set', value: 'https://business.facebook.com/' }
          ]
        }
      },
      {
        id: 2, priority: 1,
        condition: {
          urlFilter: '||graph.facebook.com',
          resourceTypes: ['xmlhttprequest', 'other']
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Cookie', operation: 'set', value: cookieString },
            { header: 'Origin', operation: 'set', value: 'https://business.facebook.com' },
            { header: 'Referer', operation: 'set', value: 'https://business.facebook.com/' }
          ]
        }
      }
    ]
  });
  await new Promise(r => setTimeout(r, 300));
}

// ─── Facebook Graph API ────────────────────────────────────────────────────

async function fbGet(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/v20.0${path}${token ? sep + 'access_token=' + token : ''}`;
  const resp = await fetch(url);
  return resp.json();
}

async function fbPost(path, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(`https://graph.facebook.com/v20.0${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return resp.json();
}

async function extractTokenFromPage(pageUrl) {
  const resp = await fetch(pageUrl, {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(10000)
  });
  const html = await resp.text();
  // รับเฉพาะ EAA tokens เท่านั้น (format จริงของ Facebook)
  const patterns = [
    /"accessToken"\s*:\s*"(EAA[A-Za-z0-9]{50,})"/,
    /"access_token"\s*:\s*"(EAA[A-Za-z0-9]{50,})"/,
    /access_token=(EAA[A-Za-z0-9]{50,})/,
    /(EAA[A-Za-z0-9]{100,})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const token = m[1] || m[0];
      if (token && token.startsWith('EAA') && token.length > 50) return token;
    }
  }
  return null;
}

async function getOrExtractToken() {
  const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
  if (userToken && tokenExpiry && Date.now() < tokenExpiry) return userToken;
  return null;
}

async function extractAndSaveToken() {
  const token = await extractTokenFromPage('https://www.facebook.com/').catch(() => null);
  if (token) {
    await chrome.storage.local.set({ userToken: token, tokenExpiry: Date.now() + 3600000 });
    return token;
  }
  return null;
}

// เปิด tab facebook.com ในเบื้องหลัง รอ fb-token.js ส่ง token มา แล้วปิด tab
async function extractTokenViaTab() {
  // ตรวจก่อนว่ามี token อยู่แล้วหรือเปล่า
  const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
  if (userToken && userToken.startsWith('EAA') && tokenExpiry && Date.now() < tokenExpiry) {
    return userToken;
  }

  return new Promise(async (resolve) => {
    let tab = null;
    let resolved = false;

    const done = async (token) => {
      if (resolved) return;
      resolved = true;
      if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
      resolve(token);
    };

    // timeout 15s
    const timeout = setTimeout(() => done(null), 15000);

    // poll ทุก 500ms ว่า SET_FB_TOKEN มาถึงหรือยัง
    const poll = setInterval(async () => {
      const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
      if (userToken && userToken.startsWith('EAA') && tokenExpiry && Date.now() < tokenExpiry) {
        clearInterval(poll);
        clearTimeout(timeout);
        done(userToken);
      }
    }, 500);

    // เปิด facebook.com tab ใหม่ (ไม่ active) เพื่อ trigger fb-token.js
    try {
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: false });
    } catch {
      clearInterval(poll);
      clearTimeout(timeout);
      resolve(null);
    }
  });
}

async function getPages() {
  // 1. ลองใช้ cached token ที่ valid (ต้องขึ้นต้น EAA)
  const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
  if (userToken && userToken.startsWith('EAA') && tokenExpiry && Date.now() < tokenExpiry) {
    const data = await fbGet('/me/accounts?fields=id,name,access_token,picture.type(square){url}&limit=200', userToken);
    if (!data.error) return data;
    // Token หมดอายุหรือไม่ valid → ลบออก
    await chrome.storage.local.remove(['userToken', 'tokenExpiry']);
  }

  // 2. ลองดึงผ่าน internal Facebook API (ใช้ cookie auth + fb_dtsg)
  const internalResult = await getPagesViaFbDtsg().catch(() => null);
  if (internalResult) return internalResult;

  // 3. ไม่สำเร็จ → แจ้ง user ให้ใส่ token เอง
  throw new Error('TOKEN_REQUIRED');
}

async function getPagesViaFbDtsg() {
  // ดึง facebook.com (cookies inject อยู่แล้ว) เพื่อหา fb_dtsg
  const html = await fetch('https://www.facebook.com/', {
    signal: AbortSignal.timeout(10000)
  }).then(r => r.text());

  // หา fb_dtsg token
  let dtsg = null;
  const dtsgPatterns = [
    /"DTSGInitialData","",\{"token":"([^"]+)"/,
    /"DTSGInitData","",\{"token":"([^"]+)"/,
    /"fb_dtsg":\{"value":"([^"]+)"/,
    /\["DTSGInitialData"\],\[\],\{"token":"([^"]+)"/,
    /"token":"([^"]{8,20})","async_get_token"/,
  ];
  for (const p of dtsgPatterns) {
    const m = html.match(p);
    if (m && m[1]) { dtsg = m[1]; break; }
  }
  if (!dtsg) return null;

  // หา c_user (user ID)
  const cookies = await chrome.cookies.getAll({ domain: '.facebook.com' });
  const cUser = cookies.find(c => c.name === 'c_user');
  if (!cUser) return null;

  // เรียก internal GraphQL API
  const resp = await fetch('https://www.facebook.com/api/graphql/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      fb_dtsg: dtsg,
      fb_api_caller_class: 'RelayModern',
      server_timestamps: 'true',
      variables: JSON.stringify({ count: 100, cursor: null, scale: 2 }),
      doc_id: '4648574585190829',
    }),
    signal: AbortSignal.timeout(10000)
  });

  const raw = await resp.text();
  // FB internal responses อาจขึ้นต้นด้วย "for (;;);"
  const cleaned = raw.replace(/^for\s*\(;;\);/, '').trim();

  try {
    const data = JSON.parse(cleaned);
    const pages = extractPagesFromGraphQL(data);
    if (pages && pages.length > 0) return { data: pages };
  } catch {}

  return null;
}

function extractPagesFromGraphQL(data) {
  // ลอง parse หลาย format
  try {
    const str = JSON.stringify(data);
    const matches = [...str.matchAll(/"id":"(\d{10,})","name":"([^"]+)"/g)];
    if (matches.length > 0) {
      return matches.map(m => ({ id: m[1], name: m[2], access_token: null }));
    }
  } catch {}
  return null;
}

async function postToPage(pageId, pageToken, { link, message, scheduledTime }) {
  const params = { access_token: pageToken };
  if (link) params.link = link;
  if (message) params.message = message;
  if (scheduledTime) {
    params.published = 'false';
    params.scheduled_publish_time = String(Math.floor(scheduledTime / 1000));
  } else {
    params.published = 'true';
  }
  return fbPost(`/${pageId}/feed`, params);
}

// ─── Photo Upload ─────────────────────────────────────────────────────────

// อัพโหลดรูปขึ้น Facebook แบบ unpublished แล้วคืน photo_id
// วิธีนี้ข้ามข้อจำกัด #100 (ต้องเป็นเจ้าของ URL) ได้
async function uploadPhotoToPage(pageId, pageToken, imageDataUrl) {
  const [header, base64] = imageDataUrl.split(',');
  const mimeType = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });

  const formData = new FormData();
  formData.append('access_token', pageToken);
  formData.append('published', 'false');
  formData.append('source', blob, 'image.jpg');

  const resp = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
    method: 'POST',
    body: formData
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return data.id;
}

// ─── OG Preview ──────────────────────────────────────────────────────────

async function fetchOgData(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const html = await resp.text();
    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
               || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
      return m ? m[1] : '';
    };
    const title = og('title') || (html.match(/<title>([^<]+)<\/title>/i)?.[1]) || url;
    const description = og('description');
    const image = og('image');
    const siteName = og('site_name') || new URL(url).hostname.replace('www.', '');
    return { title: title.trim(), description: description.trim(), image, siteName };
  } catch (e) {
    return { title: url, description: '', image: '', siteName: new URL(url).hostname };
  }
}

// ─── Storage Helpers ──────────────────────────────────────────────────────

async function getScheduledJobs() {
  const { scheduledJobs = [] } = await chrome.storage.local.get('scheduledJobs');
  return scheduledJobs;
}

async function saveScheduledJobs(jobs) {
  await chrome.storage.local.set({ scheduledJobs: jobs });
}

async function getPostHistory() {
  const { postHistory = [] } = await chrome.storage.local.get('postHistory');
  return postHistory;
}

async function addHistory(entry) {
  const { postHistory = [] } = await chrome.storage.local.get('postHistory');
  postHistory.unshift(entry);
  if (postHistory.length > 200) postHistory.length = 200;
  await chrome.storage.local.set({ postHistory });
}

// ─── Execute Post Job ─────────────────────────────────────────────────────

// โพสต์เพจเดียวเมื่อ alarm ยิง (ทนต่อ service worker ถูก kill)
async function executePagePost(jobId, pageIndex) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status === 'cancelled') return;

  const page = job.pages[pageIndex];
  if (!page) return;

  const pd = job.postData || {};
  const params = { access_token: page.access_token, published: 'true' };
  if (pd.link)    params.link    = pd.link;
  if (pd.message) params.message = pd.message;
  // ถ้ามีรูป → อัพโหลดก่อน
  if (pd.imageData) {
    try {
      const photoId = await uploadPhotoToPage(page.id, page.access_token, pd.imageData);
      params.object_attachment = photoId;
    } catch (e) {
      console.warn('Scheduled photo upload failed:', e.message);
    }
  }

  if (!job.results) job.results = {};
  try {
    const res = await fbPost(`/${page.id}/feed`, params);
    if (res.error) {
      job.results[page.id] = { success: false, error: res.error.message, pageName: page.name };
    } else {
      job.results[page.id] = { success: true, postId: res.id, pageName: page.name };
    }
  } catch (err) {
    job.results[page.id] = { success: false, error: err.message, pageName: page.name };
  }

  // ถ้าครบทุกเพจแล้ว → mark done + history + notification
  if (Object.keys(job.results).length >= job.pages.length) {
    job.status = 'done';
    job.executedAt = Date.now();
    await saveScheduledJobs(jobs);
    await addHistory({ ...job, type: 'scheduled' });
    const ok = Object.values(job.results).filter(r => r.success).length;
    chrome.notifications.create(`notif_${jobId}`, {
      type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster',
      message: `โพสต์สำเร็จ ${ok}/${job.pages.length} เพจ ✓`
    });
  } else {
    await saveScheduledJobs(jobs);
  }
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith('bp_')) return;
  const m = alarm.name.match(/^(bp_\d+)_page_(\d+)$/);
  if (m) {
    executePagePost(m[1], parseInt(m[2]));
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────

function handleApiRequest(request, sender, sendResponse) {

  const run = async () => {

    // เตรียม Cookies (เดิม)
    if (request.type === 'PREPARE_COOKIES') {
      const cookies = await getFacebookCookies();
      if (!cookies.length) throw new Error('ไม่พบ Cookie Facebook กรุณาล็อกอิน Facebook ก่อน');
      const str = formatCookieString(cookies);
      await setupCookieRules(str);
      // เปิด facebook.com tab เพื่อดึง token — รอ max 15s
      await extractTokenViaTab().catch(() => {});
      await chrome.storage.local.set({ connected: true, connectedAt: Date.now() });
      return { success: true };
    }

    // Proxy Facebook API (เดิม — ใช้กับ FeedWeb)
    if (request.type === 'FB_API') {
      const opts = { method: request.method || 'GET' };
      if (request.body) {
        opts.method = 'POST';
        opts.body = request.body;
        if (typeof request.body === 'string') {
          opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        }
      }
      const resp = await fetch(request.url, opts);
      if (request.raw) return { success: true, data: await resp.text() };
      return { success: true, data: await resp.json() };
    }

    // ── Bulk Poster API ──────────────────────────────────────────────────

    if (request.type === 'GET_AD_ACCOUNTS') {
      let data = await fbGet('/me/adaccounts?fields=id,name&limit=100');
      if (data.error) {
        const token = await getOrExtractToken();
        if (token) data = await fbGet('/me/adaccounts?fields=id,name&limit=100', token);
      }
      return data;
    }

    if (request.type === 'POST_TO_PAGE') {
      const { page, postData } = request;
      const params = { access_token: page.access_token, published: 'true' };
      if (postData.link)    params.link    = postData.link;
      if (postData.message) params.message = postData.message;
      // ถ้ามีรูป → อัพโหลดก่อน แล้วใช้ object_attachment (ข้ามข้อจำกัด #100)
      if (postData.imageData) {
        try {
          const photoId = await uploadPhotoToPage(page.id, page.access_token, postData.imageData);
          params.object_attachment = photoId;
        } catch (e) {
          // อัพรูปไม่ได้ → โพสต์ปกติโดยไม่มีรูป
          console.warn('Photo upload failed:', e.message);
        }
      }
      const result = await fbPost(`/${page.id}/feed`, params);
      return result;
    }

    if (request.type === 'ADD_HISTORY') {
      await addHistory(request.entry);
      return { success: true };
    }

    if (request.type === 'SET_FB_TOKEN') {
      // รับเฉพาะ token ที่ขึ้นต้น EAA เท่านั้น
      if (request.token && request.token.startsWith('EAA') && request.token.length > 50) {
        await chrome.storage.local.set({
          userToken: request.token,
          tokenExpiry: Date.now() + 3600000
        });
      }
      return { success: true };
    }

    if (request.type === 'CLEAR_TOKEN') {
      await chrome.storage.local.remove(['userToken', 'tokenExpiry']);
      return { success: true };
    }

    if (request.type === 'SAVE_TOKEN') {
      await chrome.storage.local.set({
        userToken: request.token,
        tokenExpiry: Date.now() + 60 * 24 * 3600000 // 60 วัน
      });
      return { success: true };
    }

    if (request.type === 'GET_PAGES') {
      return getPages();
    }

    if (request.type === 'FETCH_OG') {
      return fetchOgData(request.url);
    }

    if (request.type === 'POST_NOW') {
      const { pages, link, message } = request;
      const results = {};
      for (const page of pages) {
        try {
          const res = await postToPage(page.id, page.access_token, { link, message });
          if (res.error) {
            results[page.id] = { success: false, error: res.error.message, pageName: page.name };
          } else {
            results[page.id] = { success: true, postId: res.id, pageName: page.name };
          }
        } catch (err) {
          results[page.id] = { success: false, error: err.message, pageName: page.name };
        }
      }
      const entry = {
        id: `bp_${Date.now()}`,
        link, message, pages,
        results,
        postedAt: Date.now(),
        type: 'immediate',
        status: 'done'
      };
      await addHistory(entry);
      return { results };
    }

    if (request.type === 'SCHEDULE_POST') {
      const { pages, postData, delay, scheduledTime } = request;
      const id = `bp_${Date.now()}`;
      const jobs = await getScheduledJobs();
      const job = {
        id, postData, pages,
        delay: delay || 0,
        scheduledTime,
        status: 'pending',
        createdAt: Date.now(),
        type: 'scheduled'
      };
      jobs.push(job);
      await saveScheduledJobs(jobs);
      // สร้าง alarm แยกต่างหากต่อเพจ — service worker ไม่ตายระหว่าง delay
      for (let i = 0; i < pages.length; i++) {
        const fireAt = scheduledTime + i * (delay || 0);
        chrome.alarms.create(`${id}_page_${i}`, { when: fireAt });
      }
      return { success: true, id };
    }

    if (request.type === 'GET_SCHEDULED') {
      const jobs = await getScheduledJobs();
      return jobs.filter(j => j.status === 'pending');
    }

    if (request.type === 'CANCEL_SCHEDULED') {
      const jobs = await getScheduledJobs();
      const j = jobs.find(j => j.id === request.id);
      if (j) {
        j.status = 'cancelled';
        await saveScheduledJobs(jobs);
        // ยกเลิก alarm ทุกเพจ
        for (let i = 0; i < (j.pages || []).length; i++) {
          await chrome.alarms.clear(`${request.id}_page_${i}`);
        }
      }
      return { success: true };
    }

    if (request.type === 'GET_HISTORY') {
      return getPostHistory();
    }

    if (request.type === 'CLEAR_HISTORY') {
      await chrome.storage.local.set({ postHistory: [] });
      return { success: true };
    }

    throw new Error(`Unknown type: ${request.type}`);
  };

  run().then(sendResponse).catch(e => sendResponse({ error: e.message }));
  return true;
}

chrome.runtime.onMessage.addListener(handleApiRequest);
chrome.runtime.onMessageExternal.addListener(handleApiRequest);
