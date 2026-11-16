'use strict';
/* BladeMail Connector — background service worker */
const API = 'http://127.0.0.1:47815';
const DEFAULTS = { catchDownloads: true, videoButton: true };

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|flv|avi|wmv|3gp|ogv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|aac)$/i;

const getSettings = () => chrome.storage.local.get(DEFAULTS);

async function api(path, body, timeout = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(API + path, {
      method: body ? 'POST' : 'GET', signal: ac.signal,
      headers: { 'X-FluxGet': '1', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

// ---------------- media detection (network sniffing) ----------------
const key = (tabId) => 't' + tabId;

async function getMedia(tabId) {
  const k = key(tabId);
  const r = await chrome.storage.session.get(k);
  return r[k] || [];
}

async function setMedia(tabId, list) {
  await chrome.storage.session.set({ [key(tabId)]: list });
  const n = list.filter((m) => m.kind !== 'dash').length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2a9bf5' }).catch(() => {});
}

function header(details, name) {
  const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function stripRangeParams(u) {
  try {
    const x = new URL(u);
    for (const p of ['range', 'bytes', 'rn', 'rbuf']) x.searchParams.delete(p);
    return x.href;
  } catch { return u; }
}

function classify(details) {
  let path = '';
  try { path = new URL(details.url).pathname; } catch { return null; }
  const ct = header(details, 'content-type').toLowerCase();
  if (/mpegurl/.test(ct) || /\.m3u8$/i.test(path)) return 'hls';
  if (/dash\+xml/.test(ct) || /\.mpd$/i.test(path)) return 'dash';
  if (/video\/mp2t/.test(ct) || SEGMENT_EXT.test(path)) return null; // pieces of a stream, not a whole video
  if (/[?&](range|bytes)=/.test(details.url)) return null; // chunked players (e.g. MSE byte-range fetches)
  if (ct.startsWith('video/') || VIDEO_EXT.test(path)) return 'video';
  if (ct.startsWith('audio/') || AUDIO_EXT.test(path)) return 'audio';
  return null;
}

let writeChain = Promise.resolve();
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || (details.statusCode !== 200 && details.statusCode !== 206)) return;
    const kind = classify(details);
    if (!kind) return;
    let size = -1;
    const cr = /\/(\d+)\s*$/.exec(header(details, 'content-range'));
    if (cr) size = Number(cr[1]);
    else if (details.statusCode === 200 && /^\d+$/.test(header(details, 'content-length'))) size = Number(header(details, 'content-length'));
    if ((kind === 'video' || kind === 'audio') && size > 0 && size < 300 * 1024) return; // tiny clips / icons
    const entry = {
      url: stripRangeParams(details.url), kind, size, contentType: header(details, 'content-type'),
      frameId: details.frameId, initiator: details.initiator || '', time: Date.now(),
    };
    writeChain = writeChain.then(async () => {
      const list = await getMedia(details.tabId);
      const existing = list.find((m) => m.url === entry.url);
      if (existing) { if (size > existing.size) existing.size = size; }
      else { list.push(entry); if (list.length > 60) list.shift(); }
      await setMedia(details.tabId, list);
    }).catch(() => {});
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders'],
);

// A new page in the tab: forget media from the previous page.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0) writeChain = writeChain.then(() => setMedia(d.tabId, [])).catch(() => {}); },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
);
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

// ---------------- sending things to BladeMail ----------------
function extOf(u) {
  try { const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(u).pathname); return m ? '.' + m[1].toLowerCase() : ''; } catch { return ''; }
}

function cleanTitle(t) {
  return (t || 'video').replace(/\s*[-|–]\s*[^-|–]{1,30}$/, '').replace(/^\(\d+\)\s*/, '').trim().slice(0, 150) || 'video';
}

/** Pick the best downloadable source for a video the user clicked. */
async function pickSource(tabId, msg) {
  const direct = [msg.src, ...(msg.sources || [])].find((s) => /^https?:/i.test(s || ''));
  if (direct) {
    return { url: direct, kind: /\.m3u8(\?|$)/i.test(direct) ? 'hls' : 'file' };
  }
  const list = await getMedia(tabId);
  const hls = list.filter((m) => m.kind === 'hls');
  const files = list.filter((m) => m.kind === 'video').sort((a, b) => b.size - a.size);
  if (hls.length) {
    const master = hls.find((m) => /master|index|playlist|manifest/i.test(m.url)) || hls[0];
    return { url: master.url, kind: 'hls' };
  }
  if (files.length) return { url: files[0].url, kind: 'file', contentType: files[0].contentType };
  if (list.some((m) => m.kind === 'dash')) {
    return { error: 'This video uses DASH streaming, which BladeMail cannot save yet.' };
  }
  return {
    error: 'No downloadable stream found. The video is probably DRM-protected or streamed in a way BladeMail can\'t save. Try playing it for a few seconds, then click again.',
  };
}

async function sendVideo(tabId, frameUrl, msg) {
  const src = await pickSource(tabId, msg);
  if (src.error) return { ok: false, message: src.error };
  const title = cleanTitle(msg.title);
  let filename = title;
  if (src.kind === 'file') {
    let e = extOf(src.url);
    if (!/^\.(mp4|webm|mkv|mov|m4v|flv|avi|wmv|3gp|ogv|mp3|m4a|aac|ogg|opus|wav|flac)$/.test(e)) {
      e = /webm/.test(src.contentType || '') ? '.webm' : '.mp4';
    }
    filename = title + e;
  }
  let origin;
  try { origin = new URL(frameUrl).origin; } catch { /* ignore */ }
  const body = {
    url: src.url, kind: src.kind, filename, referer: frameUrl, origin: src.kind === 'hls' ? origin : undefined,
    cookies: await cookieHeader(src.url), userAgent: navigator.userAgent, audioOnly: !!msg.audioOnly,
  };
  const r = await api('/add', body);
  if (!r) return { ok: false, message: 'BladeMail is not running. Start the BladeMail app and try again.' };
  if (!r.ok) return { ok: false, message: r.error || 'BladeMail refused the download' };
  if (r.skipped && !(r.items && r.items.length)) return { ok: true, message: 'Already downloaded — skipped' };
  return { ok: true, message: msg.audioOnly ? 'Sent to BladeMail (audio only)' : 'Sent to BladeMail' };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'downloadVideo') {
      return sendVideo(sender.tab.id, sender.url || (sender.tab && sender.tab.url), msg);
    }
    if (msg.type === 'getSettings') return getSettings();
    if (msg.type === 'status') return { app: await api('/ping', null, 1500), settings: await getSettings() };
    if (msg.type === 'mediaForTab') return getMedia(msg.tabId);
    if (msg.type === 'addBatch') return addBatch(msg.items, msg.referer);
    if (msg.type === 'downloadEntry') {
      const tab = await chrome.tabs.get(msg.tabId);
      const e = msg.entry;
      const r = await api('/add', {
        url: e.url, kind: e.kind === 'hls' ? 'hls' : 'file', filename: e.kind === 'hls' ? cleanTitle(tab.title) : undefined,
        referer: tab.url, origin: (() => { try { return new URL(tab.url).origin; } catch { return undefined; } })(),
        cookies: await cookieHeader(e.url), userAgent: navigator.userAgent,
      });
      return r && r.ok ? { ok: true } : { ok: false, message: r ? r.error : 'BladeMail is not running' };
    }
    return null;
  })().then(reply, (e) => reply({ ok: false, message: String(e && e.message || e) }));
  return true;
});

