// ===== Bulk Poster — app.js =====

// ─── Extension Bridge ─────────────────────────────────────────
let extReady = false;
const pending = {};

window.addEventListener('message', (e) => {
  if (!e.data || e.data.direction !== 'from-content-script') return;
  if (e.data.status === 'ready') { extReady = true; init(); return; }
  const cb = pending[e.data.messageId];
  if (cb) { delete pending[e.data.messageId]; cb(e.data.response); }
});

function sendExt(message) {
  return new Promise((resolve, reject) => {
    if (!extReady) return reject(new Error('Extension ไม่ได้เชื่อมต่อ'));
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      delete pending[id];
      reject(new Error('หมดเวลารอ Extension'));
    }, 45000);
    pending[id] = (res) => {
      clearTimeout(timer);
      if (!res) return reject(new Error('ไม่ได้รับการตอบกลับ'));
      if (res.error) return reject(new Error(typeof res.error === 'object' ? (res.error.message || JSON.stringify(res.error)) : res.error));
      resolve(res);
    };
    window.postMessage({ direction: 'from-page-script', messageId: id, message }, '*');
  });
}

// ─── Ping ─────────────────────────────────────────────────────
let pingCount = 0;
const pingTimer = setInterval(() => {
  if (extReady) { clearInterval(pingTimer); return; }
  window.postMessage({ type: 'BP_PING' }, '*');
  if (++pingCount >= 10) {
    clearInterval(pingTimer);
    if (!extReady) {
      document.getElementById('connectScreen').style.display = 'none';
      document.getElementById('noExtScreen').style.display = '';
    }
  }
}, 500);

// ── ตรวจจับ extension context invalidated → แจ้งเตือน refresh ──
let wasReady = false;
setInterval(() => {
  if (extReady && !wasReady) wasReady = true;
  if (!wasReady) return;
  // เคย connect ได้ ลอง ping ดูว่ายัง alive ไหม
  const testId = '_hb_' + Math.random().toString(36).slice(2);
  let replied = false;
  pending[testId] = () => { replied = true; };
  window.postMessage({ direction: 'from-page-script', messageId: testId, message: { type: 'GET_PAGES' } }, '*');
  setTimeout(() => {
    delete pending[testId];
    if (!replied && wasReady) {
      extReady = false;
      wasReady = false;
      // แสดงแจ้งเตือน
      if (!document.getElementById('extLostBanner')) {
        const banner = document.createElement('div');
        banner.id = 'extLostBanner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;text-align:center;padding:12px;font-weight:600;cursor:pointer;font-size:14px;';
        banner.textContent = '⚠️ Extension ขาดการเชื่อมต่อ — คลิกที่นี่เพื่อ Refresh';
        banner.onclick = () => location.reload();
        document.body.appendChild(banner);
      }
    }
  }, 3000);
}, 30000); // เช็คทุก 30 วินาที

// ── ซ่อน ping timer เดิม (ด้านบน) ── จบที่นี่
}, 500);

// ─── State ────────────────────────────────────────────────────
let pages = [];
let selectedIds = new Set();
let isPosting = false;

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  document.getElementById('noExtScreen').style.display = 'none';
  document.getElementById('connectScreen').style.display = '';
}

