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
  // ถ้ามี token อยู่ ใช้ได้เลย (long-lived token ไม่หมดอายุ)
  if (userToken && userToken.startsWith('EAA')) return userToken;
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

// อัพโหลดรูปขึ้น Ad Account — คืน image_hash
async function uploadAdImage(adAccountId, pageToken, imageDataUrl) {
  const cleanId = String(adAccountId).replace(/^act_/, '');
  const [header, base64] = imageDataUrl.split(',');
  const formData = new FormData();
  formData.append('access_token', pageToken);
  formData.append('bytes', base64);
  const resp = await fetch(`https://graph.facebook.com/v20.0/act_${cleanId}/adimages`, {
    method: 'POST',
    body: formData
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  // response: { images: { filename: { hash, url, ... } } }
  const firstKey = Object.keys(data.images || {})[0];
  if (!firstKey) throw new Error('Upload image failed');
  return { hash: data.images[firstKey].hash, url: data.images[firstKey].url };
}

// โพสต์ผ่าน Marketing API — 4 steps เหมือน feedkub
// [1/4] Upload image → image_hash
// [2/4] Create creative → creative_id
// [3/4] Poll post_id (วนรอ 10 ครั้ง)
// [4/4] Publish post
async function postViaAdsAPI(adAccountId, page, postData, userToken, scheduledTime) {
  const cleanId = String(adAccountId).replace(/^act_/, '');

  // ── [1/4] Upload image ──
  let imageHash = null;
  let imageUrl = null;
  if (postData.imageData) {
    const imgResult = await uploadAdImage(adAccountId, userToken, postData.imageData);
    imageHash = imgResult.hash;
    imageUrl = imgResult.url;
  }

  // ── [2/4] Create creative ──
  const linkData = { link: postData.link };
  if (postData.message)     linkData.message     = postData.message;
  if (postData.name)        linkData.name        = postData.name;
  if (postData.description) linkData.description = postData.description;
  if (postData.caption && /^(https?:\/\/|www\.)\S+/i.test(postData.caption)) linkData.caption = postData.caption;
  if (imageHash)            linkData.image_hash  = imageHash;
  if (postData.cta && postData.cta !== 'NO_BUTTON') {
    linkData.call_to_action = { type: postData.cta, value: { link: postData.link } };
  }

  const creativeForm = new FormData();
  creativeForm.append('access_token', userToken);
  creativeForm.append('object_story_spec', JSON.stringify({ page_id: page.id, link_data: linkData }));

  const creativeResp = await fetch(`https://graph.facebook.com/v20.0/act_${cleanId}/adcreatives`, {
    method: 'POST',
    body: creativeForm
  });
  const creativeData = await creativeResp.json();
  if (creativeData.error) {
    const detail = creativeData.error.error_user_msg || creativeData.error.message;
    throw new Error(detail);
  }
  const creativeId = creativeData.id;
  if (!creativeId) throw new Error('ไม่ได้รับ creative_id');

  // ── [3/4] Poll post_id (วนรอ 10 ครั้ง × 3 วินาที) ──
  let postId = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollResp = await fetch(
      `https://graph.facebook.com/v20.0/${creativeId}?fields=effective_object_story_id&access_token=${encodeURIComponent(userToken)}`
    );
    const pollData = await pollResp.json();
    if (pollData.effective_object_story_id) {
      postId = pollData.effective_object_story_id;
      break;
    }
  }
  if (!postId) throw new Error('ไม่สามารถดึง post_id ได้ (timeout 30s)');

  // ── [4/4] Publish ── (ถ้า schedule → ข้าม ให้ alarm publish ทีหลัง)
  if (!scheduledTime) {
    const publishResp = await fetch(`https://graph.facebook.com/v20.0/${postId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: page.access_token, is_published: 'true' })
    });
    const publishData = await publishResp.json();
    if (publishData.error) throw new Error('Publish failed: ' + publishData.error.message);
  }

  return { id: postId, pageToken: page.access_token, imageUrl };
}

// ── ตั้งเวลาโพสผ่าน Feed API + Redirect URL (Facebook native schedule) ──
// สร้าง redirect URL ที่มี OG tags → Facebook scrape แล้วสร้าง Card Link + ตั้งเวลาได้
async function scheduleViaFeedAPI(adAccountId, page, postData, userToken, scheduledTime) {
  // 1. Upload image → ได้ URL จาก Facebook CDN
  let imageUrl = null;
  if (postData.imageData) {
    const imgResult = await uploadAdImage(adAccountId, userToken, postData.imageData);
    imageUrl = imgResult.url;
  }

  // 2. สร้าง redirect URL พร้อม OG tags
  const params = new URLSearchParams();
  params.set('url', postData.link);
  if (postData.name) params.set('title', postData.name);
  if (postData.description) params.set('desc', postData.description);
  if (imageUrl) params.set('img', imageUrl);
  if (postData.caption) params.set('caption', postData.caption);
  const redirectUrl = `https://bulk-poster.vercel.app/api/r?${params.toString()}`;

  // 3. POST /{page_id}/feed พร้อม scheduled_publish_time
  const feedParams = new URLSearchParams();
  feedParams.set('access_token', page.access_token);
  feedParams.set('link', redirectUrl);
  if (postData.message) feedParams.set('message', postData.message);
  feedParams.set('published', 'false');
  feedParams.set('scheduled_publish_time', String(Math.floor(scheduledTime / 1000)));

  const resp = await fetch(`https://graph.facebook.com/v20.0/${page.id}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: feedParams
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  return { id: data.id, scheduled: true };
}

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

// Phase 1: สร้างโพส (step 1-3) แล้วเก็บ postId — ยังไม่ publish
async function preparePagePost(jobId, pageIndex) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status === 'cancelled') return;

  const page = job.pages[pageIndex];
  if (!page) return;

  const pd = job.postData || {};

  if (job.adAccountId) {
    const { userToken } = await chrome.storage.local.get('userToken');
    if (userToken) {
      try {
        // scheduledTime ทำให้ step 4 ข้าม publish → ได้ postId กลับมา
        const res = await postViaAdsAPI(job.adAccountId, page, pd, userToken, job.scheduledTime);
        // เก็บ postId ไว้ใน job สำหรับ publish ทีหลัง
        if (!job.preparedPosts) job.preparedPosts = {};
        job.preparedPosts[pageIndex] = { postId: res.id, pageId: page.id, pageToken: page.access_token };
        await updatePageStatus(jobId, pageIndex, 'prepared');
      } catch (err) {
        if (!job.results) job.results = {};
        job.results[page.id] = { success: false, error: err.message, pageName: page.name };
        await updatePageStatus(jobId, pageIndex, 'error', err.message);
      }
      await saveScheduledJobs(jobs);
      return;
    }
  }

  // Fallback: /{page_id}/feed — ตั้งเวลาผ่าน Facebook ได้เลย
  const params = { access_token: page.access_token };
  if (job.scheduledTime) {
    params.scheduled_publish_time = String(Math.floor(job.scheduledTime / 1000));
    params.published = 'false';
  }
  if (pd.link)    params.link    = pd.link;
  if (pd.message) params.message = pd.message;
  try {
    const res = await fbPost(`/${page.id}/feed`, params);
    if (res.error) throw new Error(res.error.message);
    if (!job.results) job.results = {};
    job.results[page.id] = { success: true, postId: res.id, pageName: page.name };
    await updatePageStatus(jobId, pageIndex, 'done');
  } catch (err) {
    if (!job.results) job.results = {};
    job.results[page.id] = { success: false, error: err.message, pageName: page.name };
    await updatePageStatus(jobId, pageIndex, 'error', err.message);
  }
  await saveScheduledJobs(jobs);
}

// Phase 2: Publish โพสที่เตรียมไว้ (ตรงเวลาที่ตั้ง)
async function publishPreparedPost(jobId, pageIndex) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status === 'cancelled') return;

  const page = job.pages[pageIndex];
  if (!page) return;

  const prepared = (job.preparedPosts || {})[pageIndex];
  if (!prepared) return;

  if (!job.results) job.results = {};

  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${prepared.postId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: prepared.pageToken, is_published: 'true' })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    job.results[page.id] = { success: true, postId: prepared.postId, pageName: page.name };
    await updatePageStatus(jobId, pageIndex, 'done');
  } catch (err) {
    job.results[page.id] = { success: false, error: err.message, pageName: page.name };
    await updatePageStatus(jobId, pageIndex, 'error', err.message);
  }

  await finalizeIfAllDone(jobs, job, jobId);
}

// ── ตั้งเวลาโพสทุกเพจ (ทำงาน background) ──
async function prepareScheduledJob(jobId, pages, postData, delay, scheduledTime, adAccountId) {
  const { userToken } = await chrome.storage.local.get('userToken');
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;

  const imageData = postData.imageData;
  const thumbnail = postData.thumbnail || null;
  delete job.postData.imageData; // ลดขนาด storage
  delete job.postData.thumbnail;

  if (!job.results) job.results = {};
  let okCount = 0;

  for (let i = 0; i < pages.length; i++) {
    try {
      if (adAccountId && userToken) {
        const pd = { ...postData, imageData };
        // สร้าง Card Link ผ่าน adcreatives (step 1-3) ยังไม่ publish
        const res = await postViaAdsAPI(adAccountId, pages[i], pd, userToken, scheduledTime);
        job.preparedPosts[i] = { postId: res.id, pageToken: res.pageToken };
        job.pageStatuses[i] = { status: 'waiting', fireAt: scheduledTime, error: null };
        okCount++;
      }
    } catch (err) {
      job.pageStatuses[i] = { status: 'error', fireAt: scheduledTime, error: err.message };
    }
    await saveScheduledJobs(jobs);

    // ดีเลย์ระหว่างเพจตอนสร้าง Card Link (ใช้ค่าจาก dropdown, ขั้นต่ำ 20 วิ)
    if (i < pages.length - 1) {
      const createDelay = Math.max(delay || 20000, 20000);
      await new Promise(r => setTimeout(r, createDelay));
    }
  }

  // ส่งข้อมูลไป server (QStash จะ publish ตรงเวลา — ปิด Chrome ได้)
  let serverOk = false;
  if (okCount > 0) {
    try {
      const serverPages = pages.map((p, i) => ({
        id: p.id,
        name: p.name,
        postId: job.preparedPosts[i]?.postId,
        pageToken: job.preparedPosts[i]?.pageToken,
      })).filter(p => p.postId);

      const resp = await fetch('https://bulk-poster.vercel.app/api/schedule', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bp-secret': 'bp_secret_2024',
        },
        body: JSON.stringify({
          jobId,
          pages: serverPages,
          scheduledTime,
          delay: delay || 0,
          postData: { link: postData.link, message: postData.message, name: postData.name, description: postData.description, caption: postData.caption, cta: postData.cta, thumbnail },
        }),
      });
      const srvData = await resp.json();
      if (srvData.success) serverOk = true;
    } catch (e) {
      console.warn('Server schedule failed, falling back to alarm:', e.message);
    }
  }

  // alarm ยังเก็บไว้เป็น fallback ถ้า server ไม่ได้
  job.status = okCount > 0 ? 'pending' : 'done';
  job.serverScheduled = serverOk;
  await saveScheduledJobs(jobs);

  chrome.notifications.create(`done_${jobId}`, {
    type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster',
    message: serverOk
      ? `✅ เตรียม Card Link สำเร็จ ${okCount}/${pages.length} เพจ — ปิด Chrome ได้เลย!`
      : `✅ เตรียม Card Link สำเร็จ ${okCount}/${pages.length} เพจ — เปิด Chrome ค้างไว้`
  });
}

// โพสต์ทันที (ไม่ schedule)
async function executePagePost(jobId, pageIndex) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status === 'cancelled') return;

  const page = job.pages[pageIndex];
  if (!page) return;

  const pd = job.postData || {};

  if (!job.results) job.results = {};

  if (job.adAccountId) {
    const { userToken } = await chrome.storage.local.get('userToken');
    if (userToken) {
      try {
        const res = await postViaAdsAPI(job.adAccountId, page, pd, userToken);
        if (res.error) {
          job.results[page.id] = { success: false, error: res.error.message || res.error, pageName: page.name };
          await updatePageStatus(jobId, pageIndex, 'error', res.error.message || res.error);
        } else {
          job.results[page.id] = { success: true, postId: res.id, pageName: page.name };
          await updatePageStatus(jobId, pageIndex, 'done');
        }
      } catch (err) {
        job.results[page.id] = { success: false, error: err.message, pageName: page.name };
        await updatePageStatus(jobId, pageIndex, 'error', err.message);
      }
      await finalizeIfAllDone(jobs, job, jobId);
      return;
    }
  }

  // Fallback: /{page_id}/feed
  const params = { access_token: page.access_token, published: 'true' };
  if (pd.link)    params.link    = pd.link;
  if (pd.message) params.message = pd.message;
  if (pd.imageData) {
    try {
      const photoId = await uploadPhotoToPage(page.id, page.access_token, pd.imageData);
      params.object_attachment = photoId;
    } catch (e) {
      console.warn('Photo upload failed:', e.message);
    }
  }

  try {
    const res = await fbPost(`/${page.id}/feed`, params);
    if (res.error) {
      job.results[page.id] = { success: false, error: res.error.message, pageName: page.name };
      await updatePageStatus(jobId, pageIndex, 'error', res.error.message);
    } else {
      job.results[page.id] = { success: true, postId: res.id, pageName: page.name };
      await updatePageStatus(jobId, pageIndex, 'done');
    }
  } catch (err) {
    job.results[page.id] = { success: false, error: err.message, pageName: page.name };
    await updatePageStatus(jobId, pageIndex, 'error', err.message);
  }

  await finalizeIfAllDone(jobs, job, jobId);
}

// ตรวจว่าครบทุกเพจแล้วหรือยัง → ถ้าครบ mark done + history + notification
async function finalizeIfAllDone(jobs, job, jobId) {
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

  // ── Alarm: publish เพจเดียว ──
  const pubMatch = alarm.name.match(/^(bp_\d+)_pub_(\d+)$/);
  if (pubMatch) {
    const jobId = pubMatch[1];
    const idx = parseInt(pubMatch[2]);
    (async () => {
      try {
        const jobs = await getScheduledJobs();
        const job = jobs.find(j => j.id === jobId);
        if (!job || job.status === 'cancelled') return;

        // ถ้า prepare ยังไม่เสร็จ → retry ใน 10 วิ
        const p = (job.preparedPosts || {})[idx];
        if (!p || !p.postId) {
          if (job.status === 'preparing') {
            chrome.alarms.create(alarm.name, { when: Date.now() + 10000 });
          }
          return;
        }

        chrome.notifications.create(`pub_${jobId}_${idx}`, {
          type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster',
          message: `📤 Publish เพจ ${idx + 1}: ${job.pages[idx]?.name || ''}`
        });

        if (!job.results) job.results = {};
        const resp = await fetch(`https://graph.facebook.com/v20.0/${p.postId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: p.pageToken, is_published: 'true' })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message);

        job.results[job.pages[idx].id] = { success: true, postId: p.postId, pageName: job.pages[idx].name };
        job.pageStatuses[idx] = { status: 'done', fireAt: job.scheduledTime, error: null };

        // เช็คครบทุกเพจหรือยัง
        const total = job.pages.length;
        const doneCount = Object.keys(job.results).length;
        if (doneCount >= total) {
          job.status = 'done';
          job.executedAt = Date.now();
          await saveScheduledJobs(jobs);
          await addHistory({ ...job, type: 'scheduled' });
          const ok = Object.values(job.results).filter(r => r.success).length;
          chrome.notifications.create(`done_${jobId}`, {
            type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster',
            message: `✅ Publish สำเร็จ ${ok}/${total} เพจ`
          });
        } else {
          await saveScheduledJobs(jobs);
        }
      } catch (err) {
        const jobs = await getScheduledJobs();
        const job = jobs.find(j => j.id === jobId);
        if (job) {
          if (!job.results) job.results = {};
          job.results[job.pages[idx]?.id] = { success: false, error: err.message, pageName: job.pages[idx]?.name };
          job.pageStatuses[idx] = { status: 'error', fireAt: job.scheduledTime, error: err.message };
          await saveScheduledJobs(jobs);
        }
        chrome.notifications.create(`err_${jobId}_${idx}`, {
          type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster — Error',
          message: `❌ ${job?.pages[idx]?.name}: ${err.message}`
        });
      }
    })();
    return;
  }

  // ── Alarm เดิม: POST_TO_PAGE immediate (ไม่ใช้แล้วสำหรับ schedule ใหม่) ──
  const m = alarm.name.match(/^(bp_\d+)_page_(\d+)$/);
  if (m) {
    const jobId = m[1];
    const pageIdx = parseInt(m[2]);
    updatePageStatus(jobId, pageIdx, 'posting').then(async () => {
      try {
        await executePagePost(jobId, pageIdx);
      } catch (err) {
        chrome.notifications.create(`err_${alarm.name}`, {
          type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster — Error',
          message: `❌ ${err.message}`
        });
      }
    });
  }
});

