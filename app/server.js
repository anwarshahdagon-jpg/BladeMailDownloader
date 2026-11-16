'use strict';
/**
 * Tiny local API the Chrome extension talks to. Listens on 127.0.0.1 only.
 * Requests must carry the X-FluxGet header; web pages cannot send that header to us
 * (it would need a CORS preflight, which we refuse), so random websites can't add downloads.
 */
const http = require('http');

const PORT = 47815;

function startServer({ manager, version, onAdded }) {
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const fromExtension = !origin || /^(chrome|moz|edge)-extension:\/\//.test(origin);
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS' || !fromExtension || req.headers['x-fluxget'] !== '1') {
      return json(403, { ok: false, error: 'forbidden' });
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/ping') {
      return json(200, { ok: true, app: 'BladeMail', version, catchDownloads: manager.settings.catchBrowserDownloads });
    }
    if (req.method === 'POST' && u.pathname === '/add') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.intercept && !manager.settings.catchBrowserDownloads) {
            return json(200, { ok: false, error: 'Taking over browser downloads is turned off in BladeMail settings' });
          }
          const list = Array.isArray(data.items) ? data.items : [data];
          const added = [];
          let skipped = 0;
          for (const d of list) {
            try {
              const r = manager.add({
                url: d.url, referer: d.referer, cookies: d.cookies, userAgent: d.userAgent,
                filename: d.filename, kind: d.kind || 'auto', origin: d.origin, audioOnly: !!d.audioOnly,
              });
              if (r.skipped) skipped++; else added.push(r);
            } catch { /* skip bad entry */ }
          }
          if (!added.length && !skipped) return json(400, { ok: false, error: 'Nothing could be added' });
          if (onAdded && added.length) onAdded(added, data);
          json(200, { ok: true, items: added.map((a) => a.id), skipped });
        } catch (e) {
          json(400, { ok: false, error: e.message });
        }
      });
      return;
    }
    json(404, { ok: false, error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

module.exports = { startServer, PORT };
