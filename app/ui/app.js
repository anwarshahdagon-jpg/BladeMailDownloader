'use strict';
/* global fluxget */
const $ = (s) => document.querySelector(s);
const items = new Map();
const rows = new Map();
let filter = 'all';
let query = '';
let order = [];
let peak = 0;
const history = new Array(60).fill(0);

const COLORS = { video: '#f28b5b', audio: '#c58af9', archive: '#f5d061', program: '#6fb6ff', doc: '#7ee0a8', image: '#ff8fb8', other: '#9aa7bf' };
const TYPES = {
  video: /\.(mp4|mkv|webm|avi|mov|flv|m4v|ts|wmv|3gp)$/i, audio: /\.(mp3|m4a|aac|flac|wav|ogg|opus|weba)$/i,
  archive: /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i, program: /\.(exe|msi|apk|dmg|deb|appimage)$/i,
  doc: /\.(pdf|docx?|xlsx?|pptx?|txt|epub|csv)$/i, image: /\.(jpe?g|png|gif|webp|bmp|svg)$/i,
};
function ftype(name) { for (const [k, re] of Object.entries(TYPES)) if (re.test(name)) return k; return 'other'; }
function ext(name) { const m = /\.([a-z0-9]{1,4})$/i.exec(name || ''); return m ? m[1].toUpperCase() : 'FILE'; }

function fmtBytes(b) {
  if (b == null || b < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(b < 10 ? 2 : 1)) + ' ' + u[i];
}
const fmtSpeed = (b) => (b > 0 ? fmtBytes(b) + '/s' : '—');
// ISPs advertise speed in megabits per second (1 Mb = 1,000,000 bits): bytes/s × 8 ÷ 1,000,000
function fmtMbps(b) {
  const m = (b * 8) / 1e6;
  if (!(m > 0)) return '0 Mb/s';
  if (m >= 1000) return (m / 1000).toFixed(2) + ' Gb/s';
  return (m < 10 ? m.toFixed(2) : m < 100 ? m.toFixed(1) : m.toFixed(0)) + ' Mb/s';
}
function fmtEta(s) {
  if (s == null || !isFinite(s)) return '—';
  s = Math.round(s);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
const STATE_LABEL = { queued: 'Waiting', downloading: 'Downloading', paused: 'Paused', completed: 'Completed', error: 'Failed', scheduled: 'Scheduled', duplicate: 'Already downloaded — choose what to do' };

function matches(it) {
  if (query && !(it.filename || '').toLowerCase().includes(query) && !(it.url || '').toLowerCase().includes(query)) return false;
  if (filter === 'all') return true;
  if (filter === 'scheduled') return it.state === 'scheduled';
  if (filter === 'active') return it.state === 'downloading' || it.state === 'queued';
  return it.state === filter;
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function makeRow(id) {
  const r = el('div', 'row');
  r.innerHTML = `
    <div class="name"><div class="ficon"></div><div class="t"><div class="fn"></div><div class="sub"></div></div></div>
    <div class="num size"></div>
    <div><div class="bar"><i></i></div><div class="pct"><span class="p"></span><span class="c"></span></div></div>
    <div class="num speed"></div><div class="num eta"></div>
    <div class="acts"><button class="a1"></button><button class="a2">⋯</button></div>`;
  r.addEventListener('dblclick', () => { const it = items.get(id); if (it && it.state === 'completed') fluxget.open(id); });
  r.querySelector('.a1').addEventListener('click', (e) => { e.stopPropagation(); primary(id); });
  r.querySelector('.a2').addEventListener('click', (e) => { e.stopPropagation(); openMenu(id, e.clientX, e.clientY); });
  r.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(id, e.clientX, e.clientY); });
  return r;
}

function primary(id) {
  const it = items.get(id);
  if (!it) return;
  if (it.state === 'downloading' || it.state === 'queued') fluxget.pause(id);
  else if (it.state === 'duplicate') showDup(it);
  else if (it.needQuality) showQuality(it);
  else if (it.state === 'paused' || it.state === 'error' || it.state === 'scheduled') fluxget.resume(id);
  else if (it.state === 'completed') fluxget.open(id);
}

