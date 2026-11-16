const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9555');
  const page = b.contexts()[0].pages().find((p) => p.url().includes('index.html'));
  await page.evaluate(() => fluxget.pauseAll()); await sleep(500);
  await page.evaluate(() => fluxget.setSettings({ afterAll: 'sleep', speedLimitMbps: 0 }));
  await page.evaluate(() => fluxget.add({ url: 'http://127.0.0.1:8099/www/clip.mp4', filename: 'last.mp4' }));
  await sleep(3000);
  console.log('power dialog open:', await page.evaluate(() => document.getElementById('dlg-power').open), '-', await page.textContent('#p-text'));
  await page.click('#dlg-power button'); await sleep(300);
  const s = await page.evaluate(() => fluxget.getSettings());
  console.log('after cancel: dialog open =', await page.evaluate(() => document.getElementById('dlg-power').open), ', afterAll =', s.afterAll);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
