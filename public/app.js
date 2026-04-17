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
let hbFailCount = 0;
setInterval(() => {
  if (extReady && !wasReady) wasReady = true;
  if (!wasReady || isPosting) return; // ไม่เช็คตอนกำลังโพส/เตรียม Card Link
  const testId = '_hb_' + Math.random().toString(36).slice(2);
  let replied = false;
  pending[testId] = () => { replied = true; hbFailCount = 0; };
  window.postMessage({ direction: 'from-page-script', messageId: testId, message: { type: 'GET_PAGES' } }, '*');
  setTimeout(() => {
    delete pending[testId];
    if (!replied) {
      hbFailCount++;
      // ต้อง fail 3 ครั้งติดถึงจะแจ้งเตือน (ป้องกัน false positive ตอน busy)
      if (hbFailCount >= 3 && wasReady) {
        extReady = false;
        wasReady = false;
        hbFailCount = 0;
        if (!document.getElementById('extLostBanner')) {
          const banner = document.createElement('div');
          banner.id = 'extLostBanner';
          banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;text-align:center;padding:12px;font-weight:600;cursor:pointer;font-size:14px;';
          banner.textContent = '⚠️ Extension ขาดการเชื่อมต่อ — คลิกที่นี่เพื่อ Refresh';
          banner.onclick = () => location.reload();
          document.body.appendChild(banner);
        }
      }
    }
  }, 5000);
}, 30000);

// ── จบ disconnect detection ──

// ─── State ────────────────────────────────────────────────────
let pages = [];
let selectedIds = new Set();
let isPosting = false;

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  document.getElementById('noExtScreen').style.display = 'none';

  // เช็คว่า Facebook OAuth redirect กลับมาพร้อม token หรือไม่
  const urlParams = new URLSearchParams(window.location.search);
  const fbToken = urlParams.get('fb_token');
  const fbError = urlParams.get('fb_error');
  const fbExpires = parseInt(urlParams.get('fb_expires')) || 5184000;

  // ลบ params ออกจาก URL (ไม่ให้ token ค้างใน address bar)
  if (fbToken || fbError) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (fbToken) {
    try {
      await sendExt({ type: 'SAVE_TOKEN', token: fbToken, expiresIn: fbExpires });
    } catch (e) {
      console.error('FB OAuth token save failed:', e);
    }
  }
  if (fbError) {
    const err = document.getElementById('connectError');
    if (err) { err.textContent = '⚠ Facebook Login ล้มเหลว: ' + fbError; err.style.display = ''; }
  }

  // เช็ค token แล้วแสดงปุ่มตาม
  const btn = document.getElementById('btnConnect');
  try {
    const check = await sendExt({ type: 'CHECK_TOKEN' });
    if (check && check.hasToken) {
      btn.textContent = 'เข้าใช้งาน';
      btn.dataset.action = 'enter';
    }
  } catch {}

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
    showApp(); loadPages(); loadAdAccounts();
  } catch (e) {
    err.textContent = '⚠ ' + e.message; err.style.display = '';
    btn.disabled = false; btn.textContent = 'เชื่อมต่อ';
  }
});

document.getElementById('btnConnect').addEventListener('click', async () => {
  const btn = document.getElementById('btnConnect');
  const err = document.getElementById('connectError');
  btn.disabled = true; err.style.display = 'none';

  // ถ้ามี token อยู่แล้ว → เข้าหน้าหลักเลย
  if (btn.dataset.action === 'enter') {
    btn.textContent = 'กำลังโหลดเพจ...';
    showApp(); loadPages(); loadAdAccounts();
    return;
  }

  // ดึง token จาก Facebook session อัตโนมัติ
  btn.textContent = 'กำลังดึง Token จาก Facebook...';
  try {
    await sendExt({ type: 'PREPARE_COOKIES' });
    const check = await sendExt({ type: 'CHECK_TOKEN' });
    if (!check.hasToken) {
      throw new Error('ดึง Token ไม่ได้ — ลองเปิด facebook.com ในแท็บอื่นก่อน แล้วกดอีกครั้ง');
    }
    showApp(); loadPages(); loadAdAccounts();
    return;
  } catch (e) {
    err.textContent = '⚠ ' + e.message; err.style.display = '';
    btn.disabled = false; btn.textContent = 'เชื่อมต่อ Facebook';
  }
});

