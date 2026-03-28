// ===== Bulk Poster — background.js =====
// Service Worker: จัดการ Cookie, Facebook API, โพสต์, ตั้งเวลา

const WEB_URL = 'https://fb-carousel-scheduler.vercel.app';

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

async function extractUserToken() {
  // ใช้ token ที่ cache ไว้ถ้ายังไม่หมดอายุ
  const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
  if (userToken && tokenExpiry && Date.now() < tokenExpiry) return userToken;

  // ดึง token จากหน้า Facebook
  const resp = await fetch('https://www.facebook.com/', { headers: { Accept: 'text/html' } });
  const html = await resp.text();

  const patterns = [
    /"accessToken"\s*:\s*"(EAA[^"]{20,})"/,
    /access_token=(EAA[^&"]{20,})/,
    /"token"\s*:\s*"(EAA[^"]{20,})"/,
    /\"accessToken\":\"([^\"]+)\"/,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) {
      await chrome.storage.local.set({ userToken: m[1], tokenExpiry: Date.now() + 3600000 });
      return m[1];
    }
  }
  throw new Error('ไม่สามารถดึง Access Token ได้ — กรุณาเปิด Facebook.com ค้างไว้แล้วลองใหม่');
}

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

async function getPages() {
  const token = await extractUserToken();
  const data = await fbGet('/me/accounts?fields=id,name,access_token,picture.type(square){url}&limit=200', token);
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
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

async function executeJob(jobId) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status !== 'pending') return;

  job.status = 'posting';
  await saveScheduledJobs(jobs);

  const results = {};
  for (const page of job.pages) {
    try {
      const res = await postToPage(page.id, page.access_token, {
        link: job.link,
        message: job.message
      });
      if (res.error) {
        results[page.id] = { success: false, error: res.error.message, pageName: page.name };
      } else {
        results[page.id] = { success: true, postId: res.id, pageName: page.name };
      }
    } catch (err) {
      results[page.id] = { success: false, error: err.message, pageName: page.name };
    }
  }

  job.status = 'done';
  job.results = results;
  job.executedAt = Date.now();
  await saveScheduledJobs(jobs);

  await addHistory({ ...job, type: 'scheduled' });

  const ok = Object.values(results).filter(r => r.success).length;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Bulk Poster',
    message: `โพสต์สำเร็จ ${ok}/${job.pages.length} เพจ ✓`
  });
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith('bp_')) {
    executeJob(alarm.name);
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
      const { pages, link, message, scheduledTime } = request;
      const id = `bp_${Date.now()}`;
      const jobs = await getScheduledJobs();
      const job = {
        id, link, message, pages,
        scheduledTime,
        status: 'pending',
        createdAt: Date.now(),
        type: 'scheduled'
      };
      jobs.push(job);
      await saveScheduledJobs(jobs);
      chrome.alarms.create(id, { when: scheduledTime });
      return { success: true, id };
    }

    if (request.type === 'GET_SCHEDULED') {
      const jobs = await getScheduledJobs();
      return jobs.filter(j => j.status === 'pending');
    }

    if (request.type === 'CANCEL_SCHEDULED') {
      const jobs = await getScheduledJobs();
      const j = jobs.find(j => j.id === request.id);
      if (j) { j.status = 'cancelled'; await saveScheduledJobs(jobs); }
      await chrome.alarms.clear(request.id);
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
