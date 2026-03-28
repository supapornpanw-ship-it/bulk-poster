// ===== Bulk Poster Web App =====
// สื่อสารกับ Extension ผ่าน content script

// ─── Extension Bridge ─────────────────────────────────────────

let extReady = false;
const pending = {};

window.addEventListener('message', (e) => {
  if (!e.data || e.data.direction !== 'from-content-script') return;

  if (e.data.status === 'ready') {
    extReady = true;
    init();
    return;
  }

  const cb = pending[e.data.messageId];
  if (cb) {
    delete pending[e.data.messageId];
    cb(e.data.response);
  }
});

function sendExt(message) {
  return new Promise((resolve, reject) => {
    if (!extReady) return reject(new Error('Extension ไม่ได้เชื่อมต่อ'));
    const messageId = Math.random().toString(36).slice(2);
    pending[messageId] = (res) => {
      if (!res) return reject(new Error('ไม่ได้รับการตอบกลับจาก Extension'));
      if (res.error) return reject(new Error(typeof res.error === 'object' ? (res.error.message || JSON.stringify(res.error)) : res.error));
      resolve(res);
    };
    window.postMessage({ direction: 'from-page-script', messageId, message }, '*');
    setTimeout(() => {
      if (pending[messageId]) {
        delete pending[messageId];
        reject(new Error('หมดเวลารอ Extension'));
      }
    }, 15000);
  });
}

// ─── State ────────────────────────────────────────────────────

let pages = [];
let selectedIds = new Set();

// ─── Init ─────────────────────────────────────────────────────

// รอ content script ส่ง ready (3 วิ ถ้าไม่มีแสดง no-ext screen)
setTimeout(() => {
  if (!extReady) {
    document.getElementById('connectScreen').style.display = 'none';
    document.getElementById('noExtScreen').style.display = '';
  }
}, 3000);

async function init() {
  document.getElementById('noExtScreen').style.display = 'none';
  const { connected } = await chrome_storage_get('connected').catch(() => ({}));
  if (connected) {
    showApp();
    loadPages();
  } else {
    document.getElementById('connectScreen').style.display = '';
    document.getElementById('mainApp').style.display = 'none';
  }
}

// chrome.storage ผ่าน extension ไม่ได้โดยตรงจากเว็บ — ใช้ localStorage แทน
function chrome_storage_get(key) {
  return Promise.resolve({ [key]: localStorage.getItem('bp_' + key) === 'true' });
}
function chrome_storage_set(key, val) {
  localStorage.setItem('bp_' + key, String(val));
}

// ─── Connect ─────────────────────────────────────────────────

document.getElementById('btnConnect').addEventListener('click', async () => {
  const btn = document.getElementById('btnConnect');
  const errEl = document.getElementById('connectError');
  btn.disabled = true;
  btn.textContent = 'กำลังเชื่อมต่อ...';
  errEl.style.display = 'none';
  try {
    await sendExt({ type: 'PREPARE_COOKIES' });
    chrome_storage_set('connected', true);
    showApp();
    loadPages();
  } catch (e) {
    errEl.textContent = '⚠ ' + e.message;
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = '🔌 เชื่อมต่อ Facebook';
  }
});

