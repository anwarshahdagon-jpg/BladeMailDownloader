'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIME_EXT = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/quicktime': '.mov',
  'video/x-flv': '.flv', 'video/mp2t': '.ts', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg',
  'audio/wav': '.wav', 'audio/webm': '.weba', 'application/pdf': '.pdf', 'application/zip': '.zip',
  'application/x-zip-compressed': '.zip', 'application/x-7z-compressed': '.7z', 'application/x-rar-compressed': '.rar',
  'application/vnd.rar': '.rar', 'application/x-msdownload': '.exe', 'application/x-msi': '.msi',
  'application/gzip': '.gz', 'application/x-tar': '.tar', 'image/jpeg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif', 'image/webp': '.webp', 'application/vnd.android.package-archive': '.apk',
  'application/x-iso9660-image': '.iso', 'text/plain': '.txt', 'application/json': '.json',
};

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!n || RESERVED.test(n)) n = 'download' + (n ? '_' + n : '');
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 180 - ext.length).trim() + ext;
  }
  return n;
}

function filenameFromContentDisposition(cd) {
  if (!cd) return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) {
    const raw = m[1].trim();
    try { return decodeURIComponent(escape(raw)); } catch { return raw; } // latin1 -> utf8 when servers send raw utf8
  }
  return null;
}

function filenameFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const base = p.split('/').filter(Boolean).pop();
    if (!base) return null;
    return decodeURIComponent(base);
  } catch { return null; }
}

function extFromMime(ct) {
  if (!ct) return '';
  return MIME_EXT[ct.split(';')[0].trim().toLowerCase()] || '';
}

function chooseFilename({ hint, contentDisposition, url, contentType }) {
  let name = (hint && hint.trim()) || filenameFromContentDisposition(contentDisposition) || filenameFromUrl(url) || 'download';
  name = sanitizeFilename(name);
  if (!path.extname(name)) name += extFromMime(contentType);
  return name;
}

/** Returns a path in dir that does not exist yet and is not in `taken`. */
function uniquePath(dir, name, taken = new Set()) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let i = 0;
  for (;;) {
    const candidate = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    const lower = candidate.toLowerCase();
    if (!taken.has(lower) && !fs.existsSync(candidate) && !fs.existsSync(candidate + '.fgpart')) return candidate;
    i++;
  }
}

const CATEGORIES = [
  ['Video', /\.(mp4|mkv|webm|avi|mov|flv|m4v|ts|wmv|3gp|mpg|mpeg|ogv)$/i],
  ['Music', /\.(mp3|m4a|aac|flac|wav|ogg|opus|weba|wma)$/i],
  ['Compressed', /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|iso|img)$/i],
  ['Programs', /\.(exe|msi|msix|appx|apk|bat|cmd|jar|deb|rpm|dmg|appimage)$/i],
  ['Documents', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|rtf|csv|epub|mobi|md)$/i],
  ['Pictures', /\.(jpe?g|png|gif|webp|bmp|svg|heic|tiff?|ico)$/i],
];
/** Folder name for a file (used by "sort downloads into folders by type"). */
function categoryOf(name) {
  for (const [folder, re] of CATEGORIES) if (re.test(name || '')) return folder;
  return 'Other';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAbort(e) {
  return e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || (e.cause && e.cause.name === 'AbortError'));
}

module.exports = {
  DEFAULT_UA, sanitizeFilename, filenameFromContentDisposition, filenameFromUrl, extFromMime,
  chooseFilename, uniquePath, sleep, isAbort, categoryOf,
};
