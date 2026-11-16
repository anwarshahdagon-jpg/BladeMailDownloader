// Round 2 extension test: ♪ audio-only button, "all links" page with filters, batch send.
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const EXT = path.resolve(__dirname, '../extension');
const SP = process.env.SP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const got = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ping') return res.end(JSON.stringify({ ok: true, app: 'BladeMail', version: 'test', catchDownloads: true }));
    const d = JSON.parse(b || '{}'); got.push(d);
    const n = d.items ? d.items.length : 1;
    res.end(JSON.stringify({ ok: true, items: Array.from({ length: Math.max(0, n - 1) }, (_, i) => 'id' + i), skipped: 1 }));
  });
});
(async () => {
  await new Promise((r) => mock.listen(47815, '127.0.0.1', r));
  const ctx = await chromium.launchPersistentContext(SP + '/chrome-profile2', {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1100, height: 800 },
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/www/links.html');
  await page.evaluate(() => document.getElementById('v').play());
  await sleep(2500);
  // click the ♪ button: it sits after "Download video"; find by position from the right (✕ ~ 28px, ♪ ~ 60px)
  const box = await page.evaluate(() => { const b = document.querySelector('fluxget-button'); if (!b || b.style.display === 'none') return null; const r = b.getBoundingClientRect(); return { x: r.right, y: r.top + 14, w: r.width }; });
  console.log('button box:', JSON.stringify(box));
  await page.screenshot({ path: SP + '/ext-audio.png', clip: { x: 0, y: 0, width: 700, height: 700 } });
  if (box) { await page.mouse.click(box.x - 45, box.y); await sleep(1500); }
  console.log('audio click sent:', JSON.stringify(got.map((g) => ({ url: g.url, audioOnly: g.audioOnly }))));
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8099/www/links.html' }))[0].id);
  const g = await ctx.newPage();
  await g.goto(`chrome-extension://${extId}/grab.html?tab=${tabId}`);
  await sleep(1500);
  const chips = await g.$$eval('.chip', (cs) => cs.map((c) => c.textContent + (c.classList.contains('on') ? '*' : '')));
  console.log('chips:', chips.join(' | '));
  console.log('rows shown:', await g.$$eval('.row .n', (r) => r.map((x) => x.textContent).join(', ')));
  await g.fill('#q', 'setup');
  console.log('filter "setup":', await g.$$eval('.row .n', (r) => r.map((x) => x.textContent).join(', ')));
  await g.fill('#q', '');
  await g.dispatchEvent('#q', 'input');
  await g.check('#all');
  await g.screenshot({ path: SP + '/ext-grab.png' });
  got.length = 0;
  await g.click('#go');
  await sleep(1500);
  console.log('batch sent:', got[0] && got[0].items.length, 'items; first has cookies field:', got[0] && 'cookies' in got[0].items[0], 'referer:', got[0] && got[0].items[0].referer);
  console.log('msg:', await g.textContent('#msg'));
  await g.screenshot({ path: SP + '/ext-grab2.png' });
  await ctx.close(); mock.close();
})().catch((e) => { console.error(e); process.exit(1); });