function updateRow(r, it) {
  const name = it.filename || it.url;
  const t = ftype(name);
  const fi = r.querySelector('.ficon');
  fi.textContent = ext(name);
  fi.style.background = COLORS[t];
  r.querySelector('.fn').textContent = name;
  r.querySelector('.fn').title = name;
  const sub = r.querySelector('.sub');
  let subText = STATE_LABEL[it.state] || it.state;
  if (it.state === 'downloading' && it.connections) subText += ` · ${it.connections} connection${it.connections > 1 ? 's' : ''}`;
  if (it.quality) subText += ` · ${it.quality}`;
  if (!it.resumable && it.state !== 'completed') subText += ' · server can’t resume (restarts from 0 if paused)';
  if (it.state === 'error') subText = it.error || 'Failed';
  if (it.state === 'error' && it.retryAt) subText = `Connection problem — retrying in ${Math.max(0, Math.round((it.retryAt - Date.now()) / 1000))} s · ${it.error}`;
  if (it.needQuality) subText = 'Waiting for you to choose a video quality';
  if (it.state === 'scheduled') subText = `Scheduled · starts at ${scheduleStart || 'the scheduled time'}`;
  if (it.state === 'completed' && it.note) subText = it.note;
  else if (it.state === 'completed' && it.verified === true) subText = 'Completed · file check passed ✓';
  if (it.postStep) subText = it.postStep;
  if (it.audioOnly) subText = '♪ Audio only · ' + subText;
  sub.textContent = subText;
  sub.title = it.url;
  sub.classList.toggle('err', it.state === 'error');
  r.querySelector('.size').textContent = fmtBytes(it.size);
  const pct = it.size > 0 ? Math.min(100, (it.downloaded / it.size) * 100) : it.state === 'completed' ? 100 : 0;
  const bar = r.querySelector('.bar');
  bar.className = 'bar' + (it.state === 'paused' || it.state === 'queued' ? ' paused' : '') + (it.state === 'error' ? ' error' : '') +
    (it.state === 'downloading' && !(it.size > 0) ? ' indet' : '');
  bar.firstElementChild.style.width = pct.toFixed(1) + '%';
  r.querySelector('.p').textContent = it.size > 0 ? pct.toFixed(1) + '%' : fmtBytes(it.downloaded);
  r.querySelector('.c').textContent = it.state === 'completed' ? '' : it.size > 0 ? `${fmtBytes(it.downloaded)}` : '';
  const sp = r.querySelector('.speed');
  if (it.state === 'downloading' && it.speed > 0) {
    sp.innerHTML = '';
    sp.append(document.createTextNode(fmtSpeed(it.speed)), el('small', null, fmtMbps(it.speed)));
  } else sp.textContent = '—';
  r.querySelector('.eta').textContent = it.state === 'downloading' ? fmtEta(it.eta) : '—';
  const a1 = r.querySelector('.a1');
  a1.textContent = it.needQuality ? 'Choose quality' : ({ downloading: 'Pause', queued: 'Pause', paused: 'Resume', error: 'Retry', completed: 'Open', scheduled: 'Start now', duplicate: 'Choose…' }[it.state] || '…');
  a1.className = 'a1' + (it.state === 'paused' || it.state === 'error' || it.needQuality || it.state === 'duplicate' ? ' primary' : '');
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const list = $('#list');
    const visible = order.map((id) => items.get(id)).filter((it) => it && matches(it));
    const want = new Set(visible.map((i) => i.id));
    for (const [id, r] of rows) if (!want.has(id) || !items.has(id)) { r.remove(); rows.delete(id); }
    let prev = null;
    for (const it of visible) {
      let r = rows.get(it.id);
      if (!r) { r = makeRow(it.id); rows.set(it.id, r); }
      updateRow(r, it);
      const expectedNext = prev ? prev.nextSibling : list.firstChild;
      if (expectedNext !== r) list.insertBefore(r, expectedNext);
      prev = r;
    }
    $('#empty').style.display = items.size ? 'none' : 'block';
    const all = [...items.values()];
    $('#c-all').textContent = all.length;
    $('#c-active').textContent = all.filter((i) => i.state === 'downloading' || i.state === 'queued').length;
    $('#c-paused').textContent = all.filter((i) => i.state === 'paused').length;
    $('#c-completed').textContent = all.filter((i) => i.state === 'completed').length;
    $('#c-error').textContent = all.filter((i) => i.state === 'error').length;
    $('#c-scheduled').textContent = all.filter((i) => i.state === 'scheduled').length;
  });
}

