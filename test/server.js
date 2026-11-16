'use strict';
// Test server: serves a random file with Range support, throttled per connection,
// a no-range endpoint, a flaky endpoint, and an HLS stream.
const http = require('http');
const crypto = require('crypto');

const SIZE = 40 * 1024 * 1024;
const DATA = crypto.randomBytes(SIZE);
const PER_CONN = Number(process.env.PER_CONN || 4 * 1024 * 1024); // bytes/s per connection
const SEGS = Array.from({ length: 12 }, (_, i) => crypto.randomBytes(200000 + i * 1000));
let conns = 0; let maxConns = 0;

function send(res, buf, start, end, status, extra = {}) {
  res.writeHead(status, { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', ...extra });
  conns++; maxConns = Math.max(maxConns, conns);
  let pos = start;
  const tickMs = 50; const per = Math.ceil(PER_CONN * tickMs / 1000);
  const t = setInterval(() => {
    if (pos > end) { clearInterval(t); res.end(); return; }
    const n = Math.min(per, end - pos + 1);
    res.write(buf.subarray(pos, pos + n)); pos += n;
  }, tickMs);
  res.on('close', () => { clearInterval(t); conns--; });
}

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/stats') { res.end(JSON.stringify({ maxConns, conns })); maxConns = 0; return; }
  if (u.pathname === '/redirect') { res.writeHead(302, { Location: '/file.bin' }); return res.end(); }
  if (u.pathname === '/file.bin' || u.pathname === '/flaky.bin' || u.pathname === '/norange.bin') {
    const range = req.headers.range;
    if (u.pathname === '/flaky.bin' && Math.random() < 0.3) { req.socket.destroy(); return; }
    if (range && u.pathname !== '/norange.bin') {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const s = Number(m[1]); const e = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
      const extra = { 'Content-Range': `bytes ${s}-${e}/${SIZE}`, 'Accept-Ranges': 'bytes', ETag: '"abc"',
        'Content-Disposition': 'attachment; filename="test file.bin"' };
      if (u.pathname === '/flaky.bin') {
        // cut off part way
        res.writeHead(206, { 'Content-Length': e - s + 1, ...extra });
        const cut = s + Math.min(e - s + 1, 1024 * 1024 * (1 + Math.random() * 3) | 0);
        res.write(DATA.subarray(s, Math.min(cut, e + 1)));
        if (cut > e) res.end(); else setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      return send(res, DATA, s, e, 206, extra);
    }
    return send(res, DATA, 0, SIZE - 1, 200);
  }
  if (u.pathname === '/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nhigh.m3u8\n');
  }
  if (u.pathname === '/high.m3u8' || u.pathname === '/low.m3u8' || u.pathname === '/enc.m3u8' || u.pathname === '/live.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    let t = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
    if (u.pathname === '/enc.m3u8') t += '#EXT-X-KEY:METHOD=AES-128,URI="key"\n';
    SEGS.forEach((_, i) => { t += `#EXTINF:4.0,\nseg/${i}.ts\n`; });
    if (u.pathname !== '/live.m3u8') t += '#EXT-X-ENDLIST\n';
    return res.end(t);
  }
  if (u.pathname.startsWith('/www/')) {
    const f = require('path').join(__dirname, 'www', require('path').basename(u.pathname));
    if (!require('fs').existsSync(f)) { res.writeHead(404); return res.end(); }
    const buf = require('fs').readFileSync(f);
    const type = f.endsWith('.html') ? 'text/html' : 'video/mp4';
    const range = req.headers.range;
    if (range && type === 'video/mp4') {
      const m = /bytes=(\d+)-(\d*)/.exec(range); const s = Number(m[1]); const e = m[2] ? Number(m[2]) : buf.length - 1;
      const md5 = require('crypto').createHash('md5').update(u.searchParams.get('bad') ? 'x' : buf).digest('base64');
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${buf.length}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', 'Content-MD5': md5 });
      return res.end(buf.subarray(s, e + 1));
    }
    const md5 = require('crypto').createHash('md5').update(u.searchParams.get('bad') ? 'x' : buf).digest('base64');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Accept-Ranges': 'bytes', 'Content-MD5': md5 });
    return res.end(buf);
  }
  const sm = /^\/seg\/(\d+)\.ts$/.exec(u.pathname);
  if (sm) { const b = SEGS[Number(sm[1])]; return send(res, b, 0, b.length - 1, 200, { 'Content-Type': 'video/mp2t' }); }
  res.writeHead(404); res.end();
});

module.exports = { srv, DATA, SEGS, SIZE };
if (require.main === module) srv.listen(Number(process.env.PORT || 8099), () => console.log('listening'));