// อัพเดท status ของเพจใน job
async function updatePageStatus(jobId, pageIdx, status, error) {
  const jobs = await getScheduledJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;
  if (!job.pageStatuses) job.pageStatuses = {};
  job.pageStatuses[pageIdx] = { status, error: error || null, updatedAt: Date.now() };
  // ถ้ามีเพจใดกำลังโพสอยู่ → job status = posting
  if (status === 'posting' && job.status === 'pending') {
    job.status = 'posting';
  }
  await saveScheduledJobs(jobs);
}

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
      const { userToken } = await chrome.storage.local.get('userToken');
      const token = userToken || await getOrExtractToken();
      let data = await fbGet('/me/adaccounts?fields=id,name&limit=100', token);
      if (data.error && !token) {
        const extracted = await extractAndSaveToken();
        if (extracted) data = await fbGet('/me/adaccounts?fields=id,name&limit=100', extracted);
      }
      return data;
    }

    if (request.type === 'CHECK_TOKEN') {
      const { userToken, tokenExpiry } = await chrome.storage.local.get(['userToken', 'tokenExpiry']);
      return {
        hasToken: !!userToken,
        tokenPrefix: userToken ? userToken.substring(0, 15) + '...' : null,
        expiry: tokenExpiry,
        expired: tokenExpiry ? Date.now() > tokenExpiry : true,
      };
    }

    if (request.type === 'POST_TO_PAGE') {
      const { page, postData, adAccountId } = request;

      // ถ้ามี Ad Account → ใช้ Marketing API (รองรับ custom title/desc/cta/รูป)
      if (adAccountId) {
        const { userToken } = await chrome.storage.local.get('userToken');
        if (userToken) {
          const result = await postViaAdsAPI(adAccountId, page, postData, userToken);
          return result;
        }
      }

      // Fallback: /{page_id}/feed + object_attachment
      const params = { access_token: page.access_token, published: 'true' };
      if (postData.link)    params.link    = postData.link;
      if (postData.message) params.message = postData.message;
      if (postData.imageData) {
        try {
          const photoId = await uploadPhotoToPage(page.id, page.access_token, postData.imageData);
          params.object_attachment = photoId;
        } catch (e) {
          console.warn('Photo upload failed:', e.message);
        }
      }
      const result = await fbPost(`/${page.id}/feed`, params);
      return result;
    }

    // ── Bulk Post Now — ทำทั้งหมดใน service worker ปิดแท็บได้ ──
    if (request.type === 'BULK_POST_NOW') {
      const { pages, postData, delay, adAccountId } = request;
      const { userToken } = await chrome.storage.local.get('userToken');

      // ตอบกลับทันทีว่ารับงานแล้ว — ทำงานต่อใน background
      const jobId = `bp_now_${Date.now()}`;

      // ทำงานใน background (ไม่ block response)
      (async () => {
        const results = {};
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          try {
            let res;
            if (adAccountId && userToken) {
              res = await postViaAdsAPI(adAccountId, page, postData, userToken);
              results[page.id] = { success: true, postId: res.id, pageName: page.name };
            } else {
              const params = { access_token: page.access_token, published: 'true' };
              if (postData.link)    params.link    = postData.link;
              if (postData.message) params.message = postData.message;
              res = await fbPost(`/${page.id}/feed`, params);
              if (res.error) {
                results[page.id] = { success: false, error: res.error.message, pageName: page.name };
              } else {
                results[page.id] = { success: true, postId: res.id, pageName: page.name };
              }
            }
          } catch (err) {
            results[page.id] = { success: false, error: err.message, pageName: page.name };
          }

          // อัพเดท progress ใน storage ให้ UI poll ได้
          await chrome.storage.local.set({
            [`bulkProgress_${jobId}`]: {
              done: i + 1,
              total: pages.length,
              currentPage: page.name,
              results: { ...results },
            }
          });

          // delay ระหว่างเพจ
          if (delay > 0 && i < pages.length - 1) {
            await new Promise(r => setTimeout(r, Math.min(delay, 30 * 60000)));
          }
        }

        // บันทึกประวัติ
        await addHistory({
          id: jobId,
          link: postData.link, message: postData.message,
          pages, results, postedAt: Date.now(), type: 'immediate', status: 'done'
        });

        // แจ้งเตือน
        const okCount = Object.values(results).filter(r => r.success).length;
        chrome.notifications.create(`done_${jobId}`, {
          type: 'basic', iconUrl: 'icon128.png', title: 'Bulk Poster',
          message: `โพสต์เสร็จ! สำเร็จ ${okCount}/${pages.length} เพจ`
        });

        // ลบ progress
        await chrome.storage.local.remove(`bulkProgress_${jobId}`);
      })();

      return { success: true, jobId };
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
      const { pages, postData, delay, scheduledTime, adAccountId } = request;
      const id = `bp_${Date.now()}`;
      const jobs = await getScheduledJobs();
      const pageStatuses = {};
      for (let i = 0; i < pages.length; i++) {
        pageStatuses[i] = { status: 'preparing', fireAt: scheduledTime, error: null };
      }
      const job = {
        id, postData, pages,
        delay: delay || 0,
        scheduledTime,
        adAccountId: adAccountId || null,
        status: 'preparing',
        createdAt: Date.now(),
        type: 'scheduled',
        pageStatuses,
        preparedPosts: {}
      };
      jobs.push(job);
      await saveScheduledJobs(jobs);

      // สร้าง alarm แยกต่อเพจ — 1 alarm = 1 เพจ = 1 API call
      for (let i = 0; i < pages.length; i++) {
        const fireAt = scheduledTime + i * (delay || 0);
        chrome.alarms.create(`${id}_pub_${i}`, { when: fireAt });
      }
      // เตรียมโพสใน background
      prepareScheduledJob(id, pages, postData, delay, scheduledTime, adAccountId);
      return { success: true, id, jobId: id };
    }

    if (request.type === 'GET_JOB_STATUS') {
      const jobs = await getScheduledJobs();
      const job = jobs.find(j => j.id === request.jobId);
      if (!job) return { error: 'ไม่พบ job' };
      return {
        id: job.id,
        status: job.status,
        pageStatuses: job.pageStatuses || {},
        results: job.results || {},
        pages: job.pages,
        scheduledTime: job.scheduledTime,
        delay: job.delay
      };
    }

    if (request.type === 'GET_SCHEDULED') {
      const jobs = await getScheduledJobs();
      return jobs.filter(j => j.status === 'pending' || j.status === 'posting' || j.status === 'preparing');
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