function drawGraph() {
  const c = $('#graph');
  const g = c.getContext('2d');
  const w = c.width; const h = c.height;
  g.clearRect(0, 0, w, h);
  const max = Math.max(1, ...history);
  g.beginPath();
  history.forEach((v, i) => { const x = (i / (history.length - 1)) * w; const y = h - (v / max) * (h - 4) - 1; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = '#3ad1b0'; g.lineWidth = 1.6; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, 'rgba(58,209,176,.35)'); grad.addColorStop(1, 'rgba(58,209,176,0)');
  g.fillStyle = grad; g.fill();
}

function setAll(list) {
  items.clear();
  for (const it of list) items.set(it.id, it);
  order = list.map((i) => i.id);
  render();
}

// ---- context menu ----
const menu = $('#menu');
function openMenu(id, x, y) {
  const it = items.get(id);
  if (!it) return;
  const opts = [];
  if (it.state === 'completed') opts.push(['Open file', () => fluxget.open(id)]);
  opts.push(['Show in folder', () => fluxget.folder(id)]);
  if (it.state === 'downloading' || it.state === 'queued') opts.push(['Pause', () => fluxget.pause(id)]);
  if (it.needQuality) opts.push(['Choose quality…', () => showQuality(it)]);
  if (it.state === 'duplicate') opts.push(['Already downloaded — choose…', () => showDup(it)]);
  if (it.state === 'completed') opts.push(['Check file (checksum)…', () => showHash(it)]);
  if (it.state === 'paused' || it.state === 'error') opts.push(['Resume', () => fluxget.resume(id)]);
  if (it.state === 'scheduled') opts.push(['Start now', () => fluxget.resume(id)]);
  if (it.state !== 'completed' && it.state !== 'scheduled') opts.push(['Download at scheduled time', () => fluxget.schedule(id)]);
  if (it.state !== 'downloading' && it.state !== 'queued') {
    if (it.state !== 'completed') opts.push(['Change link (expired link)…', () => changeUrl(id)]);
    opts.push(['Download again from start', () => fluxget.restart(id)]);
  }
  opts.push(['Copy link', () => { fluxget.ignoreClipboard(it.url); navigator.clipboard.writeText(it.url); }]);
  opts.push('-');
  opts.push(['Remove from list', () => fluxget.remove(id, false)]);
  if (it.state === 'completed') opts.push(['Delete file', () => { if (confirm(`Delete "${it.filename}" from disk?`)) fluxget.remove(id, true); }]);
  menu.innerHTML = '';
  for (const o of opts) {
    if (o === '-') { menu.appendChild(el('hr')); continue; }
    const b = el('button', null, o[0]);
    b.addEventListener('click', () => { menu.hidden = true; o[1](); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const mw = menu.offsetWidth; const mh = menu.offsetHeight;
  menu.style.left = Math.min(x, innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - mh - 8) + 'px';
}
document.addEventListener('click', () => { menu.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.hidden = true; });

function changeUrl(id) {
  const d = $('#dlg-url');
  $('#url-new').value = '';
  d.showModal();
  d.onclose = async () => {
    if (d.returnValue === 'ok' && $('#url-new').value) {
      await fluxget.updateUrl(id, $('#url-new').value.trim());
      fluxget.resume(id);
    }
  };
}

// ---- toolbar ----
const linesOf = (t) => [...new Set(t.split(/[\s]+/).map((x) => x.trim()).filter((x) => /^https?:\/\/\S+$/i.test(x)))];
function updateAddCount() {
  const n = linesOf($('#add-urls').value).length;
  $('#add-count').textContent = n > 1 ? `${n} links will be added` : '';
  $('#add-name-row').style.display = n > 1 ? 'none' : '';
}
$('#add-urls').addEventListener('input', updateAddCount);
async function openAdd(prefill) {
  const d = $('#dlg-add');
  $('#add-urls').value = prefill || '';
  $('#add-name').value = '';
  $('#add-sched').checked = false;
  $('#add-audio').checked = false;
  const s = await fluxget.getSettings();
  $('#add-sched-hint').textContent = s.scheduleEnabled ? `(${s.scheduleStart}–${s.scheduleStop})` : '(set the time in Settings → Schedule)';
  if (!prefill) {
    try {
      const clip = (await fluxget.readClipboard()).trim();
      if (linesOf(clip).length) $('#add-urls').value = linesOf(clip).join('\n');
    } catch { /* ignore */ }
  }
  updateAddCount();
  d.showModal();
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const urls = linesOf($('#add-urls').value);
    if (!urls.length) return;
    const schedule = $('#add-sched').checked;
    const audioOnly = $('#add-audio').checked;
    try {
      if (urls.length === 1) await fluxget.add({ url: urls[0], filename: $('#add-name').value.trim() || undefined, schedule, audioOnly });
      else await fluxget.addMany(urls, { schedule, audioOnly });
    } catch (e) { alert(e.message); }
  };
}
$('#btn-add').addEventListener('click', () => openAdd());
fluxget.onAddPrefill((url) => openAdd(url));

// ---- quality picker ----
function showQuality(it) {
  const d = $('#dlg-quality');
  if (d.open) d.close();
  $('#q-name').textContent = it.filename;
  $('#q-remember').checked = false;
  const list = $('#q-list');
  list.innerHTML = '';
  for (const v of it.variants || []) {
    const b = el('button', null);
    b.type = 'button';
    b.append(document.createTextNode(v.height ? v.height + 'p' : 'Stream'), el('span', null, v.bandwidth ? (v.bandwidth / 1e6).toFixed(1) + ' Mb/s video' : ''));
    b.addEventListener('click', async () => {
      if ($('#q-remember').checked && v.height) await fluxget.setSettings({ preferredQuality: String(v.height) });
      fluxget.setQuality(it.id, v.url);
      d.close();
    });
    list.appendChild(b);
  }
  d.showModal();
}
fluxget.onQuality((it) => { items.set(it.id, it); render(); showQuality(it); });

// ---- sleep / shut down countdown ----
let powerTick = null;
fluxget.onPower(({ action, seconds }) => {
  const d = $('#dlg-power');
  let left = seconds;
  const word = action === 'shutdown' ? 'shut down' : 'go to sleep';
  const upd = () => { $('#p-text').textContent = `Your PC will ${word} in ${left} seconds. Click Cancel to stop it.`; };
  $('#p-title').textContent = 'All downloads finished';
  upd();
  clearInterval(powerTick);
  powerTick = setInterval(() => { left--; upd(); if (left <= 0) clearInterval(powerTick); }, 1000);
  d.showModal();
  d.onclose = () => { clearInterval(powerTick); if (left > 0) fluxget.cancelPower(); };
});

$('#btn-pause-all').addEventListener('click', () => fluxget.pauseAll());
$('#btn-resume-all').addEventListener('click', () => fluxget.resumeAll());
$('#btn-clear').addEventListener('click', () => fluxget.clearCompleted());
$('#search').addEventListener('input', (e) => { query = e.target.value.toLowerCase(); render(); });
document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  filter = b.dataset.f;
  render();
}));

