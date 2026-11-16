'use strict';
/**
 * Minimal HTTP client on top of Node's http/https modules.
 * (Used instead of the built-in fetch for full control over sockets, aborts and redirects.)
 * Supports keep-alive, redirects, AbortSignal and an optional HTTPS_PROXY / HTTP_PROXY.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean);

class TunnelAgent extends https.Agent {
  constructor(proxyUrl, opts) { super(opts); this.proxy = new URL(proxyUrl); }

  createConnection(options, cb) {
    const p = this.proxy;
    const headers = { Host: `${options.host}:${options.port}` };
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64');
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${options.host}:${options.port}`, headers });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`Proxy refused connection (${res.statusCode})`)); }
      cb(null, tls.connect({ socket, servername: options.servername || options.host, ALPNProtocols: ['http/1.1'] }));
    });
    req.once('error', cb);
    req.end();
  }
}

const AGENT_OPTS = { keepAlive: true, maxSockets: 128, keepAliveMsecs: 15000 };
const agents = { 'http:': new http.Agent(AGENT_OPTS), 'https:': new https.Agent(AGENT_OPTS) };
const proxyAgent = PROXY ? new TunnelAgent(PROXY, AGENT_OPTS) : null;

function bypassProxy(host) {
  return NO_PROXY.some((n) => n === '*' || host === n || host.endsWith(n.startsWith('.') ? n : '.' + n));
}

/**
 * GET a URL. Resolves once response headers arrive.
 * @returns {Promise<{status:number, ok:boolean, url:string, headers:{get(n:string):string|null}, body:import('http').IncomingMessage, buffer():Promise<Buffer>}>}
 */
function get(url, headers = {}, signal, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Invalid link')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('Only http(s) links are supported'));
    const mod = u.protocol === 'https:' ? https : http;
    let agent = agents[u.protocol];
    let target = u;
    const opts = { method: 'GET', headers, signal };
    if (PROXY && !bypassProxy(u.hostname)) {
      if (u.protocol === 'https:') agent = proxyAgent;
      else { const p = new URL(PROXY); target = null; Object.assign(opts, { host: p.hostname, port: p.port || 80, path: u.href, headers: { ...headers, Host: u.host } }); agent = agents['http:']; }
    }
    opts.agent = agent;
    const req = target ? mod.request(target, opts) : http.request(opts);
    req.on('response', (res) => {
      const st = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(st) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, u);
        const h = { ...headers };
        if (next.host !== u.host) { delete h.Cookie; delete h.cookie; delete h.Origin; } // never leak cookies to another site
        return get(next.href, h, signal, redirectsLeft - 1).then(resolve, reject);
      }
      resolve({
        status: st, ok: st >= 200 && st < 300, url: u.href, body: res,
        headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v); } },
        buffer: () => new Promise((ok, bad) => {
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => ok(Buffer.concat(parts)));
          res.on('error', bad);
          res.on('aborted', () => bad(new Error('Connection closed early')));
        }),
      });
    });
    req.on('error', reject);
    req.setNoDelay(true);
    req.end();
  });
}

module.exports = { get };
