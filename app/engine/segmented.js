'use strict';
/**
 * Multi-connection (segmented) HTTP downloader with pause / resume.
 *
 * How it works
 * - The first request asks for "Range: bytes=0-". If the server answers 206 the file is resumable and
 *   that first connection keeps streaming as segment #0.
 * - Extra connections are opened by splitting the segment with the most bytes left in half
 *   (dynamic splitting), so every connection stays busy until the very end of the file.
 * - Every segment remembers how many bytes were actually written to disk, so a paused download
 *   (or one interrupted by a crash / reboot) continues exactly where it stopped.
 */
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DEFAULT_UA, chooseFilename, uniquePath, sleep, isAbort } = require('./util');
const net = require('./net');

const MIN_SPLIT = 256 * 1024; // never create a piece smaller than this
const STALL_MS = 30000; // a connection that sends nothing for this long is restarted
const MAX_RETRIES = 6;

class FatalError extends Error {}

class SegmentedDownload extends EventEmitter {
  /**
   * @param {object} item  persisted download record (mutated in place)
   * @param {object} opts  { connections, takenPaths:Set<string> }
   */
  constructor(item, opts = {}) {
    super();
    this.item = item;
    this.connections = Math.max(1, Math.min(32, opts.connections || 8));
    this.takenPaths = opts.takenPaths || new Set();
    this.limiter = opts.limiter || null;
    this.resolveDir = opts.resolveDir || ((name, dir) => dir);
    this.stopped = false;
    this.controllers = new Set();
    this.fh = null;
    this.segs = [];
    this.fatal = null;
  }

