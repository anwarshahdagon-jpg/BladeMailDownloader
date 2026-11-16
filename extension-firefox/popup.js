'use strict';
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

function fmt(b) {
  if (!(b > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i ? 1 : 0) + ' ' + u[i];
}

function nameOf(url) {
  try { const p = new URL(url).pathname.split('/').filter(Boolean).pop(); return decodeURIComponent(p || url); } catch { return url; }
}

(async () => {
  const { app, settings } = await send({ type: 'status' });
  $('#catch').checked = settings.catchDownloads;
  $('#vbtn').checked = settings.videoButton;
  if (app && app.ok) {
    $('#dot').classList.add('on');
    $('#st').textContent = 'Connected';
    if (app.catchDownloads === false) $('#help').textContent = 'Taking over downloads is turned off inside the BladeMail app settings.';
  } else {
    $('#st').textContent = 'App not running';
    $('#help').textContent = 'Start the BladeMail app on this computer. Until then Chrome downloads normally.';
  }
  $('#catch').addEventListener('change', (e) => chrome.storage.local.set({ catchDownloads: e.target.checked }));
  $('#vbtn').addEventListener('change', (e) => chrome.storage.local.set({ videoButton: e.target.checked }));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const list = (await send({ type: 'mediaForTab', tabId: tab.id })) || [];
  const box = $('#media');
  if (!list.length) return;
  box.innerHTML = '';
  const sorted = [...list].sort((a, b) => (a.kind === 'hls' ? -1 : 0) - (b.kind === 'hls' ? -1 : 0) || b.size - a.size);
  for (const e of sorted) {
    const row = document.createElement('div');
    row.className = 'm';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = e.kind === 'hls' ? 'STREAM' : e.kind === 'dash' ? 'DASH' : e.kind.toUpperCase();
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = nameOf(e.url) + (e.size > 0 ? ` · ${fmt(e.size)}` : '');
    n.title = e.url;
    const b = document.createElement('button');
    b.textContent = 'Download';
    if (e.kind === 'dash') { b.disabled = true; b.title = 'DASH streams are not supported'; }
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await send({ type: 'downloadEntry', tabId: tab.id, entry: e });
      b.textContent = r && r.ok ? 'Sent ✓' : 'Failed';
      if (!(r && r.ok)) $('#help').textContent = (r && r.message) || 'BladeMail is not running';
    });
    row.append(k, n, b);
    box.appendChild(row);
  }
})();
