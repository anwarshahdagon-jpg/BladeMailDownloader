'use strict';
/**
 * Downloads the free ffmpeg tool (used for "audio only" and for turning streams into .mp4)
 * into BladeMail's own data folder. Nothing is installed system-wide.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const net = require('./engine/net');
const post = require('./engine/post');

const SOURCES = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (c) => resolve(c === 0));
  });
}

async function findFile(dir, name) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = await findFile(p, name); if (r) return r; } else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

async function downloadTo(url, file, onProgress) {
  const ac = new AbortController();
  const res = await net.get(url, { 'User-Agent': 'BladeMail' }, ac.signal);
  if (!res.ok) { res.body.resume(); throw new Error(`HTTP ${res.status}`); }
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const ws = fs.createWriteStream(file);
  await new Promise((resolve, reject) => {
    res.body.on('data', (c) => { done += c.length; onProgress(done, total); });
    res.body.on('error', reject);
    res.body.on('aborted', () => reject(new Error('Connection closed')));
    ws.on('error', reject);
    ws.on('finish', resolve);
    res.body.pipe(ws);
  });
  if (total && done < total) throw new Error('Download incomplete');
}

/** @returns {Promise<string>} path to ffmpeg */
async function installFfmpeg(toolsDir, onProgress) {
  await fsp.mkdir(toolsDir, { recursive: true });
  const zip = path.join(toolsDir, 'ffmpeg-download.zip');
  const tmp = path.join(toolsDir, 'ffmpeg-extract');
  let lastErr = null;
  for (const url of SOURCES) {
    try {
      onProgress({ stage: 'download', done: 0, total: 0 });
      await downloadTo(url, zip, (done, total) => onProgress({ stage: 'download', done, total }));
      onProgress({ stage: 'extract' });
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.mkdir(tmp, { recursive: true });
      // Windows 10/11 include tar.exe, which can unpack zip files; PowerShell is the fallback.
      let ok = await run('tar', ['-xf', zip, '-C', tmp]);
      if (!ok) ok = await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`]);
      if (!ok) ok = await run('unzip', ['-q', zip, '-d', tmp]);
      if (!ok) throw new Error('Could not unpack ffmpeg');
      const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      const found = await findFile(tmp, exeName);
      if (!found) throw new Error('ffmpeg was not found in the download');
      const dest = path.join(toolsDir, exeName);
      await fsp.copyFile(found, dest);
      if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);
      await fsp.rm(tmp, { recursive: true, force: true });
      await fsp.rm(zip, { force: true });
      const ff = await post.findFfmpeg(true);
      if (!ff) throw new Error('ffmpeg did not start after installing');
      onProgress({ stage: 'done' });
      return dest;
    } catch (e) {
      lastErr = e;
      await fsp.rm(zip, { force: true }).catch(() => {});
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastErr || new Error('ffmpeg download failed');
}

module.exports = { installFfmpeg };
