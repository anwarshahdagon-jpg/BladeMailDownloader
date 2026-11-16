'use strict';
/**
 * Download queue: keeps the list of downloads, runs a limited number at once,
 * saves everything to disk so downloads survive restarts, and reports speed / ETA.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SegmentedDownload } = require('./segmented');
const { HlsDownload } = require('./hls');
const { isAbort, categoryOf } = require('./util');
const { Limiter } = require('./limiter');
const post = require('./post');
const { FatalError } = require('./segmented');

const DEFAULT_SETTINGS = {
  downloadDir: null,
  connections: 8,
  maxActive: 3,
  startWithSystem: true,
  startMinimized: true,
  closeToTray: true,
  resumeOnStartup: true,
  catchBrowserDownloads: true,
  notifyOnComplete: true,
  bringToFront: true,
  // speed
  speedLimitMbps: 0, // 0 = no limit
  // files
  sortByType: true,
  preferredQuality: 'ask', // 'ask' | 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
  // schedule
  scheduleEnabled: false,
  scheduleStart: '02:00',
  scheduleStop: '08:00',
  afterAll: 'nothing', // 'nothing' | 'sleep' | 'shutdown'
  // links
  watchClipboard: true,
  // finish
  completePopup: true,
  completeSound: true,
  // recovery
  autoRetry: true,
  autoRetryMax: 5,
  // round 2
  duplicateAction: 'ask', // 'ask' | 'rename' | 'replace' | 'skip'
  audioFormat: 'original', // 'original' (lossless .m4a when possible) | 'mp3'
  autoVerify: true,
  theme: 'dark', // 'dark' | 'light' | 'system'
  miniWindow: 'off',
};

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|weba|wma)$/i;

const RETRY_DELAYS = [15, 30, 60, 120, 300]; // seconds

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function urlKey(u) {
  try { const x = new URL(u); return (x.host + x.pathname).toLowerCase(); } catch { return u; }
}

function looksLikeHls(url) {
  try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return false; }
}

class DownloadManager extends EventEmitter {
  constructor({ dataDir, defaultDownloadDir }) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'downloads.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.history = [];
    this.items = [];
    this.tasks = new Map(); // id -> running task
    this.speed = new Map(); // id -> { bytes, last, rate }
    this.settings = { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir };
    this.saveTimer = null;
    this.tickTimer = null;
    this.limiter = new Limiter();
    this.retryTimers = new Map();
    this.hadActivity = false;
    this.inWindow = false;
  }

  applySpeedLimit() {
    const mbps = Number(this.settings.speedLimitMbps) || 0;
    this.limiter.setRate(mbps > 0 ? (mbps * 1e6) / 8 : 0);
  }

  resolveDir(name, dir) {
    return this.settings.sortByType ? path.join(dir, categoryOf(name)) : dir;
  }

  /** Is "now" inside the scheduled download hours? Handles windows that pass midnight (e.g. 23:00–07:00). */
  scheduleOpen(now = new Date()) {
    if (!this.settings.scheduleEnabled) return false;
    const a = minutesOf(this.settings.scheduleStart);
    const b = minutesOf(this.settings.scheduleStop);
    if (a == null) return false;
    const t = now.getHours() * 60 + now.getMinutes();
    if (b == null || a === b) return t >= a; // no stop time: open from start until midnight
    return a < b ? t >= a && t < b : t >= a || t < b;
  }

  checkSchedule() {
    const open = this.scheduleOpen();
    if (open && !this.inWindow) {
      for (const it of this.items) if (it.state === 'scheduled') { it.state = 'queued'; it.fromSchedule = true; this.emit('update', this.snapshot(it)); }
      this.pump();
    } else if (!open && this.inWindow) {
      for (const it of this.items) {
        if (!it.fromSchedule) continue;
        if (it.state === 'queued') { it.state = 'scheduled'; this.emit('update', this.snapshot(it)); }
        else if (it.state === 'downloading') { this.pause(it.id); it.state = 'scheduled'; this.emit('update', this.snapshot(it)); }
      }
    }
    this.inWindow = open;
  }

  /** Put downloads on the schedule (they start at the scheduled time). */
  schedule(id) {
    const it = this.get(id);
    if (!it || it.state === 'completed') return;
    if (this.tasks.has(id)) { this.pause(id); }
    it.state = this.scheduleOpen() ? 'queued' : 'scheduled';
    it.fromSchedule = true;
    this.saveSoon();
    this.emit('update', this.snapshot(it));
    this.pump();
  }

  setQuality(id, variantUrl) {
    const it = this.get(id);
    if (!it) return;
    it.variantUrl = variantUrl;
    it.needQuality = false;
    const v = (it.variants || []).find((x) => x.url === variantUrl);
    if (v && v.height) it.quality = v.height + 'p';
    it.state = 'paused';
    this.resume(id);
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try { Object.assign(this.settings, JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'))); } catch { /* first run */ }
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.items = []; }
    try { this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8')); } catch { this.history = []; }
    post.setToolsDir(path.join(this.dataDir, 'tools'));
    for (const it of this.items) {
      if (it.state === 'downloading' || it.state === 'connecting') it.state = this.settings.resumeOnStartup ? 'queued' : 'paused';
    }
    this.applySpeedLimit();
    this.tickTimer = setInterval(() => this.tick(), 500);
    this.inWindow = false;
    this.checkSchedule();
    this.scheduleTimer = setInterval(() => this.checkSchedule(), 20000);
    // downloads that were waiting for an automatic retry when the app closed
    for (const it of this.items) if (it.state === 'error' && it.retryAt) this.armRetry(it, Math.max(2, (it.retryAt - Date.now()) / 1000));
    this.pump();
  }

  saveSoon() {
    if (this.saveTimer || this.shuttingDown) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 1000);
  }

  saveNow() {
    for (const [id, task] of this.tasks) {
      const it = this.get(id);
      if (it && task.serializeSegments) it.segments = task.serializeSegments();
    }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.file);
  }

  saveSettings(patch) {
    Object.assign(this.settings, patch || {});
    this.settings.connections = Math.max(1, Math.min(32, Number(this.settings.connections) || 8));
    this.settings.maxActive = Math.max(1, Math.min(10, Number(this.settings.maxActive) || 3));
    this.settings.speedLimitMbps = Math.max(0, Number(this.settings.speedLimitMbps) || 0);
    this.applySpeedLimit();
    this.checkSchedule();
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 1));
    this.pump();
    return this.settings;
  }

  get(id) { return this.items.find((i) => i.id === id); }

  snapshot(it) {
    const sp = this.speed.get(it.id);
    const task = this.tasks.get(it.id);
    const rate = it.state === 'downloading' && sp ? sp.rate : 0;
    const downloaded = task ? task.downloaded : it.downloaded || 0;
    return {
      id: it.id, url: it.url, filename: it.filename || it.filenameHint || it.url, filePath: it.filePath,
      size: it.size, downloaded, state: it.state, error: it.error || null, resumable: it.resumable !== false,
      kind: it.kind, speed: rate, eta: rate > 0 && it.size > 0 ? Math.max(0, (it.size - downloaded) / rate) : null,
      connections: task && task.activeConnections ? task.activeConnections() : 0, added: it.added,
      completedAt: it.completedAt || null, note: it.note || null, quality: it.quality || null,
      needQuality: !!it.needQuality, variants: it.needQuality ? it.variants || [] : undefined,
      retryAt: it.state === 'error' ? it.retryAt || null : null, scheduled: it.state === 'scheduled',
      audioOnly: !!it.audioOnly, dup: it.state === 'duplicate' ? it.dup : undefined, verified: it.verified,
      postStep: it.postStep || null,
    };
  }

  list() { return this.items.map((i) => this.snapshot(i)); }

  takenPaths() {
    const s = new Set();
    for (const i of this.items) if (i.filePath && i.state !== 'completed') s.add(i.filePath.toLowerCase());
    return s;
  }

  /**
   * @param {object} req { url, referer, cookies, userAgent, filename, kind:'auto'|'file'|'hls', dir, start }
   */
  add(req) {
    if (!req || !/^https?:\/\//i.test(req.url || '')) throw new Error('Only http(s) links can be downloaded');
    const headers = {};
    if (req.referer) headers.Referer = req.referer;
    if (req.cookies) headers.Cookie = req.cookies;
    if (req.userAgent) headers['User-Agent'] = req.userAgent;
    if (req.origin) headers.Origin = req.origin;
    let kind = req.kind && req.kind !== 'auto' ? req.kind : looksLikeHls(req.url) ? 'hls' : 'file';

    // Link refresh: the same file was added again (e.g. the old link expired). Reuse the unfinished
    // download with the new link instead of starting from zero.
    if (kind === 'file') {
      const key = urlKey(req.url);
      const old = this.items.find((x) => x.kind === 'file' && x.state !== 'completed' && !this.tasks.has(x.id) &&
        (x.state === 'paused' || x.state === 'error' || x.state === 'queued' || x.state === 'scheduled') &&
        (urlKey(x.url) === key || (req.filename && x.filename && req.filename.toLowerCase() === x.filename.toLowerCase())));
      if (old) {
        old.url = req.url;
        old.finalUrl = null;
        old.headers = headers;
        old.autoRetries = 0;
        old.refreshed = true;
        this.clearRetry(old.id);
        old.state = 'queued';
        old.error = null;
        this.saveSoon();
        this.emit('update', this.snapshot(old));
        this.pump();
        return { ...this.snapshot(old), refreshed: true };
      }
    }

    // Duplicate check: is this file already downloaded?
    const dup = this.findDuplicate(req, kind);
    let dupAction = req.duplicateAction || this.settings.duplicateAction || 'ask';
    if (dup && dupAction === 'skip') {
      this.emit('skipped', dup);
      return { skipped: true, id: null, filename: dup.name, duplicateOf: dup };
    }
    if (dup && dupAction === 'replace') this.replaceExisting(dup);

    const it = {
      audioOnly: !!req.audioOnly,
      id: crypto.randomUUID(), url: req.url, headers, kind, dir: req.dir || this.settings.downloadDir,
      filenameHint: req.filename || null, filename: null, filePath: null, size: -1, downloaded: 0,
      resumable: true, segments: [], added: Date.now(),
      state: req.start === false ? 'paused' : req.schedule ? (this.scheduleOpen() ? 'queued' : 'scheduled') : 'queued',
      fromSchedule: !!req.schedule,
    };
    if (dup && dupAction === 'ask') {
      it.dup = dup;
      it.pendingState = it.state;
      it.state = 'duplicate';
    }
    this.items.unshift(it);
    if (it.state === 'duplicate') this.emit('duplicate', this.snapshot(it));
    this.saveSoon();
    this.emit('added', this.snapshot(it));
    this.pump();
    return this.snapshot(it);
  }

  /** Look for an already-downloaded copy of what is being added. */
  findDuplicate(req, kind) {
    const hint = (req.filename || '').toLowerCase();
    const done = this.items.filter((x) => x.state === 'completed' && x.filePath && fs.existsSync(x.filePath) && !!x.audioOnly === !!req.audioOnly);
    // 1) same file name (what you'd see in the folder)
    if (hint) {
      const byName = done.find((x) => x.filename && x.filename.toLowerCase() === hint);
      if (byName) return { name: byName.filename, path: byName.filePath, itemId: byName.id };
      if (!req.audioOnly) {
        const dir = req.dir || this.settings.downloadDir;
        const p = path.join(this.resolveDir(req.filename, dir), require('./util').sanitizeFilename(req.filename));
        if (fs.existsSync(p)) return { name: path.basename(p), path: p, itemId: null };
      }
    }
    // 2) exactly the same link
    if (kind === 'file') {
      const byUrl = done.find((x) => x.url === req.url);
      if (byUrl) return { name: byUrl.filename, path: byUrl.filePath, itemId: byUrl.id };
    }
    return null;
  }

  replaceExisting(dup) {
    try { fs.rmSync(dup.path, { force: true }); } catch { /* in use? then the new file gets a new name */ }
    if (dup.itemId) { this.items = this.items.filter((x) => x.id !== dup.itemId); this.emit('removed', dup.itemId); }
  }

  /** Answer to the "already downloaded" question: 'skip' | 'rename' | 'replace'. */
  resolveDuplicate(id, action) {
    const it = this.get(id);
    if (!it || it.state !== 'duplicate') return;
    if (action === 'skip') { this.items = this.items.filter((x) => x.id !== id); this.saveSoon(); this.emit('removed', id); return; }
    if (action === 'replace' && it.dup) this.replaceExisting(it.dup);
    it.state = it.pendingState || 'queued';
    delete it.dup; delete it.pendingState;
    this.saveSoon();
    this.emit('update', this.snapshot(it));
    this.pump();
  }

  getHistory() { return this.history; }

  clearHistory() {
    this.history = [];
    fs.writeFileSync(this.historyFile, '[]');
  }

  recordHistory(it) {
    const took = it.startedAt ? Math.max(1, (Date.now() - it.startedAt) / 1000) : null;
    this.history.unshift({
      name: it.filename, url: it.url, size: it.size, path: it.filePath, at: Date.now(),
      seconds: took, avgSpeed: took && it.size > 0 ? it.size / took : null, type: require('./util').categoryOf(it.filename),
    });
    if (this.history.length > 5000) this.history.length = 5000;
    try { fs.writeFileSync(this.historyFile, JSON.stringify(this.history)); } catch { /* ignore */ }
  }

  /** Steps after the bytes are on disk: audio extraction and checksum check. */
  async finishItem(it) {
    if (it.audioOnly && !it.audioDone && !AUDIO_EXT.test(it.filePath || '')) {
      it.postStep = 'Extracting audio…';
      this.emit('update', this.snapshot(it));
      try {
        const out = await post.extractAudio(it.filePath, this.settings.audioFormat);
        if (out) {
          await fsp.rm(it.filePath, { force: true }).catch(() => {});
          it.filePath = out;
          it.filename = path.basename(out);
          it.size = fs.statSync(out).size;
          if (this.settings.sortByType && path.basename(path.dirname(out)) === 'Video') {
            // move to Music
            const dest = path.join(path.dirname(path.dirname(out)), 'Music');
            fs.mkdirSync(dest, { recursive: true });
            const target = require('./util').uniquePath(dest, it.filename);
            fs.renameSync(out, target);
            it.filePath = target; it.filename = path.basename(target);
          }
          it.audioDone = true;
        } else {
          it.note = 'Audio only needs the free ffmpeg add-on (Settings → Files → Get ffmpeg). The full video was saved instead.';
        }
      } catch (e) {
        it.note = e.message + '. The full video was kept.';
      }
    }
    if (it.expectedMd5 && this.settings.autoVerify && !it.audioOnly) {
      it.postStep = 'Checking file…';
      this.emit('update', this.snapshot(it));
      try {
        const h = await post.hashFile(it.filePath, ['md5']);
        it.verified = h.md5 === it.expectedMd5;
        if (!it.verified) it.note = 'Warning: the file does not match the checksum the server sent. It may be corrupted — try downloading it again.';
      } catch { /* ignore */ }
    }
    it.postStep = null;
  }

  pump() {
    if (this.shuttingDown) return;
    let running = [...this.tasks.keys()].length;
    // oldest queued first
    const queued = this.items.filter((i) => i.state === 'queued').reverse();
    for (const it of queued) {
      if (running >= this.settings.maxActive) break;
      this.run(it);
      running++;
    }
    const justCompleted = this.justCompleted;
    this.justCompleted = false;
    if (running > 0) this.hadActivity = true;
    else if (this.hadActivity && !this.items.some((i) => i.state === 'queued')) {
      // nothing left to download (waiting retries count as still busy)
      const waitingForSchedule = this.settings.scheduleEnabled && this.items.some((i) => i.state === 'scheduled');
      // only when the last thing that happened was a download finishing (not the user pausing everything)
      if (!this.retryTimers.size && !waitingForSchedule && justCompleted) { this.hadActivity = false; this.emit('allDone'); }
    }
  }

  run(it) {
    it.state = 'downloading';
    if (!it.startedAt) it.startedAt = Date.now();
    it.error = null;
    const opts = {
      connections: this.settings.connections, takenPaths: this.takenPaths(), limiter: this.limiter,
      resolveDir: (name, dir) => this.resolveDir(name, dir), preferredQuality: this.settings.preferredQuality,
    };
    const task = it.kind === 'hls' ? new HlsDownload(it, opts) : new SegmentedDownload(it, opts);
    this.tasks.set(it.id, task);
    this.speed.set(it.id, { bytes: 0, last: Date.now(), rate: 0, samples: [] });
    task.on('data', (n) => { this.speed.get(it.id).bytes += n; });
    task.on('meta', () => { this.saveSoon(); this.emit('update', this.snapshot(it)); });
    this.emit('update', this.snapshot(it));

    task.start().then(
      async (result) => {
        this.tasks.delete(it.id);
        if (this.shuttingDown) return;
        if (result === 'completed') {
          // A file that was really an HLS playlist (no .m3u8 in its name): switch to the stream downloader.
          if (it.kind === 'file' && /mpegurl/i.test(it.contentType || '') && it.size < 5e6 && !it.retriedAsHls) {
            await fsp.rm(it.filePath, { force: true }).catch(() => {});
            Object.assign(it, { kind: 'hls', retriedAsHls: true, filePath: null, filename: null, size: -1, downloaded: 0, segments: [], state: 'queued' });
            this.saveSoon();
            this.pump();
            return;
          }
          this.tasks.set(it.id, { stop() {}, downloaded: it.size, activeConnections: () => 0 }); // busy while post-processing
          await this.finishItem(it);
          this.tasks.delete(it.id);
          if (this.shuttingDown) return;
          it.state = 'completed';
          it.autoRetries = 0;
          it.retryAt = null;
          it.completedAt = Date.now();
          it.downloaded = it.size;
          this.recordHistory(it);
          this.emit('completed', this.snapshot(it));
          this.justCompleted = true;
        } else if (it.state === 'removing') {
          return;
        } else if (!this.shuttingDown && it.state !== 'scheduled') {
          it.state = 'paused';
        }
        this.saveSoon();
        this.emit('update', this.snapshot(it));
        this.pump();
      },
      (err) => {
        this.tasks.delete(it.id);
        if (it.state === 'removing' || this.shuttingDown) return;
        if (isAbort(err) && (it.state === 'paused' || it.state === 'scheduled')) { this.saveSoon(); this.emit('update', this.snapshot(it)); this.pump(); return; }
        if (err && err.needQuality) {
          it.state = 'paused';
          it.needQuality = true;
          this.saveSoon();
          this.emit('update', this.snapshot(it));
          this.emit('needQuality', this.snapshot(it));
          this.pump();
          return;
        }
        it.state = 'error';
        it.error = (err && (err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message)) || String(err);
        // automatic retry for connection problems (not for "access denied / link expired" type errors)
        const permanent = err instanceof FatalError;
        it.autoRetries = it.autoRetries || 0;
        if (this.settings.autoRetry && !permanent && it.autoRetries < (this.settings.autoRetryMax || 5)) {
          const delay = RETRY_DELAYS[Math.min(it.autoRetries, RETRY_DELAYS.length - 1)];
          it.autoRetries++;
          this.armRetry(it, delay);
        } else if (permanent && /expired|denied|403|410/i.test(it.error)) {
          it.error += ' Download it again from the browser and BladeMail will continue this file with the new link.';
        }
        this.saveSoon();
        this.emit('update', this.snapshot(it));
        this.pump();
      },
    );
  }

  armRetry(it, seconds) {
    this.clearRetry(it.id);
    it.retryAt = Date.now() + seconds * 1000;
    this.retryTimers.set(it.id, setTimeout(() => {
      this.retryTimers.delete(it.id);
      it.retryAt = null;
      if (it.state === 'error') { it.state = 'queued'; it.error = null; this.emit('update', this.snapshot(it)); this.pump(); }
    }, seconds * 1000));
  }

  clearRetry(id) {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
    const it = this.get(id);
    if (it) it.retryAt = null;
  }

  pause(id) {
    const it = this.get(id);
    if (!it) return;
    this.clearRetry(id);
    if (it.state === 'error' || it.state === 'scheduled') { it.state = 'paused'; this.emit('update', this.snapshot(it)); }
    const task = this.tasks.get(id);
    if (it.state === 'queued') it.state = 'paused';
    if (task) { it.state = 'paused'; task.stop(); }
    this.saveSoon();
    this.emit('update', this.snapshot(it));
  }

  resume(id) {
    const it = this.get(id);
    if (!it || this.tasks.has(id)) return;
    if (it.needQuality) { this.emit('needQuality', this.snapshot(it)); return; }
    if (it.state === 'paused' || it.state === 'error' || it.state === 'scheduled') {
      this.clearRetry(id);
      if (it.state !== 'scheduled') it.autoRetries = 0;
      it.state = 'queued';
      it.error = null;
      this.emit('update', this.snapshot(it));
      this.pump();
    }
  }

  restart(id) {
    const it = this.get(id);
    if (!it || this.tasks.has(id)) return;
    if (it.filePath) {
      fs.rmSync(it.filePath + '.fgpart', { force: true });
      fs.rmSync(it.filePath + '.fgparts', { recursive: true, force: true });
    }
    Object.assign(it, { segments: [], downloaded: 0, size: -1, filePath: null, filename: null, state: 'queued', error: null });
    this.emit('update', this.snapshot(it));
    this.pump();
  }

  /** Give a paused/failed download a fresh link (e.g. the old one expired). */
  updateUrl(id, url) {
    const it = this.get(id);
    if (!it || !/^https?:\/\//i.test(url)) return;
    it.url = url;
    it.finalUrl = null;
    this.saveSoon();
    this.emit('update', this.snapshot(it));
  }

  pauseAll() { for (const it of this.items) if (it.state === 'downloading' || it.state === 'queued' || (it.state === 'error' && it.retryAt)) this.pause(it.id); }

  resumeAll() { for (const it of this.items) if (it.state === 'paused' || it.state === 'error') this.resume(it.id); }

  async remove(id, deleteFile) {
    const it = this.get(id);
    if (!it) return;
    const task = this.tasks.get(id);
    const wasComplete = it.state === 'completed';
    this.clearRetry(id);
    it.state = 'removing';
    if (task) task.stop();
    this.items = this.items.filter((x) => x.id !== id);
    this.saveSoon();
    this.emit('removed', id);
    if (it.filePath) {
      // give the task a moment to close its file
      await new Promise((r) => setTimeout(r, 300));
      await fsp.rm(it.filePath + '.fgpart', { force: true }).catch(() => {});
      await fsp.rm(it.filePath + '.fgparts', { recursive: true, force: true }).catch(() => {});
      if (deleteFile && wasComplete) await fsp.rm(it.filePath, { force: true }).catch(() => {});
    }
    this.pump();
  }

  clearCompleted() {
    this.items = this.items.filter((i) => i.state !== 'completed');
    this.saveSoon();
    this.emit('list');
  }

  tick() {
    const now = Date.now();
    let total = 0;
    const updates = [];
    for (const [id] of this.tasks) {
      const sp = this.speed.get(id);
      const it = this.get(id);
      if (!sp || !it) continue;
      const dt = (now - sp.last) / 1000;
      const inst = dt > 0 ? sp.bytes / dt : 0;
      sp.samples.push(inst);
      if (sp.samples.length > 6) sp.samples.shift(); // ~3 s moving average
      sp.rate = sp.samples.reduce((a, b) => a + b, 0) / sp.samples.length;
      sp.bytes = 0;
      sp.last = now;
      total += sp.rate;
      updates.push(this.snapshot(it));
    }
    if (this.tasks.size) this.saveSoon();
    this.emit('tick', { updates, totalSpeed: total, active: this.tasks.size });
  }

  async shutdown() {
    clearInterval(this.tickTimer);
    clearInterval(this.scheduleTimer);
    for (const t of this.retryTimers.values()) clearTimeout(t);
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.shuttingDown = true;
    const tasks = [...this.tasks.values()];
    for (const t of tasks) t.stop();
    // remember they were running so they resume on next start
    for (const [id] of this.tasks) { const it = this.get(id); if (it) it.state = 'queued'; }
    await new Promise((r) => setTimeout(r, 400));
    this.saveNow();
  }
}

module.exports = { DownloadManager, DEFAULT_SETTINGS };