function showApp() {
  document.getElementById('connectScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
}

// ─── Connect ─────────────────────────────────────────────────
document.getElementById('btnSaveToken')?.addEventListener('click', async () => {
  const token = document.getElementById('manualToken').value.trim();
  const err = document.getElementById('connectError');
  if (!token) { err.textContent = '⚠ กรุณาวาง Token ก่อน'; err.style.display = ''; return; }
  if (!token.startsWith('EAA')) { err.textContent = '⚠ Token ต้องขึ้นต้นด้วย EAA'; err.style.display = ''; return; }
  err.style.display = 'none';
  const btn = document.getElementById('btnSaveToken');
  btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ...';
  try {
    await sendExt({ type: 'SAVE_TOKEN', token });
    await sendExt({ type: 'PREPARE_COOKIES' });
    showApp(); loadPages(); loadAdAccounts();
  } catch (e) {
    err.textContent = '⚠ ' + e.message; err.style.display = '';
    btn.disabled = false; btn.textContent = 'เชื่อมต่อ';
  }
});

document.getElementById('btnConnect').addEventListener('click', async () => {
  const btn = document.getElementById('btnConnect');
  const err = document.getElementById('connectError');
  btn.disabled = true; btn.textContent = 'กำลังเชื่อมต่อ...'; err.style.display = 'none';
  try {
    await sendExt({ type: 'PREPARE_COOKIES' });
    localStorage.setItem('bp_connected', 'true');
    showApp(); loadPages(); loadAdAccounts();
  } catch (e) {
    err.textContent = '⚠ ' + e.message; err.style.display = '';
    btn.disabled = false; btn.textContent = '🔌 เชื่อมต่อ Facebook';
  }
});

// ─── Pages ────────────────────────────────────────────────────
async function loadPages() {
  const el = document.getElementById('pagesList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลดเพจ...</div>`;
  try {
    const res = await sendExt({ type: 'GET_PAGES' });
    pages = res.data || [];
    if (!pages.length) { el.innerHTML = `<div class="loading-row">ไม่พบเพจ</div>`; return; }
    renderPages();
  } catch (e) {
    if (e.message === 'TOKEN_REQUIRED') {
      el.innerHTML = `<div class="loading-row" style="color:#f0a500">
        ⚠ ไม่พบ Access Token<br/>
        <small>กรุณาเปิด <a href="https://www.facebook.com" target="_blank" style="color:var(--primary)">facebook.com</a> ในแท็บอื่นค้างไว้ แล้วกด 🔄 โหลดใหม่</small>
      </div>`;
    } else {
      el.innerHTML = `<div class="loading-row" style="color:var(--danger)">⚠ ${e.message}</div>`;
    }
  }
}

function renderPages() {
  const el = document.getElementById('pagesList');
  el.innerHTML = '';
  pages.forEach(p => {
    const div = document.createElement('label');
    div.className = 'page-check-item' + (selectedIds.has(p.id) ? ' checked' : '');
    div.innerHTML = `<input type="checkbox" ${selectedIds.has(p.id) ? 'checked' : ''} /><div class="page-cb"></div><span class="page-label">${p.name}</span>`;
    div.addEventListener('click', (e) => {
      e.preventDefault();
      selectedIds.has(p.id) ? selectedIds.delete(p.id) : selectedIds.add(p.id);
      div.classList.toggle('checked');
      updateCount();
    });
    el.appendChild(div);
  });
  updateCount();
}

function updateCount() {
  const n = selectedIds.size;
  document.getElementById('selCountLabel').textContent = n ? `เลือก ${n}/${pages.length} เพจ` : '';
}

document.getElementById('btnAll').addEventListener('click', () => { pages.forEach(p => selectedIds.add(p.id)); renderPages(); });
document.getElementById('btnNone').addEventListener('click', () => { selectedIds.clear(); renderPages(); });
document.getElementById('btnReload').addEventListener('click', loadPages);

// ─── Ad Accounts ──────────────────────────────────────────────
async function loadAdAccounts() {
  const sel = document.getElementById('adAccountSel');
  try {
    const res = await sendExt({ type: 'GET_AD_ACCOUNTS' });
    const accounts = res.data || [];
    sel.innerHTML = accounts.length
      ? accounts.map(a => `<option value="${a.id}">${a.name} (${a.id})</option>`).join('')
      : '<option value="">ไม่พบ Ad Account</option>';
  } catch {
    sel.innerHTML = '<option value="">ไม่สามารถโหลด Ad Account</option>';
  }
}

// ─── Link Preview ─────────────────────────────────────────────
document.getElementById('destLink').addEventListener('blur', async function () {
  const url = this.value.trim();
  if (!url || !url.startsWith('http')) return;
  try {
    const og = await sendExt({ type: 'FETCH_OG', url });
    if (og.title && !document.getElementById('cardTitle').value)
      document.getElementById('cardTitle').value = og.title;
    if (og.description && !document.getElementById('cardDesc').value)
      document.getElementById('cardDesc').value = og.description;
    // show OG preview
    document.getElementById('ogSite').textContent  = og.siteName || '';
    document.getElementById('ogTitle').textContent = og.title || '';
    document.getElementById('ogDesc').textContent  = og.description || '';
    document.getElementById('ogPreviewWrap').style.display = '';
    if (og.image) {
      const img = document.getElementById('imagePreview');
      img.src = og.image;
      img.style.display = '';
      document.getElementById('imagePrompt').style.display = 'none';
    }
  } catch {}
});

// ─── Image Upload ─────────────────────────────────────────────
const imageDrop = document.getElementById('imageDrop');
const imageFile = document.getElementById('imageFile');
let currentImageData = null; // base64 data URL ของรูปที่เลือก

imageDrop.addEventListener('click', () => imageFile.click());
imageFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    currentImageData = ev.target.result;
    document.getElementById('imagePreview').src = ev.target.result;
    document.getElementById('imagePreview').style.display = '';
    document.getElementById('imagePrompt').style.display = 'none';
  };
  reader.readAsDataURL(file);
});
imageDrop.addEventListener('dragover', e => { e.preventDefault(); imageDrop.style.borderColor = 'var(--primary)'; });
imageDrop.addEventListener('dragleave', () => { imageDrop.style.borderColor = ''; });
imageDrop.addEventListener('drop', e => {
  e.preventDefault(); imageDrop.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) { imageFile.files = e.dataTransfer.files; imageFile.dispatchEvent(new Event('change')); }
});