// ---- settings ----
let scheduleStart = '';
document.querySelectorAll('.tabnav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabnav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tabbody section').forEach((sec) => { sec.hidden = sec.dataset.tab !== b.dataset.tab; });
}));
function limitHint() {
  const v = Number($('#s-limit').value) || 0;
  $('#s-limit').disabled = !$('#s-limit-on').checked;
  $('#s-limit-mbs').textContent = v ? `≈ ${(v / 8).toFixed(1)} MB/s` : '';
}
$('#s-limit').addEventListener('input', limitHint);
$('#s-limit-on').addEventListener('change', limitHint);
$('#btn-settings').addEventListener('click', async () => {
  const s = await fluxget.getSettings();
  $('#s-dir').value = s.downloadDir;
  $('#s-conn').value = s.connections; $('#s-conn-v').textContent = s.connections;
  $('#s-max').value = s.maxActive; $('#s-max-v').textContent = s.maxActive;
  $('#s-startup').checked = s.startWithSystem;
  $('#s-min').checked = s.startMinimized;
  $('#s-resume').checked = s.resumeOnStartup;
  $('#s-tray').checked = s.closeToTray;
  $('#s-retry').checked = s.autoRetry !== false;
  $('#s-taskbar').checked = s.taskbarWhileDownloading !== false;
  $('#s-catch').checked = s.catchBrowserDownloads;
  $('#s-front').checked = s.bringToFront !== false;
  $('#s-clip').checked = s.watchClipboard !== false;
  $('#s-limit-on').checked = s.speedLimitMbps > 0;
  $('#s-limit').value = s.speedLimitMbps > 0 ? s.speedLimitMbps : (s.lastSpeedLimitMbps || 50);
  limitHint();
  $('#s-sort').checked = s.sortByType !== false;
  $('#s-quality').value = s.preferredQuality || 'ask';
  $('#s-sched').checked = !!s.scheduleEnabled;
  $('#s-sched-start').value = s.scheduleStart || '02:00';
  $('#s-sched-stop').value = s.scheduleStop || '08:00';
  $('#s-after').value = s.afterAll || 'nothing';
  $('#s-popup').checked = s.completePopup !== false;
  $('#s-sound').checked = s.completeSound !== false;
  $('#s-notify').checked = s.notifyOnComplete;
  $('#s-theme').value = s.theme || 'dark';
  $('#s-mini').value = s.miniWindow === true ? 'downloading' : (s.miniWindow || 'off');
  $('#s-dup').value = s.duplicateAction || 'ask';
  $('#s-verify').checked = s.autoVerify !== false;
  $('#s-audiofmt').value = s.audioFormat || 'original';
  refreshFfmpeg();
  $('#s-ver').textContent = `BladeMail ${s.version}. Data is kept only on this computer.`;
  const d = $('#dlg-settings');
  d.showModal();
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const lim = Math.max(1, Number($('#s-limit').value) || 50);
    const saved = await fluxget.setSettings({
      downloadDir: $('#s-dir').value, connections: Number($('#s-conn').value), maxActive: Number($('#s-max').value),
      startWithSystem: $('#s-startup').checked, startMinimized: $('#s-min').checked, resumeOnStartup: $('#s-resume').checked,
      closeToTray: $('#s-tray').checked, autoRetry: $('#s-retry').checked, taskbarWhileDownloading: $('#s-taskbar').checked,
      catchBrowserDownloads: $('#s-catch').checked, bringToFront: $('#s-front').checked, watchClipboard: $('#s-clip').checked,
      speedLimitMbps: $('#s-limit-on').checked ? lim : 0, lastSpeedLimitMbps: lim,
      sortByType: $('#s-sort').checked, preferredQuality: $('#s-quality').value,
      scheduleEnabled: $('#s-sched').checked, scheduleStart: $('#s-sched-start').value || '02:00', scheduleStop: $('#s-sched-stop').value || '08:00',
      afterAll: $('#s-after').value,
      theme: $('#s-theme').value, miniWindow: $('#s-mini').value, duplicateAction: $('#s-dup').value,
      autoVerify: $('#s-verify').checked, audioFormat: $('#s-audiofmt').value,
      completePopup: $('#s-popup').checked, completeSound: $('#s-sound').checked, notifyOnComplete: $('#s-notify').checked,
    });
    scheduleStart = saved.scheduleEnabled ? saved.scheduleStart : '';
    showLimitBadge(saved);
    render();
  };
});
$('#s-conn').addEventListener('input', (e) => { $('#s-conn-v').textContent = e.target.value; });
$('#s-max').addEventListener('input', (e) => { $('#s-max-v').textContent = e.target.value; });
$('#s-dir-pick').addEventListener('click', async () => { const d = await fluxget.pickDir(); if (d) $('#s-dir').value = d; });
function showLimitBadge(s) {
  $('#limit-badge').textContent = s.speedLimitMbps > 0 ? `Speed limit: ${s.speedLimitMbps} Mb/s` : '';
}

