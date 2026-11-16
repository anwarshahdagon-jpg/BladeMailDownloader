const { chromium } = require('playwright');
const path = require('path');
const EXT = path.resolve(__dirname, '../extension');
const SP = process.env.SP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const ctx = await chromium.launchPersistentContext(SP + '/chrome-profile', {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1280, height: 900 }, acceptDownloads: true,
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  console.log('extension loaded:', sw.url());
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8099/www/main.html');
  await page.evaluate(() => document.getElementById('main').play());
  await sleep(2500);
  const buttons = async () => page.evaluate(() => [...document.querySelectorAll('fluxget-button')].filter((b) => b.style.display !== 'none').map((b) => {
    const r = b.getBoundingClientRect();
    const hit = [...document.querySelectorAll('video')].find((v) => { const q = v.getBoundingClientRect(); return r.top >= q.top && r.top <= q.bottom && r.left >= q.left && r.left <= q.right; });
    return hit ? hit.id : 'unknown@' + Math.round(r.top);
  }));
  console.log('buttons visible on:', await buttons());
  await page.screenshot({ path: SP + '/ext1.png' });
  // user clicks the muted feed video to unmute it -> it becomes a "real" video
  await page.click('#feed');
  await sleep(1500);
  console.log('after user unmutes feed video:', await buttons());
  // click Download video on the main player
  const r = await page.evaluate(() => { const b = [...document.querySelectorAll('fluxget-button')][0].getBoundingClientRect(); return { x: b.left + 40, y: b.top + 14 }; });
  await page.mouse.click(r.x, r.y);
  await sleep(1500);
  await page.screenshot({ path: SP + '/ext2.png' });

  // MSE (blob:) player that loads an HLS playlist
  const p2 = await ctx.newPage();
  await p2.goto('http://127.0.0.1:8099/www/mse.html');
  await sleep(1500);
  await p2.keyboard.press('Shift');

  await sleep(1500);
  const vis = await p2.evaluate(() => [...document.querySelectorAll('fluxget-button')].filter((b) => b.style.display !== 'none').length);
  console.log('MSE page buttons:', vis);
  if (vis) {
    const r2 = await p2.evaluate(() => { const b = document.querySelector('fluxget-button').getBoundingClientRect(); return { x: b.left + 40, y: b.top + 14 }; });
    await p2.mouse.click(r2.x, r2.y);
    await sleep(1500);
    await p2.screenshot({ path: SP + '/ext3.png' });
  }

  // a normal Chrome download should be taken over by BladeMail
  await page.bringToFront();
  await page.evaluate(() => document.getElementById('dl').click());
  await sleep(3000);
  console.log('handled ids:', await sw.evaluate(() => [...handled]));
  console.log('Chrome download list after takeover:', JSON.stringify(await sw.evaluate(() => chrome.downloads.search({}).then((l) => l.map((d) => d.state + ' ' + d.url)))));
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