// ─── Schedule Toggle ──────────────────────────────────────────
document.getElementById('schedToggle').addEventListener('change', function () {
  document.getElementById('schedBlock').style.display = this.checked ? '' : 'none';
  document.getElementById('postIcon').textContent  = this.checked ? '⏰' : '🚀';
  document.getElementById('postLabel').textContent = this.checked ? 'ตั้งเวลาโพส' : 'โพสต์ทันที';
  if (this.checked) {
    const dt = new Date(Date.now() + 3600000);
    document.getElementById('schedDT').value =
      new Date(dt - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
});

// ─── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'scheduled') loadScheduled();
    if (btn.dataset.tab === 'history') loadHistory();
  });
});

// ─── Post ─────────────────────────────────────────────────────
document.getElementById('btnPost').addEventListener('click', async () => {
  if (isPosting) return;
  const link        = document.getElementById('destLink').value.trim();
  const message     = document.getElementById('postMsg').value.trim();
  const name        = document.getElementById('cardTitle').value.trim();
  const description = document.getElementById('cardDesc').value.trim();
  const caption     = (document.getElementById('displayLink') || {}).value?.trim() || '';
  const cta         = document.getElementById('ctaSel').value;
  const delay       = parseInt(document.getElementById('delaySel').value) || 0;
  const isSchedule  = document.getElementById('schedToggle').checked;
  const adAccountId = document.getElementById('adAccountSel').value || null;

  if (!link) return alert('กรุณาใส่ Destination Link');
  if (!selectedIds.size) return alert('กรุณาเลือกเพจอย่างน้อย 1 เพจ');

  const selPages = pages.filter(p => selectedIds.has(p.id));
  const postData = { link, message, name, description, caption, cta, imageData: currentImageData };

  if (isSchedule) {
    const dtVal = document.getElementById('schedDT').value;
    if (!dtVal) return alert('กรุณาเลือกวันและเวลา');
    const ts = new Date(dtVal).getTime();
    if (ts <= Date.now()) return alert('กรุณาเลือกเวลาในอนาคต');
    await doSchedule(selPages, postData, delay, ts, adAccountId);
  } else {
    await doPostNow(selPages, postData, delay, adAccountId);
  }
});

