// ===== Bulk Poster — popup.js =====

// ─── Helpers ──────────────────────────────────────────────────

function msg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str || '';
}

// ─── State ────────────────────────────────────────────────────

let pages = [];
let selectedPageIds = new Set();

// ─── Init ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupScheduleToggle();
  setupButtons();

  // ตรวจสอบว่าเคยเชื่อมต่อแล้วหรือยัง
  const { connected } = await chrome.storage.local.get('connected');
  if (connected) {
    showApp();
    loadPages();
  } else {
    showConnect();
  }
});

// ─── Connect / Auth ────────────────────────────────────────────

function showConnect() {
  document.getElementById('connectScreen').style.display = '';
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('connStatus').textContent = 'ยังไม่เชื่อมต่อ';
  document.getElementById('connStatus').className = 'conn-badge conn-off';
}

function showApp() {
  document.getElementById('connectScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = '';
  document.getElementById('connStatus').textContent = '● เชื่อมต่อแล้ว';
  document.getElementById('connStatus').className = 'conn-badge conn-on';
}

document.getElementById('btnConnect').addEventListener('click', async () => {
  const btn = document.getElementById('btnConnect');
  const errEl = document.getElementById('connectError');
  btn.disabled = true;
  btn.textContent = 'กำลังเชื่อมต่อ...';
  errEl.style.display = 'none';
  try {
    await msg('PREPARE_COOKIES');
    showApp();
    loadPages();
  } catch (e) {
    errEl.textContent = '⚠ ' + e.message;
    errEl.style.display = '';
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔌</span> เชื่อมต่อ Facebook';
  }
});

// ─── Tabs ─────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');

      if (tab === 'scheduled') loadScheduled();
      if (tab === 'history') loadHistory();
    });
  });
}

// ─── Pages ────────────────────────────────────────────────────