// ---- browser extension setup ----
async function showExtGuide() {
  const { browsers } = await fluxget.extInfo();
  const list = $('#ext-list');
  list.innerHTML = '';
  if (!browsers.length) list.appendChild(el('p', 'muted', 'No supported browser was found on this PC.'));
  for (const b of browsers) {
    const row = el('div', 'ext-row');
    const n = el('div', 'bn', b.name);
    n.appendChild(el('small', null, b.kind === 'firefox' ? 'Temporary add-on (see note below)' : 'Load unpacked → choose the extension folder'));
    const open = el('button', 'primary', b.kind === 'firefox' ? 'Open add-on page' : 'Open extensions page');
    open.type = 'button';
    open.addEventListener('click', async () => { await fluxget.extCopy(b.kind); fluxget.extOpen(b.id); fluxget.extFolder(b.kind); });
    const folder = el('button', null, 'Show folder');
    folder.type = 'button';
    folder.addEventListener('click', () => fluxget.extFolder(b.kind));
    const copy = el('button', null, 'Copy path');
    copy.type = 'button';
    copy.addEventListener('click', async () => { await fluxget.extCopy(b.kind); copy.textContent = 'Copied ✓'; });
    row.append(n, open, folder, copy);
    list.appendChild(row);
  }
  $('#ext-ff-note').hidden = !browsers.some((b) => b.kind === 'firefox');
  $('#dlg-ext').showModal();
  fluxget.extFirstRunDone();
}
$('#btn-ext').addEventListener('click', showExtGuide);
fluxget.onHighlight((ids) => {
  // show the new download: switch to All, scroll to it and flash the row
  if (filter !== 'all') document.querySelector('.filter[data-f="all"]').click();
  setTimeout(() => {
    for (const id of ids) {
      const r = rows.get(id);
      if (!r) continue;
      r.scrollIntoView({ block: 'nearest' });
      r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash');
    }
  }, 100);
});
fluxget.onShowExtGuide(showExtGuide);

