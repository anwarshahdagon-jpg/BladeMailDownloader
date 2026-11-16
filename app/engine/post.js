'use strict';
/**
 * After-download helpers: checksums, ffmpeg (optional add-on) and audio extraction.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/** Hash a file with one or more algorithms in a single read. */
function hashFile(file, algos = ['md5', 'sha1', 'sha256'], onProgress) {
  return new Promise((resolve, reject) => {
    const hs = algos.map((a) => crypto.createHash(a));
    let done = 0;
    let total = 0;
    try { total = fs.statSync(file).size; } catch (e) { return reject(e); }
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => { for (const h of hs) h.update(c); done += c.length; if (onProgress) onProgress(done, total); });
    rs.on('error', reject);
    rs.on('end', () => { const out = {}; algos.forEach((a, i) => { out[a] = hs[i].digest('hex'); }); resolve(out); });
  });
}

/** Which algorithm does a pasted checksum look like? */
function algoForHash(h) {
  const x = String(h || '').trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(x)) return 'md5';
  if (/^[0-9a-f]{40}$/.test(x)) return 'sha1';
  if (/^[0-9a-f]{64}$/.test(x)) return 'sha256';
  if (/^[0-9a-f]{128}$/.test(x)) return 'sha512';
  return null;
}

/** MD5 the server told us about (Content-MD5 or Google's x-goog-hash), as hex. */
function serverMd5(headers) {
  const b64 = headers.get('content-md5') || (/md5=([^,\s]+)/.exec(headers.get('x-goog-hash') || '') || [])[1];
  if (!b64) return null;
  try {
    const hex = Buffer.from(b64, 'base64').toString('hex');
    return hex.length === 32 ? hex : null;
  } catch { return null; }
}

// ---------------- ffmpeg ----------------
let toolsDir = null;
function setToolsDir(dir) { toolsDir = dir; }

function bundledFfmpeg() {
  if (!toolsDir) return null;
  const p = path.join(toolsDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fs.existsSync(p) ? p : null;
}

function ffmpegCandidates() {
  return [bundledFfmpeg(), process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
}

function run(bin, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true, stdio: 'ignore' }); } catch { return resolve(false); }
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

let ffmpegCache = null;
async function findFfmpeg(refresh) {
  if (ffmpegCache && !refresh) return ffmpegCache;
  for (const c of ffmpegCandidates()) {
    if (await run(c, ['-version'])) { ffmpegCache = c; return c; }
  }
  ffmpegCache = null;
  return null;
}

/**
 * Save only the sound of a video. Tries a lossless copy into .m4a first; if the codec doesn't fit
 * (e.g. Opus/Vorbis from WebM) it converts to a high-quality MP3.
 * @returns {Promise<string|null>} new file path, or null when ffmpeg isn't available
 */
async function extractAudio(input, format = 'original') {
  const ff = await findFfmpeg();
  if (!ff) return null;
  const base = input.replace(/\.[^.\\/]+$/, '');
  const uniq = (ext) => { let p = base + ext; let i = 1; while (fs.existsSync(p)) p = `${base} (${i++})${ext}`; return p; };
  if (format !== 'mp3') {
    const out = uniq('.m4a');
    if (await run(ff, ['-y', '-i', input, '-vn', '-c:a', 'copy', out])) return out;
    await fsp.rm(out, { force: true }).catch(() => {});
  }
  const mp3 = uniq('.mp3');
  if (await run(ff, ['-y', '-i', input, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', mp3])) return mp3;
  await fsp.rm(mp3, { force: true }).catch(() => {});
  throw new Error('Could not extract the audio from this file');
}

module.exports = { hashFile, algoForHash, serverMd5, setToolsDir, findFfmpeg, extractAudio, bundledFfmpeg };