async function doPostNow(selPages, postData, delay, adAccountId) {
  isPosting = true;
  const btn     = document.getElementById('btnPost');
  const progEl  = document.getElementById('progressWrap');
  const bar     = document.getElementById('progressBar');
  const label   = document.getElementById('progressLabel');
  const logEl   = document.getElementById('progressLog');

  btn.disabled = true;
  progEl.style.display = '';
  logEl.innerHTML = '';
  bar.style.width = '0%';

  for (let i = 0; i < selPages.length; i++) {
    const page = selPages[i];
    const pct  = Math.round(((i + 1) / selPages.length) * 100);

    label.textContent = `${i + 1}/${selPages.length} — ${page.name}`;
    bar.style.width   = pct + '%';

    const logRow = document.createElement('div');
    logRow.className = 'log-row log-pending';
    logRow.textContent = `⏳ ${page.name}`;
    logEl.appendChild(logRow);
    logEl.scrollTop = logEl.scrollHeight;

    try {
      const res = await sendExt({ type: 'POST_TO_PAGE', page, postData, adAccountId });
      if (res.error || (res.data && res.data.error)) {
        const errMsg = res.error?.message || res.data?.error?.message || 'ผิดพลาด';
        logRow.className = 'log-row log-err';
        logRow.textContent = `✗ ${page.name} — ${errMsg}`;
      } else {
        logRow.className = 'log-row log-ok';
        logRow.textContent = `✓ ${page.name}`;
      }
    } catch (e) {
      logRow.className = 'log-row log-err';
      logRow.textContent = `✗ ${page.name} — ${e.message}`;
    }

    // delay ระหว่างเพจ
    if (delay > 0 && i < selPages.length - 1) {
      const delayMin = Math.round(delay / 60000);
      label.textContent = `รอ ${delayMin} นาที ก่อนโพสต์เพจถัดไป...`;
      await sleep(delay);
    }
  }

  label.textContent = `เสร็จแล้ว! โพสต์ครบ ${selPages.length} เพจ ✓`;
  bar.style.width = '100%';
  isPosting = false;
  btn.disabled = false;

  // บันทึกประวัติ
  await sendExt({ type: 'ADD_HISTORY', entry: { link: postData.link, message: postData.message, pages: selPages, postedAt: Date.now(), type: 'immediate' } }).catch(() => {});
}

