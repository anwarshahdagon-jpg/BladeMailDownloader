// Real Chromium (not Playwright-controlled downloads) with "Ask where to save each file" ON.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const SP = process.env.SP; const EXT = path.resolve(__dirname, '../extension');
const prof = SP + '/real-profile'; fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof + '/Default', { recursive: true });
fs.writeFileSync(prof + '/Default/Preferences', JSON.stringify({ download: { prompt_for_download: process.env.PROMPT === '1', default_directory: SP + '/chrome-dl' } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const p = spawn('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--remote-debugging-port=9333', 'about:blank'], { stdio: 'ignore' });
  await sleep(3000);
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  let sw = null;
  for (let i = 0; i < 20 && !sw; i++) { for (const w of ctx.serviceWorkers()) if (w.url().endsWith('/background.js') && await w.evaluate(() => !!(chrome.downloads))) sw = w; if (!sw) await sleep(500); }
  console.log('extension worker:', sw && sw.url());
  console.log('diag:', JSON.stringify(await sw.evaluate(async () => ({
    hasDF: chrome.downloads.onDeterminingFilename.hasListeners(), hasCreated: chrome.downloads.onCreated.hasListeners(),
    settings: await chrome.storage.local.get(null), ping: await fetch('http://127.0.0.1:47815/ping', { headers: { 'X-FluxGet': '1' } }).then((r) => r.json()).catch((e) => String(e)),
  }))));
  await sw.evaluate(() => { self.__log = []; chrome.downloads.onCreated.addListener((i) => self.__log.push('C ' + i.id + ' ' + i.state)); });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/www/main.html');
  await sleep(1000);
  await page.evaluate(() => document.getElementById('dl').click());
  await sleep(4000);
  console.log('events:', await sw.evaluate(() => [self.__log, self.fgLog]));
  console.log('Chrome downloads left:', JSON.stringify(await sw.evaluate(() => chrome.downloads.search({}).then((l) => l.map((d) => d.state + ' ' + d.url)))));
  await b.close().catch(() => {}); p.kill();
})().catch((e) => { console.error(e); process.exit(1); });