// ---- live updates ----
fluxget.onAdded((it) => { items.set(it.id, it); order.unshift(it.id); render(); });
fluxget.onUpdate((it) => { if (!items.has(it.id)) order.unshift(it.id); items.set(it.id, it); render(); });
fluxget.onRemoved((id) => { items.delete(id); order = order.filter((x) => x !== id); render(); });
fluxget.onList(setAll);
fluxget.onTick(({ updates, totalSpeed }) => {
  for (const u of updates) items.set(u.id, u);
  history.push(totalSpeed); history.shift();
  $('#total-speed').textContent = totalSpeed > 0 ? fmtBytes(totalSpeed) + '/s' : '0 KB/s';
  $('#total-mbps').textContent = fmtMbps(totalSpeed);
  peak = Math.max(peak, totalSpeed);
  $('#peak').textContent = peak > 0 ? `Peak ${fmtMbps(peak)} · ${fmtBytes(peak)}/s` : '';
  drawGraph();
  if (updates.length) render();
});

(async () => {
  setAll(await fluxget.list());
  const s = await fluxget.getSettings();
  $('#port').textContent = s.port;
  scheduleStart = s.scheduleEnabled ? s.scheduleStart : '';
  showLimitBadge(s);
  if (s.showExtensionGuide) showExtGuide();
  drawGraph();
})();