async function doSchedule(selPages, postData, delay, scheduledTime, adAccountId) {
  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  try {
    const res = await sendExt({ type: 'SCHEDULE_POST', pages: selPages, postData, delay, scheduledTime, adAccountId });
    const jobId = res.jobId || res.id;
    const confirmEl = document.getElementById('schedConfirm');
    confirmEl.innerHTML = `
      ✅ <strong>ตั้งเวลาสำเร็จ!</strong><br/>
      📅 เริ่มโพส: ${fmtDate(scheduledTime)}<br/>
      📄 จำนวน: ${selPages.length} เพจ<br/>
      ${delay ? `⏱ ห่างระหว่างเพจ: ${Math.round(delay/60000)} นาที` : ''}
    `;
    confirmEl.style.display = '';
    loadScheduled();
    updateSchedBadge();
    // เริ่ม polling สถานะ
    if (jobId) startJobPolling(jobId);
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ─── Live Job Status Polling ──────────────────────────────────
let activePollingJobId = null;
let pollingTimer = null;

function startJobPolling(jobId) {
  // หยุด polling เก่า
  if (pollingTimer) clearInterval(pollingTimer);
  activePollingJobId = jobId;

  // สลับไปแท็บตั้งเวลา
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="scheduled"]').classList.add('active');
  document.getElementById('tab-scheduled').classList.add('active');

  // poll ทุก 3 วินาที
  pollJobStatus(jobId);
  pollingTimer = setInterval(() => pollJobStatus(jobId), 3000);
}

async function pollJobStatus(jobId) {
  try {
    const res = await sendExt({ type: 'GET_JOB_STATUS', jobId });
    if (res.error) return;
    renderJobLiveStatus(res);
    // หยุด poll ถ้า job เสร็จแล้ว
    if (res.status === 'done' || res.status === 'cancelled') {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = null;
      activePollingJobId = null;
      loadScheduled();
      updateSchedBadge();
    }
  } catch {}
}

function renderJobLiveStatus(job) {
  const el = document.getElementById('schedList');
  const pages = job.pages || [];
  const statuses = job.pageStatuses || {};
  const results = job.results || {};

  let html = `<div class="live-status-card">`;
  html += `<div class="live-status-header">`;
  html += `<span class="live-pulse ${job.status === 'posting' ? 'active' : ''}"></span>`;
  html += `<strong>${job.status === 'done' ? '✅ โพสต์เสร็จแล้ว' : job.status === 'posting' ? '🔄 กำลังโพสต์...' : '⏰ รอเวลาโพสต์'}</strong>`;
  html += `</div>`;

  // สรุป
  const doneCount = Object.values(statuses).filter(s => s.status === 'done').length;
  const errorCount = Object.values(statuses).filter(s => s.status === 'error').length;
  const postingCount = Object.values(statuses).filter(s => s.status === 'posting').length;
  const waitingCount = pages.length - doneCount - errorCount - postingCount;

  html += `<div class="live-summary">`;
  if (doneCount) html += `<span class="live-badge lb-done">✅ ${doneCount}</span>`;
  if (postingCount) html += `<span class="live-badge lb-posting">🔄 ${postingCount}</span>`;
  if (errorCount) html += `<span class="live-badge lb-error">❌ ${errorCount}</span>`;
  if (waitingCount > 0) html += `<span class="live-badge lb-waiting">⏳ ${waitingCount}</span>`;
  html += `</div>`;

  // แต่ละเพจ
  html += `<div class="live-page-list">`;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const ps = statuses[i] || { status: 'waiting' };
    const result = results[page.id];
    let icon, cls, detail = '';

    if (ps.status === 'done' || (result && result.success)) {
      icon = '✅'; cls = 'lp-done';
    } else if (ps.status === 'error' || (result && !result.success)) {
      icon = '❌'; cls = 'lp-error';
      detail = ps.error || result?.error || 'ไม่ทราบสาเหตุ';
    } else if (ps.status === 'posting') {
      icon = '🔄'; cls = 'lp-posting';
      detail = 'กำลังโพสต์...';
    } else {
      icon = '⏳'; cls = 'lp-waiting';
      if (ps.fireAt) detail = 'โพสเวลา ' + fmtTime(ps.fireAt);
    }

    html += `<div class="live-page-row ${cls}">`;
    html += `<span class="lp-icon">${icon}</span>`;
    html += `<span class="lp-name">${page.name}</span>`;
    if (detail) html += `<span class="lp-detail">${detail}</span>`;
    html += `</div>`;
  }
  html += `</div></div>`;

  el.innerHTML = html;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

// ─── Scheduled ────────────────────────────────────────────────
async function loadScheduled() {
  const el = document.getElementById('schedList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลด...</div>`;
  try {
    const res = await sendExt({ type: 'GET_SCHEDULED' });
    const jobs = Array.isArray(res) ? res : [];
    renderScheduled(jobs);
    updateSchedBadge(jobs.length);
  } catch (e) {
    el.innerHTML = `<div class="loading-row" style="color:var(--danger)">⚠ ${e.message}</div>`;
  }
}

function renderScheduled(jobs) {
  const el = document.getElementById('schedList');
  // ถ้ากำลัง polling อยู่ → ไม่ต้อง render ทับ (pollJobStatus จะ render เอง)
  if (activePollingJobId && jobs.some(j => j.id === activePollingJobId)) return;

  if (!jobs.length) { el.innerHTML = `<div class="empty-state">📅 ยังไม่มีรายการตั้งเวลา</div>`; return; }
  el.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'job-list';
  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';

    // สร้าง per-page status HTML
    const statuses = job.pageStatuses || {};
    let pagesHtml = '';
    (job.pages || []).forEach((p, i) => {
      const ps = statuses[i] || { status: 'waiting' };
      let icon;
      if (ps.status === 'done') icon = '✅';
      else if (ps.status === 'error') icon = '❌';
      else if (ps.status === 'posting') icon = '🔄';
      else icon = '⏳';
      pagesHtml += `<span class="page-status-chip">${icon} ${p.name}</span>`;
    });

    const pd = job.postData || {};
    const thumbHtml = pd.imageData ? `<img src="${pd.imageData}" class="job-thumb" />` : '';
    const msgPreview = pd.message ? `<div class="job-msg">"${trunc(pd.message, 80)}"</div>` : '';
    const detailParts = [];
    if (pd.name) detailParts.push(`<b>Card Title:</b> ${escHtml(pd.name)}`);
    if (pd.description) detailParts.push(`<b>Description:</b> ${escHtml(pd.description)}`);
    if (pd.caption) detailParts.push(`<b>Display Link:</b> ${escHtml(pd.caption)}`);
    if (pd.cta && pd.cta !== 'NO_BUTTON') detailParts.push(`<b>CTA:</b> ${escHtml(pd.cta)}`);
    const detailHtml = detailParts.length ? `<div class="job-details">${detailParts.join(' · ')}</div>` : '';

    card.innerHTML = `
      <div class="job-row1">
        <span class="job-badge ${job.status === 'posting' ? 'jb-posting' : 'jb-sched'}">${job.status === 'posting' ? '🔄 กำลังโพส' : '⏰ ตั้งเวลา'}</span>
        <a href="${pd.link || job.link || ''}" target="_blank" class="job-link">${trunc(pd.link || job.link || '', 50)}</a>
      </div>
      <div class="job-preview">
        ${thumbHtml}
        <div class="job-preview-text">
          ${msgPreview}
          ${detailHtml}
        </div>
      </div>
      <div class="job-meta">
        <span>🕐 ${fmtDate(job.scheduledTime)}</span>
        <span>${job.pages?.length || 0} เพจ ${job.delay ? '· ห่าง ' + Math.round(job.delay/60000) + ' นาที' : ''}</span>
      </div>
      <div class="job-page-statuses">${pagesHtml}</div>
      <div class="job-actions">
        <button class="btn btn-ghost btn-sm" style="color:var(--primary)" data-track="${job.id}">📊 ดูสถานะ</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-id="${job.id}">ยกเลิก</button>
      </div>
    `;
    card.querySelector('[data-id]').addEventListener('click', async (e) => {
      if (!confirm('ยืนยันยกเลิก?')) return;
      await sendExt({ type: 'CANCEL_SCHEDULED', id: e.target.dataset.id });
      loadScheduled();
    });
    card.querySelector('[data-track]').addEventListener('click', () => {
      startJobPolling(job.id);
    });
    list.appendChild(card);
  });
  el.appendChild(list);
}