// ─── OAuth Login (long-lived token 60 วัน) ──────────────────
document.getElementById('btnOAuth').addEventListener('click', () => {
  const APP_ID = '721475520495705';
  const REDIRECT_URI = encodeURIComponent(`${window.location.origin}/api/fb-callback`);
  const SCOPES = 'pages_manage_posts,pages_read_engagement,pages_show_list,ads_management,business_management';
  window.location.href = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${SCOPES}&response_type=code`;
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
    if (og.description && !document.getElementById('cardDesc').value)
      document.getElementById('cardDesc').value = og.description;
    // show OG preview
    document.getElementById('ogSite').textContent  = og.siteName || '';
    document.getElementById('ogTitle').textContent = og.title || '';
    document.getElementById('ogDesc').textContent  = og.description || '';
    document.getElementById('ogPreviewWrap').style.display = '';
    if (og.image) {
      document.getElementById('imagePreview').src = og.image;
      currentImageData = og.image;
      document.getElementById('fbPreviewImg').innerHTML = '<img src="' + og.image + '" alt="preview" />';
    }
  } catch {}
});

// ─── Image Upload (via FB Preview card) ───────────────────────
const fbPreviewImg = document.getElementById('fbPreviewImg');
const imageFile = document.getElementById('imageFile');
let currentImageData = null; // base64 data URL ของรูปที่เลือก
let currentThumbnail = null; // thumbnail เล็กๆ สำหรับ dashboard

function makeThumbnail(dataUrl, maxSize = 80) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

fbPreviewImg.addEventListener('click', () => imageFile.click());
fbPreviewImg.style.cursor = 'pointer';
imageFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    currentImageData = ev.target.result;
    currentThumbnail = await makeThumbnail(ev.target.result);
    document.getElementById('imagePreview').src = ev.target.result;
    // Update FB preview image only (imagePreview stays hidden)
    fbPreviewImg.innerHTML = '<img src="' + ev.target.result + '" alt="preview" />';
  };
  reader.readAsDataURL(file);
});
fbPreviewImg.addEventListener('dragover', e => { e.preventDefault(); fbPreviewImg.style.opacity = '.7'; });
fbPreviewImg.addEventListener('dragleave', () => { fbPreviewImg.style.opacity = ''; });
fbPreviewImg.addEventListener('drop', e => {
  e.preventDefault(); fbPreviewImg.style.opacity = '';
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) { imageFile.files = e.dataTransfer.files; imageFile.dispatchEvent(new Event('change')); }
});

// ─── Facebook Preview (live update) ─────────────────────────────
const CTA_LABELS = {
  LEARN_MORE: 'Learn More', SHOP_NOW: 'Shop Now', SIGN_UP: 'Sign Up',
  DOWNLOAD: 'Download', CONTACT_US: 'Contact Us', NO_BUTTON: ''
};

function updateFbPreview() {
  const msg = document.getElementById('postMsg').value;
  const title = document.getElementById('cardTitle').value;
  const domain = document.getElementById('displayLink').value;
  const desc = document.getElementById('cardDesc').value;
  const cta = document.getElementById('ctaSel').value;

  document.getElementById('fbPreviewMsg').textContent = msg;

  const titleEl = document.getElementById('fbPreviewTitle');
  titleEl.textContent = title;
  titleEl.style.display = title ? '' : 'none';

  const domainEl = document.getElementById('fbPreviewDomain');
  domainEl.textContent = (domain || '').toUpperCase();
  domainEl.style.display = domain ? '' : 'none';

  document.getElementById('fbPreviewDesc').textContent = desc;

  // Image is managed by imageFile change handler directly — don't overwrite here

  const ctaEl = document.getElementById('fbPreviewCta');
  const ctaLabel = CTA_LABELS[cta] || '';
  if (ctaLabel) {
    ctaEl.classList.remove('hidden');
    document.getElementById('fbPreviewCtaText').textContent = ctaLabel;
  } else {
    ctaEl.classList.add('hidden');
  }
}

['postMsg', 'cardTitle', 'displayLink', 'cardDesc'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateFbPreview);
});
document.getElementById('ctaSel').addEventListener('change', updateFbPreview);

// Update preview when image changes
updateFbPreview();

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
  const postData = { link, message, name, description, caption, cta, imageData: currentImageData, thumbnail: currentThumbnail };

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
  const progEl = document.getElementById('progressWrap');
  const bar = document.getElementById('progressBar');
  const label = document.getElementById('progressLabel');
  const logEl = document.getElementById('progressLog');

  btn.disabled = true;
  progEl.style.display = '';
  logEl.innerHTML = '';
  bar.style.width = '0%';
  label.textContent = `กำลังเตรียม Card Link...`;

  // แสดง log เตรียมเพจทั้งหมด
  const logRow = document.createElement('div');
  logRow.className = 'log-row log-pending';
  logRow.textContent = `⏳ ส่งคำสั่งตั้งเวลา ${selPages.length} เพจ...`;
  logEl.appendChild(logRow);

  try {
    const res = await sendExt({ type: 'SCHEDULE_POST', pages: selPages, postData, delay, scheduledTime, adAccountId });
    const jobId = res.jobId || res.id;

    logRow.className = 'log-row log-ok';
    logRow.textContent = `✓ รับคำสั่งแล้ว — กำลังเตรียม Card Link...`;
    bar.style.width = '10%';

    // poll สถานะเตรียม Card Link จาก extension
    let prepDone = false;
    for (let tick = 0; tick < 120 && !prepDone; tick++) {
      await sleep(3000);
      try {
        const status = await sendExt({ type: 'GET_JOB_STATUS', jobId });
        if (!status) continue;

        const pages = status.pages || [];
        const ps = status.pageStatuses || {};
        const prepared = status.preparedPosts || {};

        // อัพเดท log
        logEl.innerHTML = '';
        let okCount = 0;
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          const s = ps[i] || {};
          const row = document.createElement('div');

          if (s.status === 'error') {
            row.className = 'log-row log-err';
            row.textContent = `✗ ${p.name} — ${s.error || 'error'}`;
          } else if (prepared[i] && prepared[i].postId) {
            row.className = 'log-row log-ok';
            row.textContent = `✓ ${p.name} — Card Link พร้อม`;
            okCount++;
          } else if (s.status === 'preparing' || status.status === 'preparing') {
            row.className = 'log-row log-pending';
            row.textContent = `⏳ ${p.name} — กำลังเตรียม...`;
          } else if (s.status === 'waiting') {
            row.className = 'log-row log-ok';
            row.textContent = `✓ ${p.name} — พร้อมแล้ว รอเวลาโพส`;
            okCount++;
          } else {
            row.className = 'log-row log-pending';
            row.textContent = `⏳ ${p.name} — รอ...`;
          }
          logEl.appendChild(row);
        }

        const pct = Math.round(10 + (okCount / pages.length) * 80);
        bar.style.width = pct + '%';
        label.textContent = `เตรียม Card Link ${okCount}/${pages.length} เพจ`;

        // เช็คว่าเตรียมครบหรือยัง
        if (status.status === 'pending' || status.status === 'done') {
          prepDone = true;
          bar.style.width = '100%';

          if (status.serverScheduled) {
            label.textContent = `✅ ตั้งเวลาสำเร็จ ${okCount}/${pages.length} เพจ — ปิดคอมได้เลย!`;
          } else {
            label.textContent = `✅ ตั้งเวลาสำเร็จ ${okCount}/${pages.length} เพจ — เปิด Chrome ค้างไว้`;
          }
        }
      } catch {}
    }

    if (!prepDone) {
      label.textContent = `⏳ กำลังเตรียมอยู่... ดูสถานะได้ที่แท็บ "รายการตั้งเวลา"`;
    }

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
    if (jobId) startJobPolling(jobId);
  } catch (e) {
    logRow.className = 'log-row log-err';
    logRow.textContent = `✗ ${e.message}`;
    label.textContent = 'เกิดข้อผิดพลาด';
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

// auto-refresh scheduled list ทุก 60 วินาที (ลดจาก 30s เพื่อประหยัด Redis)
setInterval(async () => {
  const tab = document.querySelector('.tab-btn.active');
  if (tab && tab.dataset.tab === 'scheduled' && !activePollingJobId) loadScheduled();
  updateSchedBadge();
}, 60000);

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

// ═══════════════════════════════════════════════════════════════
// ─── Mode Tab Switching ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
document.querySelectorAll('.nav-item[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-mode]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mode-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('mode' + btn.dataset.mode.charAt(0).toUpperCase() + btn.dataset.mode.slice(1)).classList.add('active');
  });
});

// ═══════════════════════════════════════════════════════════════
// ─── Photo Mode ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const photoItems = []; // { id, dataUrl, caption }

const photoDropZone = document.getElementById('photoDropZone');
const photoFilesInput = document.getElementById('photoFiles');
const photoGrid = document.getElementById('photoGrid');
const photoCountEl = document.getElementById('photoCount');

photoDropZone.addEventListener('click', () => photoFilesInput.click());
photoDropZone.addEventListener('dragover', e => { e.preventDefault(); photoDropZone.classList.add('dragover'); });
photoDropZone.addEventListener('dragleave', () => photoDropZone.classList.remove('dragover'));
photoDropZone.addEventListener('drop', e => {
  e.preventDefault();
  photoDropZone.classList.remove('dragover');
  addPhotoFiles(e.dataTransfer.files);
});
photoFilesInput.addEventListener('change', e => {
  addPhotoFiles(e.target.files);
  photoFilesInput.value = '';
});

function addPhotoFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const item = { id: 'ph_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), dataUrl: ev.target.result, caption: '' };
      photoItems.push(item);
      renderPhotoGrid();
    };
    reader.readAsDataURL(file);
  }
}

function getPhotoScheduleTimes() {
  const isSchedule = document.getElementById('photoSchedToggle').checked;
  if (!isSchedule) return null;
  const dtVal = document.getElementById('photoSchedDT').value;
  if (!dtVal) return null;
  const startMs = new Date(dtVal).getTime();
  const delay = parseInt(document.getElementById('photoDelaySel').value) || 1800000;
  return { startMs, delay };
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `วันนี้ ${time}`;
  const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
  if (d.toDateString() === tmr.toDateString()) return `พรุ่งนี้ ${time}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`;
}

function renderPhotoGrid() {
  photoCountEl.style.display = photoItems.length ? '' : 'none';
  photoCountEl.textContent = `${photoItems.length} รูป`;

  const sched = getPhotoScheduleTimes();

  photoGrid.innerHTML = photoItems.map((item, idx) => {
    // แต่ละรูปตั้งเวลาห่างกันตาม delay (เพจทั้งหมดของรูปเดียวกันใช้เวลาเดียวกัน)
    const timeHtml = sched
      ? `<div class="photo-time-badge">${fmtTime(sched.startMs + idx * sched.delay)}</div>`
      : '';
    return `
    <div class="photo-item" data-id="${item.id}">
      <div class="photo-img-wrap">
        <img src="${item.dataUrl}" alt="รูป ${idx + 1}" />
        <span class="photo-order">${idx + 1}</span>
        <button class="photo-remove" onclick="removePhoto('${item.id}')">&times;</button>
        ${timeHtml}
      </div>
      <textarea placeholder="แคปชั่นรูปที่ ${idx + 1}..." oninput="updatePhotoCaption('${item.id}', this.value)">${item.caption}</textarea>
    </div>`;
  }).join('');
}

window.removePhoto = function(id) {
  const idx = photoItems.findIndex(p => p.id === id);
  if (idx >= 0) photoItems.splice(idx, 1);
  renderPhotoGrid();
};

window.updatePhotoCaption = function(id, val) {
  const item = photoItems.find(p => p.id === id);
  if (item) item.caption = val;
};

// ─── Photo Schedule Toggle ───────────────────────────────────
document.getElementById('photoSchedToggle').addEventListener('change', function () {
  document.getElementById('photoSchedBlock').style.display = this.checked ? '' : 'none';
  document.getElementById('photoPostIcon').textContent = this.checked ? '⏰' : '🚀';
  document.getElementById('photoPostLabel').textContent = this.checked ? 'ตั้งเวลาโพสรูป' : 'โพสรูปทั้งหมด';
  if (this.checked) {
    const dt = new Date(Date.now() + 3600000);
    document.getElementById('photoSchedDT').value =
      new Date(dt - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  renderPhotoGrid();
});
// อัพเดทเวลาบนรูปเมื่อเปลี่ยน datetime หรือ delay
document.getElementById('photoSchedDT').addEventListener('change', renderPhotoGrid);
document.getElementById('photoDelaySel').addEventListener('change', renderPhotoGrid);

// ─── Post Photos ─────────────────────────────────────────────
document.getElementById('btnPostPhotos').addEventListener('click', async () => {
  if (!photoItems.length) return alert('กรุณาอัพโหลดรูปอย่างน้อย 1 รูป');
  if (!selectedIds.size) return alert('กรุณาเลือกเพจอย่างน้อย 1 เพจ');

  const selPages = pages.filter(p => selectedIds.has(p.id));
  const rawDelayVal = document.getElementById('photoDelaySel').value;
  const delay = parseInt(rawDelayVal) || 1800000;
  const isSchedule = document.getElementById('photoSchedToggle').checked;
  let scheduledTime = null;

  console.log(`[PHOTO-START] photoDelaySel.value="${rawDelayVal}" → delay=${delay}ms (${delay/1000}s) | isSchedule=${isSchedule} | photos=${photoItems.length} | pages=${selPages.length}`);

  if (isSchedule) {
    const dtVal = document.getElementById('photoSchedDT').value;
    if (!dtVal) return alert('กรุณาเลือกวันและเวลา');
    scheduledTime = Math.floor(new Date(dtVal).getTime() / 1000);
    console.log(`[PHOTO-START] dtVal="${dtVal}" → scheduledTime=${scheduledTime} (${new Date(scheduledTime * 1000).toLocaleString()})`);
    if (scheduledTime <= Math.floor(Date.now() / 1000) + 600) return alert('กรุณาเลือกเวลาอย่างน้อย 10 นาทีข้างหน้า');
  }

  const btn = document.getElementById('btnPostPhotos');
  const progWrap = document.getElementById('photoProgressWrap');
  const bar = document.getElementById('photoProgressBar');
  const label = document.getElementById('photoProgressLabel');
  const log = document.getElementById('photoProgressLog');

  btn.disabled = true;
  progWrap.style.display = '';
  log.innerHTML = '';
  isPosting = true;

  const total = photoItems.length * selPages.length;
  let done = 0;

  for (let pi = 0; pi < photoItems.length; pi++) {
    const photo = photoItems[pi];
    // ดีเลย์ระหว่าง "รูป" (30 นาที, 1 ชม. ฯลฯ) — เพจทั้งหมดของรูปเดียวกันใช้เวลาเดียวกัน
    const photoSchedTime = scheduledTime ? scheduledTime + pi * Math.floor(delay / 1000) : null;

    for (let si = 0; si < selPages.length; si++) {
      const page = selPages[si];
      const pct = Math.round((done / total) * 100);
      bar.style.width = pct + '%';
      const timeStr = photoSchedTime ? ` (${fmtTime(photoSchedTime * 1000)})` : '';
      label.textContent = `รูป ${pi + 1}/${photoItems.length} → ${page.name}${timeStr}`;

      try {
        console.log(`[PHOTO] รูป ${pi+1} → ${page.name} | schedTime=${photoSchedTime} | date=${photoSchedTime ? new Date(photoSchedTime * 1000).toLocaleString() : 'now'} | delay=${delay}ms | now=${Math.floor(Date.now()/1000)}`);
        const result = await sendExt({
          type: 'POST_PHOTO',
          page,
          imageData: photo.dataUrl,
          caption: photo.caption,
          scheduledTime: photoSchedTime,
        });
        log.innerHTML += `<div style="color:var(--success)">✓ รูป ${pi + 1} → ${page.name}${photoSchedTime ? ' (' + fmtTime(photoSchedTime * 1000) + ')' : ''}</div>`;
      } catch (e) {
        log.innerHTML += `<div style="color:var(--danger)">✗ รูป ${pi + 1} → ${page.name}: ${e.message}</div>`;
      }

      done++;
      // โพสทันที: รอ 10 วิ ระหว่างเพจ กัน rate limit
      if (done < total && !scheduledTime) await sleep(10000);
      // ตั้งเวลา: Facebook จัดการเวลาเอง แค่รอ 15 วิ ระหว่างเพจกันสแปม
      if (done < total && scheduledTime) await sleep(15000);
    }
  }

  bar.style.width = '100%';
  label.textContent = `เสร็จ! ${done}/${total}`;
  btn.disabled = false;
  isPosting = false;
});
