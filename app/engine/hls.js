'use strict';
/**
 * Downloader for ordinary (unencrypted, non-live) HLS streams (.m3u8).
 * Segments are fetched in parallel into a temporary folder, then joined in order.
 * Encrypted streams (any EXT-X-KEY other than NONE) and live streams are refused on purpose.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { DEFAULT_UA, sanitizeFilename, uniquePath, sleep, isAbort } = require('./util');
const { FatalError, httpMessage } = require('./segmented');
const net = require('./net');

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const a = attrs(lines[i]);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (j < lines.length) {
        const res = /(\d+)x(\d+)/.exec(a.RESOLUTION || '');
        variants.push({
          url: new URL(lines[j].trim(), base).href,
          bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
          height: res ? Number(res[2]) : 0,
          audioGroup: a.AUDIO || null,
        });
      }
    }
  }
  const audio = {};
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l)) {
      const a = attrs(l);
      if (a.URI && a['GROUP-ID']) {
        const g = (audio[a['GROUP-ID']] = audio[a['GROUP-ID']] || []);
        g.push({ url: new URL(a.URI, base).href, isDefault: a.DEFAULT === 'YES' });
      }
    }
  }
  return { variants, audio };
}

function parseMedia(text, base) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let init = null;
  let byterange = null;
  let lastEnd = 0;
  let duration = 0;
  let segDur = 0;
  const ended = lines.some((l) => l.startsWith('#EXT-X-ENDLIST'));
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#EXT-X-KEY') || l.startsWith('#EXT-X-SESSION-KEY')) {
      const a = attrs(l);
      if (a.METHOD && a.METHOD !== 'NONE') {
        throw new FatalError('This stream is encrypted/DRM-protected. BladeMail does not download protected streams.');
      }
    } else if (l.startsWith('#EXT-X-MAP')) {
      const a = attrs(l);
      init = { url: new URL(a.URI, base).href, range: parseRange(a.BYTERANGE, 0) };
    } else if (l.startsWith('#EXTINF')) {
      segDur = parseFloat(l.slice(8)) || 0;
    } else if (l.startsWith('#EXT-X-BYTERANGE')) {
      byterange = l.slice(17);
    } else if (!l.startsWith('#')) {
      let range = null;
      if (byterange) { range = parseRange(byterange, lastEnd); lastEnd = range.end + 1; byterange = null; }
      segments.push({ url: new URL(l, base).href, range });
      duration += segDur;
      segDur = 0;
    }
  }
  return { segments, init, ended, duration };
}

function parseRange(spec, defaultStart) {
  if (!spec) return null;
  const [len, off] = spec.split('@').map(Number);
  const start = Number.isFinite(off) ? off : defaultStart;
  return { start, end: start + len - 1 };
}

function findFfmpeg() {
  const candidates = [require('./post').bundledFfmpeg(), process.env.FFMPEG_PATH, 'ffmpeg'];
  return candidates.filter(Boolean);
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    let done = false;
    const tryNext = (list) => {
      if (!list.length) return resolve(false);
      const p = spawn(list[0], args, { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => tryNext(list.slice(1)));
      p.on('exit', (code) => { if (!done) { done = true; resolve(code === 0); } });
    };
    tryNext(findFfmpeg());
  });
}

class HlsDownload extends EventEmitter {
  constructor(item, opts = {}) {
    super();
    this.item = item;
    this.connections = Math.max(1, Math.min(32, opts.connections || 8));
    this.takenPaths = opts.takenPaths || new Set();
    this.limiter = opts.limiter || null;
    this.resolveDir = opts.resolveDir || ((name, dir) => dir);
    this.preferredQuality = opts.preferredQuality || 'best';
    this.stopped = false;
    this.controllers = new Set();
    this.bytes = 0;
  }

  headers(extra = {}) {
    const h = { 'User-Agent': DEFAULT_UA, Accept: '*/*' };
    for (const [k, v] of Object.entries(this.item.headers || {})) if (v) h[k] = v;
    return Object.assign(h, extra);
  }

  stop() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
  }

  activeConnections() { return this.active || 0; }

  get downloaded() { return this.item.downloaded || 0; }

  async fetchOnce(url, range) {
    const ac = new AbortController();
    this.controllers.add(ac);
    const timer = setTimeout(() => ac.abort(new Error('stalled')), 45000);
    try {
      const res = await net.get(url, this.headers(range ? { Range: `bytes=${range.start}-${range.end}` } : {}), ac.signal);
      if (!res.ok) {
        res.body.resume();
        const err = res.status >= 400 && res.status < 500 && res.status !== 429 ? FatalError : Error;
        throw new err(httpMessage(res.status));
      }
      const buf = await res.buffer();
      return { buf, res };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ac);
    }
  }

  async fetchRetry(url, range) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.fetchOnce(url, range);
      } catch (e) {
        if (this.stopped || e instanceof FatalError || attempt >= 6) throw e;
        await sleep(Math.min(10000, 400 * 2 ** attempt));
      }
    }
  }

  async resolvePlaylist() {
    const it = this.item;
    const { buf, res } = await this.fetchRetry(it.url);
    let text = buf.toString('utf8');
    if (!text.trimStart().startsWith('#EXTM3U')) throw new FatalError('This address is not an HLS playlist.');
    let base = res.url;
    if (/#EXT-X-STREAM-INF/.test(text)) {
      const { variants, audio } = parseMaster(text, base);
      if (!variants.length) throw new FatalError('No playable variants in this stream.');
      // highest resolution first, then highest bitrate; one entry per resolution
      variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
      const seen = new Set();
      const choices = variants.filter((v) => { const k = v.height || v.bandwidth; if (seen.has(k)) return false; seen.add(k); return true; });
      it.variants = choices.map((v) => ({ url: v.url, height: v.height, bandwidth: v.bandwidth }));
      let best = it.variantUrl && choices.find((v) => v.url === it.variantUrl);
      if (!best && it.audioOnly) best = choices[0]; // audio only: no need to ask about picture quality
      if (!best) {
        const pref = this.preferredQuality;
        if (pref === 'ask' && choices.length > 1) {
          const e = new Error('Choose a video quality');
          e.needQuality = true;
          throw e;
        }
        const h = Number(pref);
        best = h ? (choices.find((v) => v.height && v.height <= h) || choices[choices.length - 1]) : choices[0];
      }
      it.quality = best.height ? `${best.height}p` : null;
      const audioList = best.audioGroup && audio[best.audioGroup];
      if (audioList && audioList.length) {
        it.audioUrl = (audioList.find((a) => a.isDefault) || audioList[0]).url;
      }
      const r2 = await this.fetchRetry(best.url);
      text = r2.buf.toString('utf8');
      base = r2.res.url;
    }
    if (it.audioOnly && it.audioUrl) {
      // the stream has a separate audio track: fetch only that, skip the video completely
      const r3 = await this.fetchRetry(it.audioUrl);
      const audioMedia = parseMedia(r3.buf.toString('utf8'), r3.res.url);
      if (!audioMedia.ended) throw new FatalError('This is a live stream. BladeMail only saves finished (on-demand) videos.');
      return { media: audioMedia, audioMedia: null, audioOnlyTrack: true };
    }
    const media = parseMedia(text, base);
    if (!media.ended) throw new FatalError('This is a live stream. BladeMail only saves finished (on-demand) videos.');
    if (!media.segments.length) throw new FatalError('The stream has no segments.');
    let audioMedia = null;
    if (it.audioUrl) {
      const r3 = await this.fetchRetry(it.audioUrl);
      audioMedia = parseMedia(r3.buf.toString('utf8'), r3.res.url);
    }
    return { media, audioMedia };
  }

  async start() {
    const it = this.item;
    this.stopped = false;
    const { media, audioMedia, audioOnlyTrack } = await this.resolvePlaylist();
    let ext = media.init || /\.(mp4|m4s)(\?|$)/i.test(media.segments[0].url) ? '.mp4' : '.ts';
    if (audioOnlyTrack) { ext = media.init || /\.(mp4|m4s|m4a)(\?|$)/i.test(media.segments[0].url) ? '.m4a' : '.aac'; it.audioDone = true; }
    if (!it.filePath) {
      const stem = sanitizeFilename(it.filenameHint ? it.filenameHint.replace(/\.(m3u8|ts|mp4)$/i, '') : 'video');
      const dir = this.resolveDir(stem + ext, it.dir);
      await fsp.mkdir(dir, { recursive: true });
      it.filePath = uniquePath(dir, stem + ext, this.takenPaths);
      it.filename = path.basename(it.filePath);
      this.emit('meta');
    }
    const tmp = it.filePath + '.fgparts';
    await fsp.mkdir(tmp, { recursive: true });

    const jobs = [];
    if (media.init) jobs.push({ key: 'v-init', ...media.init });
    media.segments.forEach((s, i) => jobs.push({ key: `v-${String(i).padStart(6, '0')}`, ...s }));
    if (audioMedia) {
      if (audioMedia.init) jobs.push({ key: 'a-init', ...audioMedia.init });
      audioMedia.segments.forEach((s, i) => jobs.push({ key: `a-${String(i).padStart(6, '0')}`, ...s }));
    }
    const existing = new Set(await fsp.readdir(tmp));
    let done = 0;
    let bytes = 0;
    const pending = [];
    for (const j of jobs) {
      if (existing.has(j.key + '.seg')) {
        done++;
        bytes += (await fsp.stat(path.join(tmp, j.key + '.seg'))).size;
      } else pending.push(j);
    }
    it.downloaded = bytes;
    it.segCount = jobs.length;
    it.segDone = done;
    const estimate = () => (done ? Math.round((bytes / done) * jobs.length) : -1);
    it.size = estimate();
    this.emit('meta');

    let fatal = null;
    let idx = 0;
    this.active = 0;
    const worker = async () => {
      while (!this.stopped && !fatal && idx < pending.length) {
        const j = pending[idx++];
        this.active++;
        try {
          const { buf } = await this.fetchRetry(j.url, j.range);
          if (this.limiter) await this.limiter.take(buf.length, () => this.stopped);
          const file = path.join(tmp, j.key);
          await fsp.writeFile(file + '.tmp', buf);
          await fsp.rename(file + '.tmp', file + '.seg');
          done++;
          bytes += buf.length;
          it.downloaded = bytes;
          it.segDone = done;
          it.size = done === jobs.length ? bytes : estimate();
          this.emit('data', buf.length);
        } catch (e) {
          if (!this.stopped && !isAbort(e)) { fatal = e; this.stop(); }
        } finally {
          this.active--;
        }
      }
    };
    await Promise.all(Array.from({ length: this.connections }, worker));
    if (fatal) throw fatal;
    if (this.stopped) return 'paused';

    // join segments in order
    const files = (await fsp.readdir(tmp)).filter((f) => f.endsWith('.seg')).sort();
    const vFiles = files.filter((f) => f.startsWith('v-')).sort((a, b) => (a === 'v-init.seg' ? -1 : b === 'v-init.seg' ? 1 : a.localeCompare(b)));
    const aFiles = files.filter((f) => f.startsWith('a-')).sort((a, b) => (a === 'a-init.seg' ? -1 : b === 'a-init.seg' ? 1 : a.localeCompare(b)));
    const vOut = audioMedia ? path.join(tmp, 'video' + ext) : it.filePath + '.fgjoin';
    await concat(tmp, vFiles, vOut);
    if (audioMedia) {
      const aExt = audioMedia.init ? '.m4a' : '.aac';
      const aOut = path.join(tmp, 'audio' + aExt);
      await concat(tmp, aFiles, aOut);
      const finalMp4 = it.filePath.replace(/\.(ts|mp4)$/i, '.mp4');
      const ok = await runFfmpeg(['-y', '-i', vOut, '-i', aOut, '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', finalMp4]);
      if (!ok) {
        // no ffmpeg: keep both tracks side by side
        const base = it.filePath.replace(/\.(ts|mp4)$/i, '');
        await fsp.rename(vOut, base + ' (video)' + ext);
        await fsp.rename(aOut, base + ' (audio)' + aExt);
        it.filePath = base + ' (video)' + ext;
        it.note = 'Video and audio were saved as two files (install ffmpeg to have them merged automatically).';
      } else {
        it.filePath = finalMp4;
      }
    } else {
      await fsp.rename(vOut, it.filePath);
      if (ext === '.ts' && !it.audioOnly) {
        // optional: turn .ts into .mp4 if ffmpeg is installed
        const mp4 = uniquePath(path.dirname(it.filePath), path.basename(it.filePath, '.ts') + '.mp4', this.takenPaths);
        if (await runFfmpeg(['-y', '-i', it.filePath, '-c', 'copy', mp4])) {
          await fsp.rm(it.filePath, { force: true });
          it.filePath = mp4;
        } else {
          await fsp.rm(mp4, { force: true }).catch(() => {});
        }
      }
    }
    await fsp.rm(tmp, { recursive: true, force: true });
    it.filename = path.basename(it.filePath);
    it.size = (await fsp.stat(it.filePath)).size;
    it.downloaded = it.size;
    return 'completed';
  }
}

async function concat(dir, files, out) {
  const ws = fs.createWriteStream(out);
  for (const f of files) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(path.join(dir, f));
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(ws, { end: false });
    });
  }
  await new Promise((resolve, reject) => { ws.on('error', reject); ws.end(resolve); });
}

module.exports = { HlsDownload, parseMaster, parseMedia };