  headers(extra = {}) {
    const h = { 'User-Agent': DEFAULT_UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
    for (const [k, v] of Object.entries(this.item.headers || {})) if (v) h[k] = v;
    return Object.assign(h, extra);
  }

  get downloaded() {
    let d = 0;
    for (const s of this.segs) d += s.committed - s.start;
    return d;
  }

  activeConnections() {
    let n = 0;
    for (const s of this.segs) if (s.active) n++;
    return n;
  }

  /** Persistable copy of the segment table. */
  serializeSegments() {
    return this.segs
      .map((s) => ({ s: s.start, e: s.end === Infinity ? -1 : s.end, p: s.committed }))
      .sort((a, b) => a.s - b.s);
  }

  stop() {
    this.stopped = true;
    for (const c of this.controllers) c.abort();
  }

  async request(url, headers) {
    const ac = new AbortController();
    this.controllers.add(ac);
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ac.abort(new Error('stalled')), STALL_MS);
    };
    arm();
    try {
      const res = await net.get(url, headers, ac.signal);
      return { res, ac, arm, done: () => { clearTimeout(timer); this.controllers.delete(ac); } };
    } catch (e) {
      clearTimeout(timer);
      this.controllers.delete(ac);
      throw e;
    }
  }

  async start() {
    const it = this.item;
    this.stopped = false;
    this.fatal = null;
    let firstRes = null;
    let firstReq = null;

    const canResume = it.resumable && it.size > 0 && Array.isArray(it.segments) && it.segments.length &&
      it.filePath && fs.existsSync(it.filePath + '.fgpart');

    if (canResume) {
      this.segs = it.segments.map((s) => ({
        start: s.s, end: s.e < 0 ? Infinity : s.e, pos: s.p, committed: s.p, active: false,
      }));
      this.fh = await fsp.open(it.filePath + '.fgpart', 'r+');
    } else {
      // fresh start (also used for servers that cannot resume)
      if (it.filePath) await fsp.rm(it.filePath + '.fgpart', { force: true });
      for (let attempt = 1; ; attempt++) {
        try {
          firstReq = await this.request(it.url, this.headers({ Range: 'bytes=0-' }));
          if (firstReq.res.status >= 500 || firstReq.res.status === 429) {
            firstReq.done(); firstReq.ac.abort();
            throw new Error(httpMessage(firstReq.res.status));
          }
          break;
        } catch (e) {
          if (this.stopped) return 'paused';
          if (attempt >= 5) throw new Error((e.cause && e.cause.message) || e.message);
          await sleep(500 * 2 ** attempt);
        }
      }
      firstRes = firstReq.res;
      if (!firstRes.ok) {
        firstReq.done(); firstReq.ac.abort();
        throw new FatalError(httpMessage(firstRes.status));
      }
      const ct = firstRes.headers.get('content-type') || '';
      it.contentType = ct;
      it.finalUrl = firstRes.url;
      let size = -1;
      let resumable = false;
      if (firstRes.status === 206) {
        const cr = /\/(\d+)\s*$/.exec(firstRes.headers.get('content-range') || '');
        if (cr) { size = Number(cr[1]); resumable = true; }
      } else {
        const cl = firstRes.headers.get('content-length');
        if (cl && /^\d+$/.test(cl)) size = Number(cl);
        resumable = false;
      }
      it.size = size;
      it.resumable = resumable && size > 0;
      it.etag = firstRes.headers.get('etag') || null;
      it.expectedMd5 = require('./post').serverMd5(firstRes.headers);
      it.lastModified = firstRes.headers.get('last-modified') || null;
      if (!it.filePath) {
        const name = chooseFilename({
          hint: it.filenameHint, contentDisposition: firstRes.headers.get('content-disposition'),
          url: firstRes.url || it.url, contentType: ct,
        });
        const dir = this.resolveDir(name, it.dir);
        await fsp.mkdir(dir, { recursive: true });
        it.filePath = uniquePath(dir, name, this.takenPaths);
        it.filename = path.basename(it.filePath);
      }
      this.emit('meta');
      this.fh = await fsp.open(it.filePath + '.fgpart', 'w+');
      if (size > 0) await this.fh.truncate(size).catch(() => {}); // pre-allocate
      this.segs = [{ start: 0, end: size > 0 ? size - 1 : Infinity, pos: 0, committed: 0, active: false }];
    }

    const workers = [];
    const s0 = this.claimNext();
    if (s0) workers.push(this.worker(s0, firstReq));
    else if (firstReq) { firstReq.done(); firstReq.ac.abort(); }

    if (it.resumable) {
      // open the other connections a few ms apart (gentler on servers, avoids instant 429s)
      for (let i = 1; i < this.connections && !this.stopped; i++) {
        if (i > 1) await sleep(60);
        const s = this.claimNext();
        if (!s) break;
        workers.push(this.worker(s, null));
      }
    }
    const results = await Promise.allSettled(workers);

    try { await this.fh.close(); } catch { /* ignore */ }
    this.fh = null;
    it.segments = this.serializeSegments();
    it.downloaded = this.downloaded;

    if (this.fatal) throw this.fatal;
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !this.stopped) throw failed.reason;
    if (this.stopped) return 'paused';

    const incomplete = this.segs.some((s) => s.end !== Infinity && s.committed <= s.end);
    if (incomplete) throw new Error('Download ended before all data was received');
    if (it.size < 0) it.size = this.downloaded;

    // finalize
    let finalPath = it.filePath;
    if (fs.existsSync(finalPath)) {
      finalPath = uniquePath(path.dirname(finalPath), path.basename(finalPath), this.takenPaths);
    }
    await fsp.rename(it.filePath + '.fgpart', finalPath);
    it.filePath = finalPath;
    it.filename = path.basename(finalPath);
    it.segments = [];
    return 'completed';
  }

  /** Pick an unfinished idle segment, or split the busiest one so a new connection can help. */
  claimNext() {
    for (const s of this.segs) {
      if (!s.active && s.pos <= s.end) { s.active = true; return s; }
    }
    if (!this.item.resumable || this.stopped) return null;
    let best = null;
    let bestRem = 0;
    for (const s of this.segs) {
      if (!s.active) continue;
      const rem = s.end - s.pos + 1;
      if (rem > bestRem) { best = s; bestRem = rem; }
    }
    if (!best || bestRem < 2 * MIN_SPLIT) return null;
    const mid = best.pos + Math.floor(bestRem / 2);
    const ns = { start: mid, end: best.end, pos: mid, committed: mid, active: true };
    best.end = mid - 1;
    this.segs.push(ns);
    return ns;
  }

  async worker(seg, firstReq) {
    while (seg && !this.stopped && !this.fatal) {
      try {
        await this.runSegment(seg, firstReq);
      } finally {
        seg.active = false;
      }
      firstReq = null;
      if (this.stopped || this.fatal) break;
      seg = this.claimNext();
    }
  }

  async runSegment(seg, firstReq) {
    let attempt = 0;
    while (!this.stopped && seg.pos <= seg.end) {
      let req = firstReq;
      firstReq = null;
      try {
        if (!req) {
          // restart from what is safely on disk
          seg.pos = seg.committed;
          const range = this.item.resumable ? { Range: `bytes=${seg.pos}-${seg.end === Infinity ? '' : seg.end}` } : {};
          if (!this.item.resumable && seg.pos > 0) {
            // server can't resume: start this file over
            seg.pos = seg.committed = 0;
            await this.fh.truncate(0);
          }
          req = await this.request(this.item.finalUrl || this.item.url, this.headers(range));
          const { res } = req;
          if (this.item.resumable) {
            if (res.status === 200) throw new FatalError('The server stopped supporting resume for this file. Restart the download.');
            if (res.status !== 206) {
              const err = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408 ? FatalError : Error;
              throw new err(httpMessage(res.status));
            }
            const cr = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
            if (cr && Number(cr[1]) !== this.item.size) throw new FatalError('The file changed on the server. Restart the download.');
            const et = res.headers.get('etag');
            if (et && this.item.etag && et !== this.item.etag && !et.startsWith('W/')) {
              throw new FatalError('The file changed on the server. Restart the download.');
            }
          } else if (!res.ok) {
            throw new Error(httpMessage(res.status));
          }
        }
        const { res, arm } = req;
        const body = res.body;
        if (!body) throw new Error('Empty response');
        for await (const chunk of body) {
          arm();
          if (this.stopped) break;
          const remaining = seg.end - seg.pos + 1;
          if (remaining <= 0) break;
          const n = Math.min(chunk.byteLength, remaining);
          if (this.limiter && this.limiter.rate > 0) {
            await this.limiter.take(n, () => this.stopped);
            arm();
            if (this.stopped) break;
            if (seg.end - seg.pos + 1 <= 0) break;
          }
          const n2 = Math.min(n, seg.end - seg.pos + 1);
          const at = seg.pos;
          seg.pos += n2; // reserve first so a concurrent split can never overlap these bytes
          await this.fh.write(chunk, 0, n2, at);
          seg.committed = at + n2;
          attempt = 0;
          this.emit('data', n2);
          if (seg.pos > seg.end) break;
        }
        req.done();
        if (!body.complete) req.ac.abort(); // close the socket if we stopped reading early
        if (this.stopped) return;
        if (seg.end === Infinity) { seg.end = seg.committed - 1; return; } // unknown-size stream finished
        if (seg.committed <= seg.end) throw new Error('Connection closed early');
        return;
      } catch (e) {
        if (req) { req.done(); req.ac.abort(); }
        if (this.stopped) return;
        if (e instanceof FatalError) { this.fatal = e; this.stop(); throw e; }
        attempt++;
        if (attempt > MAX_RETRIES) {
          this.fatal = new Error(isAbort(e) ? 'Connection stalled repeatedly' : (e.cause && e.cause.message) || e.message);
          this.stop();
          throw this.fatal;
        }
        await sleep(Math.min(15000, 500 * 2 ** attempt));
      }
    }
  }
}

function httpMessage(status) {
  const map = {
    401: 'Server says login is required (401)', 403: 'Access denied by server (403). The link may have expired — download it again from the browser.',
    404: 'File not found on server (404)', 410: 'Link expired (410)', 416: 'Server rejected the byte range (416)',
    429: 'Server is rate-limiting (429)',
  };
  return map[status] || `Server error (HTTP ${status})`;
}

module.exports = { SegmentedDownload, FatalError, httpMessage };