// keep "retrying in N s" countdowns fresh
setInterval(() => { for (const it of items.values()) if (it.retryAt) { render(); break; } }, 1000);

// ---- duplicate prompt ----
let dupQueue = [];
function showDup(it) {
  const d = $('#dlg-dup');
  if (d.open) { if (!dupQueue.includes(it.id)) dupQueue.push(it.id); return; }
  const dup = it.dup || {};
  $('#dup-text').textContent = `"${dup.name || it.filenameHint || it.url}" is already in your downloads` +
    (dup.path ? ` (${dup.path}).` : '.') + ' What should BladeMail do?';
  $('#dup-remember').checked = false;
  d.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.a;
      if ($('#dup-remember').checked) await fluxget.setSettings({ duplicateAction: a === 'rename' ? 'rename' : a });
      d.close();
      await fluxget.resolveDuplicate(it.id, a);
    };
  });
  d.onclose = () => {
    const next = dupQueue.shift();
    const nit = next && items.get(next);
    if (nit && nit.state === 'duplicate') setTimeout(() => showDup(nit), 50);
  };
  d.showModal();
}
fluxget.onDuplicate((s) => { items.set(s.id, { ...(items.get(s.id) || {}), ...s }); showDup(items.get(s.id)); });

// ---- file check (checksums) ----
let hashes = null;
function compareHash() {
  const res = $('#h-result');
  const want = $('#h-expected').value.trim().toLowerCase().replace(/^.*?([0-9a-f]{32,64}).*$/, '$1');
  res.className = 'hres';
  if (!want || !hashes) { res.textContent = ''; return; }
  const algo = { 32: 'md5', 40: 'sha1', 64: 'sha256' }[want.length];
  if (!algo) { res.textContent = 'That doesn’t look like an MD5, SHA-1 or SHA-256 checksum.'; return; }
  const ok = hashes[algo] === want;
  res.classList.add(ok ? 'ok' : 'bad');
  res.textContent = ok ? `✓ Match — the file is exactly what the website published (${algo.toUpperCase()}).`
    : `✗ Does not match (${algo.toUpperCase()}). The file may be damaged or different from the one on the website.`;
}
$('#h-expected').addEventListener('input', compareHash);
async function showHash(it) {
  const d = $('#dlg-hash');
  hashes = null;
  $('#h-name').textContent = it.filename;
  $('#h-list').innerHTML = '';
  $('#h-expected').value = '';
  $('#h-result').textContent = '';
  $('#h-status').textContent = 'Calculating… 0%';
  d.showModal();
  try {
    const h = await fluxget.hashFile(it.id);
    hashes = h;
    $('#h-status').textContent = h.expectedMd5
      ? (h.expectedMd5 === h.md5 ? '✓ Matches the checksum the server sent.' : '✗ Does NOT match the checksum the server sent.')
      : 'Copy a value below, or paste the one from the website to compare.';
    for (const a of ['md5', 'sha1', 'sha256']) {
      const row = el('div', 'hrow2');
      const lab = el('b', null, a === 'sha1' ? 'SHA-1' : a === 'sha256' ? 'SHA-256' : 'MD5');
      const code = el('code', null, h[a]);
      const cp = el('button', null, 'Copy');
      cp.type = 'button';
      cp.onclick = () => { fluxget.ignoreClipboard(h[a]); navigator.clipboard.writeText(h[a]); cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1200); };
      row.append(lab, code, cp);
      $('#h-list').appendChild(row);
    }
    compareHash();
  } catch (e) { $('#h-status').textContent = 'Could not read the file: ' + e.message.replace(/^.*Error: /, ''); }
}
fluxget.onHashProgress((p) => { if (!hashes) $('#h-status').textContent = `Calculating… ${Math.round(p * 100)}%`; });