function showApp() {
  document.getElementById('connectScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
  document.getElementById('connStatus').textContent = '● เชื่อมต่อแล้ว';
  document.getElementById('connStatus').className = 'conn-badge conn-on';
}

// ─── Pages ────────────────────────────────────────────────────

async function loadPages() {
  const el = document.getElementById('pagesList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลดเพจ...</div>`;
  try {
    const res = await sendExt({ type: 'GET_PAGES' });
    pages = res.data || [];
    if (!pages.length) {
      el.innerHTML = `<div class="empty-state"><div>📄</div>ไม่พบเพจที่จัดการ</div>`;
      return;
    }
    renderPages();
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderPages() {
  const el = document.getElementById('pagesList');
  el.innerHTML = '';
  pages.forEach(page => {
    const div = document.createElement('div');
    div.className = 'page-item' + (selectedIds.has(page.id) ? ' selected' : '');
    const av = page.picture?.data?.url
      ? `<img class="page-avatar" src="${page.picture.data.url}" alt="" />`
      : `<div class="page-avatar-ph">${page.name[0].toUpperCase()}</div>`;
    div.innerHTML = `${av}<span class="page-name">${page.name}</span><div class="page-check"></div>`;
    div.addEventListener('click', () => {
      selectedIds.has(page.id) ? selectedIds.delete(page.id) : selectedIds.add(page.id);
      div.classList.toggle('selected');
      updateSelCount();
    });
    el.appendChild(div);
  });
  updateSelCount();
}

function updateSelCount() {
  const n = selectedIds.size;
  document.getElementById('selCount').textContent = n ? `เลือก ${n} / ${pages.length} เพจ` : '';
}

document.getElementById('btnAll').addEventListener('click', () => {
  pages.forEach(p => selectedIds.add(p.id));
  renderPages();
});
document.getElementById('btnNone').addEventListener('click', () => {
  selectedIds.clear();
  renderPages();
});
document.getElementById('btnReload').addEventListener('click', loadPages);

// ─── Preview ──────────────────────────────────────────────────

document.getElementById('btnPreview').addEventListener('click', fetchPreview);
document.getElementById('linkInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchPreview();
});

async function fetchPreview() {
  const url = document.getElementById('linkInput').value.trim();
  if (!url) return;
  const btn = document.getElementById('btnPreview');
  btn.disabled = true;
  btn.textContent = 'กำลังดึง...';
  try {
    const og = await sendExt({ type: 'FETCH_OG', url });
    showPreview(og, url);
  } catch {
    showPreview({ title: url, description: '', image: '', siteName: new URL(url).hostname }, url);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ดึง Preview';
  }
}

function showPreview(og, url) {
  document.getElementById('previewSite').textContent  = og.siteName || new URL(url).hostname;
  document.getElementById('previewTitle').textContent = og.title || url;
  document.getElementById('previewDesc').textContent  = og.description || '';
  const imgWrap = document.getElementById('previewImgWrap');
  const imgEl   = document.getElementById('previewImg');
  if (og.image) {
    imgEl.src = og.image;
    imgEl.onerror = () => { imgWrap.style.display = 'none'; };
    imgWrap.style.display = '';
  } else {
    imgWrap.style.display = 'none';
  }
  document.getElementById('previewCard').style.display = '';
}

// ─── Schedule Toggle ──────────────────────────────────────────

document.getElementById('schedToggle').addEventListener('change', function () {
  document.getElementById('schedPicker').style.display = this.checked ? '' : 'none';
  document.getElementById('postIcon').textContent  = this.checked ? '⏰' : '🚀';
  document.getElementById('postLabel').textContent = this.checked ? 'ตั้งเวลาโพส' : 'โพสต์ทันที';
  if (this.checked) {
    const dt = new Date(Date.now() + 3600000);
    document.getElementById('schedDT').value =
      new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
});

// ─── Post ─────────────────────────────────────────────────────

document.getElementById('btnPost').addEventListener('click', async () => {
  const link = document.getElementById('linkInput').value.trim();
  const message = document.getElementById('msgInput').value.trim();
  const isSchedule = document.getElementById('schedToggle').checked;

  if (!link) return alert('กรุณาใส่ลิงก์ก่อน');
  if (!selectedIds.size) return alert('กรุณาเลือกเพจอย่างน้อย 1 เพจ');

  const selPages = pages.filter(p => selectedIds.has(p.id));

  if (isSchedule) {
    const dtVal = document.getElementById('schedDT').value;
    if (!dtVal) return alert('กรุณาเลือกวันและเวลา');
    const ts = new Date(dtVal).getTime();
    if (ts <= Date.now()) return alert('กรุณาเลือกเวลาในอนาคต');
    await doSchedule(selPages, link, message, ts);
  } else {
    await doPostNow(selPages, link, message);
  }
});

async function doPostNow(selPages, link, message) {
  const btn = document.getElementById('btnPost');
  const progEl = document.getElementById('postProgress');
  const bar    = document.getElementById('progressBar');
  const txt    = document.getElementById('progressText');
  const resEl  = document.getElementById('postResults');

  btn.disabled = true;
  progEl.style.display = '';
  resEl.style.display  = 'none';
  resEl.innerHTML = '';
  bar.style.width = '10%';
  txt.textContent = `กำลังโพสต์ ${selPages.length} เพจ...`;

  try {
    const res = await sendExt({ type: 'POST_NOW', pages: selPages, link, message });
    const results = res.results || {};
    bar.style.width = '100%';
    txt.textContent = 'เสร็จแล้ว! ✓';

    resEl.innerHTML = '';
    selPages.forEach(page => {
      const r = results[page.id];
      const ok = r?.success;
      const row = document.createElement('div');
      row.className = `result-row ${ok ? 'ok' : 'err'}`;
      row.innerHTML = `
        <span>${ok ? '✅' : '❌'}</span>
        <span class="result-name">${page.name}</span>
        <span class="result-status">${ok ? 'สำเร็จ' : (r?.error || 'ผิดพลาด')}</span>
      `;
      resEl.appendChild(row);
    });
    resEl.style.display = '';
    setTimeout(() => { progEl.style.display = 'none'; }, 2500);
  } catch (e) {
    progEl.style.display = 'none';
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function doSchedule(selPages, link, message, scheduledTime) {
  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  try {
    await sendExt({ type: 'SCHEDULE_POST', pages: selPages, link, message, scheduledTime });
    alert(`✅ ตั้งเวลาแล้ว!\n📅 ${fmtDate(scheduledTime)}\n📄 ${selPages.length} เพจ\n\n⚠️ ต้องเปิดเบราว์เซอร์ไว้เพื่อให้ส่งอัตโนมัติ`);
    document.querySelector('[data-tab="scheduled"]').click();
    loadScheduled();
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

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

// ─── Scheduled ────────────────────────────────────────────────

async function loadScheduled() {
  const el = document.getElementById('schedList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลด...</div>`;
  try {
    const res = await sendExt({ type: 'GET_SCHEDULED' });
    const jobs = Array.isArray(res) ? res : (res.data || []);
    renderScheduled(jobs);
    const badge = document.getElementById('schedBadge');
    badge.textContent = jobs.length;
    badge.style.display = jobs.length ? '' : 'none';
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderScheduled(jobs) {
  const el = document.getElementById('schedList');
  if (!jobs.length) {
    el.innerHTML = `<div class="empty-state"><div>📅</div>ยังไม่มีรายการตั้งเวลา</div>`;
    return;
  }
  el.innerHTML = '';
  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-header">
        <span class="job-badge badge-sched">⏰ ตั้งเวลา</span>
        <a href="${job.link}" target="_blank" class="job-link">${trunc(job.link, 40)}</a>
      </div>
      <div class="job-meta">
        <span>🕐 ${fmtDate(job.scheduledTime)}</span>
        <span>${job.pages?.length || 0} เพจ</span>
      </div>
      ${job.message ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">"${trunc(job.message,60)}"</div>` : ''}
      <div class="job-pages">${job.pages?.map(p => p.name).join(', ')}</div>
      <div class="job-actions">
        <button class="btn btn-danger btn-sm" data-id="${job.id}">ยกเลิก</button>
      </div>
    `;
    card.querySelector('[data-id]').addEventListener('click', async (e) => {
      if (!confirm('ยืนยันยกเลิก?')) return;
      await sendExt({ type: 'CANCEL_SCHEDULED', id: e.target.dataset.id });
      loadScheduled();
    });
    el.appendChild(card);
  });
}

document.getElementById('btnRefSched').addEventListener('click', loadScheduled);

// ─── History ──────────────────────────────────────────────────

async function loadHistory() {
  const el = document.getElementById('histList');
  el.innerHTML = `<div class="loading-row"><div class="spinner"></div> กำลังโหลด...</div>`;
  try {
    const res = await sendExt({ type: 'GET_HISTORY' });
    const hist = Array.isArray(res) ? res : (res.data || []);
    renderHistory(hist);
  } catch (e) {
    el.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderHistory(hist) {
  const el = document.getElementById('histList');
  if (!hist.length) {
    el.innerHTML = `<div class="empty-state"><div>📊</div>ยังไม่มีประวัติ</div>`;
    return;
  }
  el.innerHTML = '';
  hist.slice(0, 50).forEach(job => {
    const results = job.results || {};
    const ok = Object.values(results).filter(r => r.success).length;
    const total = job.pages?.length || 0;
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-header">
        <span class="job-badge ${job.type === 'scheduled' ? 'badge-sched' : 'badge-now'}">
          ${job.type === 'scheduled' ? '⏰' : '🚀'} ${job.type === 'scheduled' ? 'ตั้งเวลา' : 'ทันที'}
        </span>
        <a href="${job.link || ''}" target="_blank" class="job-link">${trunc(job.link || '', 38)}</a>
      </div>
      <div class="job-meta">
        <span>${fmtDate(job.postedAt || job.executedAt)}</span>
        <span style="color:${ok===total?'var(--success)':'var(--danger)'};font-weight:600;">✓ ${ok}/${total} เพจ</span>
      </div>
      ${job.message ? `<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">"${trunc(job.message,60)}"</div>` : ''}
      <div class="job-chips">
        ${Object.entries(results).map(([,r]) =>
          `<span class="chip ${r.success ? 'chip-ok' : 'chip-err'}">${r.success ? '✓' : '✗'} ${trunc(r.pageName || '', 16)}</span>`
        ).join('')}
      </div>
    `;
    el.appendChild(card);
  });
}

document.getElementById('btnClrHist').addEventListener('click', async () => {
  if (!confirm('ล้างประวัติทั้งหมด?')) return;
  await sendExt({ type: 'CLEAR_HISTORY' });
  loadHistory();
});

// ─── Helpers ──────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '');
}