async function updateSchedBadge(n) {
  if (n === undefined) {
    const res = await sendExt({ type: 'GET_SCHEDULED' }).catch(() => []);
    n = Array.isArray(res) ? res.length : 0;
  }
  const badge = document.getElementById('schedBadge');
  badge.textContent = n; badge.style.display = n ? '' : 'none';
}

// auto-refresh scheduled list ทุก 30 วินาที
setInterval(async () => {
  const tab = document.querySelector('.tab-btn.active');
  if (tab && tab.dataset.tab === 'scheduled' && !activePollingJobId) loadScheduled();
  updateSchedBadge();
}, 30000);

// ─── History ──────────────────────────────────────────────────
async function loadHistory() {
  const el = document.getElementById('histList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลด...</div>`;
  try {
    const res = await sendExt({ type: 'GET_HISTORY' });
    const hist = Array.isArray(res) ? res : [];
    if (!hist.length) { el.innerHTML = `<div class="empty-state">📊 ยังไม่มีประวัติ</div>`; return; }
    const list = document.createElement('div');
    list.className = 'job-list';
    hist.slice(0, 50).forEach(job => {
      const card = document.createElement('div');
      card.className = 'job-card';
      const link = job.postData?.link || job.link || '';
      const results = job.results || {};
      const okPages = Object.values(results).filter(r => r.success);
      const failPages = Object.values(results).filter(r => !r.success);
      const resultHtml = Object.keys(results).length
        ? `<div class="job-results">
            ${okPages.map(r => `<div class="res-row res-ok">✅ ${r.pageName}</div>`).join('')}
            ${failPages.map(r => `<div class="res-row res-fail">❌ ${r.pageName}: ${r.error || 'ไม่ทราบสาเหตุ'}</div>`).join('')}
           </div>`
        : `<div class="res-row" style="color:var(--muted);font-size:11px;">ไม่มีผลลัพธ์</div>`;
      card.innerHTML = `
        <div class="job-row1">
          <span class="job-badge ${job.type === 'scheduled' ? 'jb-sched' : 'jb-now'}">${job.type === 'scheduled' ? '⏰' : '🚀'} ${job.type === 'scheduled' ? 'ตั้งเวลา' : 'ทันที'}</span>
          <a href="${link}" target="_blank" class="job-link">${trunc(link, 48)}</a>
        </div>
        <div class="job-meta">
          <span>${fmtDate(job.postedAt || job.executedAt)}</span>
          <span>${okPages.length}/${job.pages?.length || 0} เพจสำเร็จ</span>
        </div>
        ${job.postData?.message ? `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">"${trunc(job.postData.message, 60)}"</div>` : ''}
        ${resultHtml}
      `;
      list.appendChild(card);
    });
    el.innerHTML = '';
    el.appendChild(list);
  } catch (e) {
    el.innerHTML = `<div class="loading-row" style="color:var(--danger)">⚠ ${e.message}</div>`;
  }
}

document.getElementById('btnClrHist').addEventListener('click', async () => {
  if (!confirm('ล้างประวัติทั้งหมด?')) return;
  await sendExt({ type: 'CLEAR_HISTORY' });
  loadHistory();
});

// ─── Helpers ──────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }
