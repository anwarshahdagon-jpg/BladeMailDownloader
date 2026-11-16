'use strict';
/* "Download all links on this page": lists the links, images and media of a tab, filtered by type. */
const TYPES = [
  ['video', 'Video', /\.(mp4|webm|mkv|mov|m4v|flv|avi|wmv|3gp|ogv|m3u8)$/i, '#f28b5b'],
  ['audio', 'Audio', /\.(mp3|m4a|aac|ogg|opus|wav|flac|wma)$/i, '#c58af9'],
  ['archive', 'Archives', /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|cab)$/i, '#f5d061'],
  ['program', 'Programs', /\.(exe|msi|msix|appx|dmg|pkg|deb|rpm|apk|appimage|bat|jar)$/i, '#6fb6ff'],
  ['doc', 'Documents', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|epub|mobi)$/i, '#7ee0a8'],
  ['image', 'Images', /\.(jpe?g|png|gif|webp|bmp|svg|tiff?|avif|heic|ico)$/i, '#ff8fb8'],
  ['other', 'Other', /./, '#9aa7bf'],
];
const $ = (s) => document.querySelector(s);
const tabId = Number(new URLSearchParams(location.search).get('tab'));
let links = []; // {url, name, type}
const on = new Set(['video', 'audio', 'archive', 'program', 'doc']);
const picked = new Set();
let pageUrl = '';

function typeOf(url) {
  let p = url;
  try { p = decodeURIComponent(new URL(url).pathname); } catch { /* keep */ }
  for (const [k, , re] of TYPES) if (k !== 'other' && re.test(p)) return k;
  return 'other';
}
function nameOf(url, text) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return last;
  } catch { /* ignore */ }
  return (text || '').trim().slice(0, 120) || url;
}

// Runs inside the page: collect every link, image and media source.
function collect() {
  const out = [];
  const add = (u, text) => { if (u && /^https?:/i.test(u)) out.push([u, text || '']); };
  document.querySelectorAll('a[href]').forEach((a) => add(a.href, a.textContent || a.title));
  document.querySelectorAll('img').forEach((i) => add(i.currentSrc || i.src, i.alt));
  document.querySelectorAll('video, audio, source').forEach((v) => add(v.currentSrc || v.src, document.title));
  return { links: out, url: location.href, title: document.title };
}

async function load() {
  if (!tabId) { $('#src').textContent = 'Open this from the right-click menu on a page.'; return; }
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { $('#src').textContent = 'That tab was closed.'; return; }
  pageUrl = tab.url;
  $('#src').textContent = `${tab.title} — ${tab.url}`;
  document.title = 'Links on ' + tab.title;
  const raw = [];
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collect });
    for (const r of res) if (r && r.result) raw.push(...r.result.links);
  } catch (e) {
    $('#src').textContent = `BladeMail can't read this page (${tab.url}). Browser pages and the extension store are off limits.`;
  }
  // Videos the extension noticed playing on the tab.
  try {
    const media = await chrome.runtime.sendMessage({ type: 'mediaForTab', tabId });
    for (const m of media || []) if (m.kind === 'video' || m.kind === 'audio' || m.kind === 'hls') raw.push([m.url, tab.title]);
  } catch { /* ignore */ }
  const seen = new Set();
  links = [];
  for (const [u, text] of raw) {
    const url = u.split('#')[0];
    if (seen.has(url) || url === pageUrl.split('#')[0]) continue;
    seen.add(url);
    links.push({ url, name: nameOf(url, text), type: typeOf(url) });
  }
  const order = Object.fromEntries(TYPES.map(([k], i) => [k, i]));
  links.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  // If the page has no files at all, show everything so the list isn't empty.
  if (!links.some((l) => on.has(l.type))) TYPES.forEach(([k]) => on.add(k));
  render();
}

function shown() {
  const q = $('#q').value.trim().toLowerCase();
  return links.filter((l) => on.has(l.type) && (!q || l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q)));
}

function render() {
  const chips = $('#chips');
  chips.innerHTML = '';
  for (const [k, label] of TYPES) {
    const n = links.filter((l) => l.type === k).length;
    if (!n) continue;
    const b = document.createElement('button');
    b.className = 'chip' + (on.has(k) ? ' on' : '');
    b.innerHTML = `${label}<small>${n}</small>`;
    b.onclick = () => { if (on.has(k)) on.delete(k); else on.add(k); render(); };
    chips.appendChild(b);
  }
  const list = $('#list');
  list.innerHTML = '';
  const vis = shown();
  if (!vis.length) { list.innerHTML = `<div class="empty">${links.length ? 'Nothing matches the filters.' : 'No links found on this page.'}</div>`; }
  for (const l of vis) {
    const r = document.createElement('label');
    r.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = picked.has(l.url);
    cb.onchange = () => { if (cb.checked) picked.add(l.url); else picked.delete(l.url); count(); };
    const tag = document.createElement('div');
    tag.className = 'tag';
    const t = TYPES.find(([k]) => k === l.type);
    tag.style.background = t[3];
    tag.textContent = (/\.([a-z0-9]{1,5})$/i.exec(l.name) || [, t[1].slice(0, 5)])[1].toUpperCase();
    const txt = document.createElement('div');
    txt.className = 't';
    const n = document.createElement('div'); n.className = 'n'; n.textContent = l.name;
    const u = document.createElement('div'); u.className = 'u'; u.textContent = l.url;
    txt.append(n, u);
    r.append(cb, tag, txt);
    list.appendChild(r);
  }
  count();
}

function count() {
  const vis = shown();
  const sel = vis.filter((l) => picked.has(l.url)).length;
  $('#all').checked = vis.length > 0 && sel === vis.length;
  $('#go').disabled = !sel;
  $('#go').textContent = sel ? `Download selected (${sel})` : 'Download selected';
}

$('#q').addEventListener('input', render);
$('#all').addEventListener('change', () => {
  for (const l of shown()) { if ($('#all').checked) picked.add(l.url); else picked.delete(l.url); }
  render();
});
$('#go').addEventListener('click', async () => {
  const urls = shown().filter((l) => picked.has(l.url)).map((l) => l.url);
  if (!urls.length) return;
  $('#go').disabled = true;
  $('#msg').className = '';
  $('#msg').textContent = 'Sending…';
  const r = await chrome.runtime.sendMessage({ type: 'addBatch', items: urls, referer: pageUrl });
  if (r && r.ok) {
    $('#msg').textContent = `Sent ${r.added} to BladeMail` + (r.skipped ? ` · ${r.skipped} already downloaded` : '') + '.';
    for (const u of urls) picked.delete(u);
    render();
  } else {
    $('#msg').className = 'err';
    $('#msg').textContent = (r && r.message) || 'Something went wrong';
    $('#go').disabled = false;
  }
});
load();