async function loadPages() {
  const listEl = document.getElementById('pagesList');
  listEl.innerHTML = `<div class="loading-row"><div class="spinner"></div><span>กำลังโหลดเพจ...</span></div>`;
  try {
    const res = await msg('GET_PAGES');
    if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
    pages = res.data || [];
    if (!pages.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📄</div><div>ไม่พบเพจที่จัดการ</div></div>`;
      return;
    }
    renderPageList();
  } catch (e) {
    listEl.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderPageList() {
  const listEl = document.getElementById('pagesList');
  listEl.innerHTML = '';
  pages.forEach(page => {
    const item = document.createElement('div');
    item.className = 'page-item' + (selectedPageIds.has(page.id) ? ' selected' : '');
    item.dataset.pageId = page.id;

    const avatarHTML = page.picture?.data?.url
      ? `<img class="page-avatar" src="${page.picture.data.url}" alt="" />`
      : `<div class="page-avatar-placeholder">${page.name.charAt(0).toUpperCase()}</div>`;

    item.innerHTML = `
      ${avatarHTML}
      <span class="page-name">${page.name}</span>
      <div class="page-check"></div>
    `;
    item.addEventListener('click', () => togglePage(page.id, item));
    listEl.appendChild(item);
  });
  updateSelectedCount();
}

function togglePage(id, el) {
  if (selectedPageIds.has(id)) {
    selectedPageIds.delete(id);
    el.classList.remove('selected');
  } else {
    selectedPageIds.add(id);
    el.classList.add('selected');
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  const n = selectedPageIds.size;
  document.getElementById('selectedCount').textContent =
    n ? `เลือก ${n} / ${pages.length} เพจ` : '';
}

document.getElementById('btnSelectAll').addEventListener('click', () => {
  pages.forEach(p => selectedPageIds.add(p.id));
  renderPageList();
});

document.getElementById('btnDeselectAll').addEventListener('click', () => {
  selectedPageIds.clear();
  renderPageList();
});

document.getElementById('btnRefreshPages').addEventListener('click', loadPages);

// ─── Link Preview ─────────────────────────────────────────────

document.getElementById('btnPreview').addEventListener('click', fetchPreview);
document.getElementById('linkInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchPreview();
});

async function fetchPreview() {
  const url = document.getElementById('linkInput').value.trim();
  if (!url) return;
  const btn = document.getElementById('btnPreview');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const og = await msg('FETCH_OG', { url });
    renderPreview(og, url);
  } catch (e) {
    renderPreview({ title: url, description: '', image: '', siteName: new URL(url).hostname }, url);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ดึง';
  }
}

function renderPreview(og, url) {
  const card = document.getElementById('previewCard');
  const imgWrap = document.getElementById('previewImg');
  const imgEl  = document.getElementById('previewImgEl');
  document.getElementById('previewSite').textContent  = og.siteName || new URL(url).hostname;
  document.getElementById('previewTitle').textContent = og.title || url;
  document.getElementById('previewDesc').textContent  = og.description || '';

  if (og.image) {
    imgEl.src = og.image;
    imgEl.onerror = () => { imgWrap.style.display = 'none'; };
    imgWrap.style.display = '';
  } else {
    imgWrap.style.display = 'none';
  }
  card.style.display = '';
}

// ─── Schedule Toggle ───────────────────────────────────────────

function setupScheduleToggle() {
  const toggle = document.getElementById('scheduleToggle');
  const picker = document.getElementById('schedulePicker');
  const btnIcon = document.getElementById('postBtnIcon');
  const btnText = document.getElementById('postBtnText');

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      picker.style.display = '';
      // ตั้งค่า default เป็น 1 ชั่วโมงข้างหน้า
      const dt = new Date(Date.now() + 3600000);
      const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000)
                      .toISOString().slice(0, 16);
      document.getElementById('scheduleDateTime').value = local;
      btnIcon.textContent = '⏰';
      btnText.textContent = 'ตั้งเวลาโพส';
    } else {
      picker.style.display = 'none';
      btnIcon.textContent = '🚀';
      btnText.textContent = 'โพสต์ทันที';
    }
  });
}

// ─── Post ──────────────────────────────────────────────────────

function setupButtons() {
  document.getElementById('btnPost').addEventListener('click', handlePost);
}

async function handlePost() {
  const link = document.getElementById('linkInput').value.trim();
  const message = document.getElementById('msgInput').value.trim();
  const isSchedule = document.getElementById('scheduleToggle').checked;

  if (!link) return alert('กรุณาใส่ลิงก์ก่อน');
  if (selectedPageIds.size === 0) return alert('กรุณาเลือกเพจอย่างน้อย 1 เพจ');

  const selectedPages = pages.filter(p => selectedPageIds.has(p.id));

  if (isSchedule) {
    const dtVal = document.getElementById('scheduleDateTime').value;
    if (!dtVal) return alert('กรุณาเลือกวันและเวลา');
    const scheduledTime = new Date(dtVal).getTime();
    if (scheduledTime <= Date.now()) return alert('กรุณาเลือกเวลาในอนาคต');
    await schedulePost(selectedPages, link, message, scheduledTime);
  } else {
    await postNow(selectedPages, link, message);
  }
}

async function postNow(selectedPages, link, message) {
  const btn = document.getElementById('btnPost');
  const progressEl = document.getElementById('postProgress');
  const progressBar = document.getElementById('progressBar');
  const progressText = document.getElementById('progressText');
  const resultsEl = document.getElementById('postResults');

  btn.disabled = true;
  progressEl.style.display = '';
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';

  progressText.textContent = `กำลังโพสต์... 0/${selectedPages.length}`;
  progressBar.style.width = '0%';

  try {
    const res = await msg('POST_NOW', { pages: selectedPages, link, message });
    const results = res.results || {};

    progressBar.style.width = '100%';
    progressText.textContent = 'เสร็จแล้ว!';

    // แสดงผล
    resultsEl.innerHTML = '';
    selectedPages.forEach(page => {
      const r = results[page.id];
      const ok = r && r.success;
      const div = document.createElement('div');
      div.className = `result-item ${ok ? 'result-ok' : 'result-err'}`;
      div.innerHTML = `
        <span class="result-icon">${ok ? '✅' : '❌'}</span>
        <span class="result-name">${page.name}</span>
        <span class="result-status">${ok ? 'สำเร็จ' : (r?.error || 'ผิดพลาด')}</span>
      `;
      resultsEl.appendChild(div);
    });
    resultsEl.style.display = '';

    setTimeout(() => { progressEl.style.display = 'none'; }, 2000);
  } catch (e) {
    progressEl.style.display = 'none';
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function schedulePost(selectedPages, link, message, scheduledTime) {
  const btn = document.getElementById('btnPost');
  btn.disabled = true;
  try {
    await msg('SCHEDULE_POST', { pages: selectedPages, link, message, scheduledTime });
    alert(`✅ ตั้งเวลาโพสไว้แล้ว!\n📅 ${fmtDate(scheduledTime)}\n📄 ${selectedPages.length} เพจ`);
    // สลับไปหน้า Scheduled
    document.querySelector('[data-tab="scheduled"]').click();
    updateScheduledBadge();
  } catch (e) {
    alert('เกิดข้อผิดพลาด: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ─── Scheduled Tab ─────────────────────────────────────────────

async function loadScheduled() {
  const listEl = document.getElementById('scheduledList');
  listEl.innerHTML = `<div class="loading-row"><div class="spinner"></div><span>กำลังโหลด...</span></div>`;
  try {
    const jobs = await msg('GET_SCHEDULED');
    renderScheduled(jobs);
    updateScheduledBadge(jobs.length);
  } catch (e) {
    listEl.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderScheduled(jobs) {
  const listEl = document.getElementById('scheduledList');
  if (!jobs.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div>ยังไม่มีรายการตั้งเวลา</div></div>`;
    return;
  }
  listEl.innerHTML = '';
  jobs.forEach(job => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-card-header">
        <span class="job-type-badge badge-scheduled">⏰ ตั้งเวลา</span>
        <a href="${job.link}" target="_blank" class="job-link">${truncate(job.link, 45)}</a>
      </div>
      <div class="job-meta">
        <span>🕐 ${fmtDate(job.scheduledTime)}</span>
        <span>${job.pages.length} เพจ</span>
      </div>
      ${job.message ? `<div class="job-pages-summary" style="font-size:12px;color:var(--text);">"${truncate(job.message, 60)}"</div>` : ''}
      <div class="job-pages-summary">${job.pages.map(p => p.name).join(', ')}</div>
      <div class="job-actions">
        <button class="btn btn-danger btn-xs" data-cancel="${job.id}">ยกเลิก</button>
      </div>
    `;
    const cancelBtn = card.querySelector('[data-cancel]');
    cancelBtn.addEventListener('click', () => cancelJob(job.id));
    listEl.appendChild(card);
  });
}

async function cancelJob(id) {
  if (!confirm('ยืนยันยกเลิกการตั้งเวลาโพสนี้?')) return;
  await msg('CANCEL_SCHEDULED', { id });
  loadScheduled();
}

async function updateScheduledBadge(count) {
  if (count === undefined) {
    const jobs = await msg('GET_SCHEDULED');
    count = jobs.length;
  }
  const badge = document.getElementById('scheduledBadge');
  badge.textContent = count;
  badge.style.display = count > 0 ? '' : 'none';
}

document.getElementById('btnRefreshScheduled').addEventListener('click', loadScheduled);

// ─── History Tab ────────────────────────────────────────────────

async function loadHistory() {
  const listEl = document.getElementById('historyList');
  listEl.innerHTML = `<div class="loading-row"><div class="spinner"></div><span>กำลังโหลด...</span></div>`;
  try {
    const history = await msg('GET_HISTORY');
    renderHistory(history);
  } catch (e) {
    listEl.innerHTML = `<div class="error-msg">⚠ ${e.message}</div>`;
  }
}

function renderHistory(history) {
  const listEl = document.getElementById('historyList');
  if (!history.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div>ยังไม่มีประวัติการโพสต์</div></div>`;
    return;
  }
  listEl.innerHTML = '';
  history.slice(0, 50).forEach(job => {
    const results = job.results || {};
    const okCount = Object.values(results).filter(r => r.success).length;
    const total   = job.pages ? job.pages.length : 0;

    const card = document.createElement('div');
    card.className = 'job-card';
    card.innerHTML = `
      <div class="job-card-header">
        <span class="job-type-badge ${job.type === 'scheduled' ? 'badge-scheduled' : 'badge-immediate'}">
          ${job.type === 'scheduled' ? '⏰ ตั้งเวลา' : '🚀 ทันที'}
        </span>
        <a href="${job.link || ''}" target="_blank" class="job-link">${truncate(job.link || '', 42)}</a>
      </div>
      <div class="job-meta">
        <span>${fmtDate(job.postedAt || job.executedAt)}</span>
        <span class="${okCount === total ? 'result-ok' : 'result-err'}" style="font-weight:600;">
          ✓ ${okCount}/${total} เพจ
        </span>
      </div>
      ${job.message ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">"${truncate(job.message,60)}"</div>` : ''}
      <div class="job-results-mini">
        ${Object.entries(results).map(([id, r]) => `
          <span class="result-chip ${r.success ? 'chip-ok' : 'chip-err'}">
            ${r.success ? '✓' : '✗'} ${truncate(r.pageName || id, 18)}
          </span>
        `).join('')}
      </div>
    `;
    listEl.appendChild(card);
  });
}

document.getElementById('btnClearHistory').addEventListener('click', async () => {
  if (!confirm('ล้างประวัติทั้งหมด?')) return;
  await msg('CLEAR_HISTORY');
  loadHistory();
});

// ─── Init scheduled badge ──────────────────────────────────────
updateScheduledBadge();