// ---------------- take over Chrome downloads ----------------
// Chrome: onDeterminingFilename runs BEFORE Chrome picks a path or shows its "Save as" dialog.
// We hold the download there, hand it to BladeMail, and cancel it, so the dialog never appears.
// If BladeMail isn't running (or refuses), we release it and Chrome downloads as usual.
const handled = new Set();

async function handOver(item, nameHint) {
  const s = await getSettings();
  if (!s.catchDownloads) return false;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url) || item.byExtensionId) return false;
  if (handled.has(item.id)) return false;
  handled.add(item.id);
  const r = await api('/add', {
    url, kind: 'file', intercept: true, filename: nameHint || undefined, referer: item.referrer || undefined,
    cookies: await cookieHeader(url), userAgent: navigator.userAgent,
  }, 2000);
  if (!(r && r.ok)) return false;
  try { await chrome.downloads.cancel(item.id); } catch { /* already finished */ }
  try { await chrome.downloads.erase({ id: item.id }); } catch { /* ignore */ }
  return true;
}

const baseName = (f) => (f || '').split(/[\\/]/).pop() || '';

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    handOver(item, baseName(item.filename))
      .then((taken) => { if (!taken) suggest(); })
      .catch(() => suggest());
    return true; // we answer asynchronously
  });
} else {
  // Firefox has no onDeterminingFilename: take over as soon as the download is created.
  chrome.downloads.onCreated.addListener((item) => {
    if (item.state === 'in_progress') handOver(item, baseName(item.filename)).catch(() => {});
  });
}

// ---------------- right-click menu ----------------
function makeMenus() {
  chrome.contextMenus.removeAll(() => {
    const m = (id, title, contexts) => chrome.contextMenus.create({ id, title, contexts });
    m('fg-link', 'Download link with BladeMail', ['link']);
    m('fg-image', 'Download image with BladeMail', ['image']);
    m('fg-media', 'Download this with BladeMail', ['video', 'audio']);
    m('fg-audio', 'Download audio only with BladeMail', ['video']);
    m('fg-page', 'Download this page with BladeMail', ['page']);
    m('fg-all', 'Download all links on this page…', ['page', 'link', 'image']);
  });
}
chrome.runtime.onInstalled.addListener(makeMenus);
chrome.runtime.onStartup.addListener(makeMenus);

async function addOne(url, referer) {
  return api('/add', { url, referer, cookies: await cookieHeader(url), userAgent: navigator.userAgent });
}

/** Many links at once (from the "all links" page); one request, cookies per link. */
async function addBatch(urls, referer) {
  const items = [];
  for (const url of urls) items.push({ url, referer, cookies: await cookieHeader(url), userAgent: navigator.userAgent });
  const r = await api('/add', { items }, 15000);
  if (!r) return { ok: false, message: 'BladeMail is not running. Start the BladeMail app and try again.' };
  if (!r.ok) return { ok: false, message: r.error || 'BladeMail refused the links' };
  return { ok: true, added: (r.items || []).length, skipped: r.skipped || 0 };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (id === 'fg-link' && info.linkUrl) await addOne(info.linkUrl, info.pageUrl);
  else if (id === 'fg-image' && /^https?:/i.test(info.srcUrl || '')) await addOne(info.srcUrl, info.pageUrl);
  else if (id === 'fg-page' && /^https?:/i.test(info.pageUrl || '')) await addOne(info.pageUrl, undefined);
  else if ((id === 'fg-media' || id === 'fg-audio') && tab) {
    await sendVideo(tab.id, info.frameUrl || info.pageUrl, { src: info.srcUrl, title: tab.title, audioOnly: id === 'fg-audio' });
  } else if (id === 'fg-all' && tab) {
    chrome.tabs.create({ url: chrome.runtime.getURL('grab.html') + '?tab=' + tab.id, index: tab.index + 1 });
  }
});