// ---- history & stats ----
let histList = [];
function renderHistory() {
  const q = $('#h-search').value.trim().toLowerCase();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const sum = (arr) => arr.reduce((a, h) => a + (h.size > 0 ? h.size : 0), 0);
  const speeds = histList.filter((h) => h.avgSpeed > 0).map((h) => h.avgSpeed);
  const avg = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
  const tiles = [
    ['Total downloaded', fmtBytes(sum(histList))],
    ['This month', fmtBytes(sum(histList.filter((h) => h.at >= monthStart)))],
    ['Today', fmtBytes(sum(histList.filter((h) => h.at >= dayStart)))],
    ['Files', String(histList.length)],
    ['Average speed', avg ? `${fmtSpeed(avg)} · ${fmtMbps(avg)}` : '—'],
  ];
  const st = $('#stats');
  st.innerHTML = '';
  for (const [k, v] of tiles) { const t = el('div', 'stat'); t.append(el('small', null, k), el('b', null, v)); st.appendChild(t); }
  const list = $('#hist');
  list.innerHTML = '';
  const shown = histList.filter((h) => !q || (h.name || '').toLowerCase().includes(q) || (h.url || '').toLowerCase().includes(q)).slice(0, 500);
  if (!shown.length) { list.appendChild(el('div', 'muted empty', histList.length ? 'Nothing matches your search.' : 'No finished downloads yet.')); return; }
  for (const h of shown) {
    const r = el('div', 'hrow');
    const t = el('div', 't');
    t.append(el('div', 'fn', h.name || h.url), el('div', 'sub', `${new Date(h.at).toLocaleString()} · ${fmtBytes(h.size)} · ${h.type || ''}`));
    t.title = h.url;
    const o = el('button', null, 'Open'); o.type = 'button';
    o.onclick = async () => { const err = await fluxget.openPath(h.path); if (err) o.textContent = 'File moved or deleted'; };
    const f = el('button', null, 'Folder'); f.type = 'button';
    f.onclick = async () => { const err = await fluxget.showPath(h.path); if (err) f.textContent = 'Not found'; };
    r.append(t, o, f);
    list.appendChild(r);
  }
}
$('#h-search').addEventListener('input', renderHistory);
$('#h-clear').addEventListener('click', async () => {
  if (!confirm('Clear the whole download history? Your files are not deleted.')) return;
  await fluxget.clearHistory(); histList = []; renderHistory();
});
$('#btn-history').addEventListener('click', async () => {
  histList = await fluxget.getHistory();
  $('#h-search').value = '';
  renderHistory();
  $('#dlg-history').showModal();
});

// ---- ffmpeg add-on (audio only, stream merging) ----
async function refreshFfmpeg() {
  const st = await fluxget.ffmpegStatus();
  $('#ff-status').textContent = st.path ? '✓ ffmpeg is installed — audio only is ready.' : 'Audio only needs the free ffmpeg tool (one-time download, about 100 MB).';
  $('#ff-get').hidden = !!st.path;
}
$('#ff-get').addEventListener('click', async () => {
  const b = $('#ff-get');
  b.disabled = true;
  try { await fluxget.installFfmpeg(); } catch (e) { $('#ff-status').textContent = 'Download failed: ' + e.message.replace(/^.*Error: /, ''); b.disabled = false; return; }
  b.disabled = false;
  refreshFfmpeg();
});
fluxget.onToolsProgress((p) => {
  if (p.stage === 'download') $('#ff-status').textContent = `Downloading ffmpeg… ${p.total ? Math.round(p.done / p.total * 100) + '%' : fmtBytes(p.done)}`;
  else if (p.stage === 'extract') $('#ff-status').textContent = 'Unpacking ffmpeg…';
});
