const { chromium } = require('playwright');
const SP = process.env.SP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9555');
  const page = b.contexts()[0].pages().find((p) => p.url().includes('index.html'));
  const st = async () => page.evaluate(() => [...document.querySelectorAll('.row')].map((r) => r.querySelector('.fn').textContent + ' | ' + r.querySelector('.sub').textContent));
  console.log('rows:', await st());
  // quality dialog should reopen via "Choose quality"
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  await page.click('.row .a1.primary');
  await sleep(300);
  await page.click('#q-list button:nth-child(2)');
  await sleep(2500);
  console.log('after picking 360p:', await st());
  // settings tabs
  await page.click('#btn-settings'); await sleep(300);
  await page.click('.tabnav button[data-tab="speed"]'); await page.check('#s-limit-on'); await page.fill('#s-limit', '80'); await sleep(200);
  await page.screenshot({ path: SP + '/set-speed.png' });
  await page.click('.tabnav button[data-tab="schedule"]'); await sleep(200);
  await page.screenshot({ path: SP + '/set-sched.png' });
  await page.click('#dlg-settings button.primary'); await sleep(500);
  console.log('limit badge:', await page.textContent('#limit-badge'));
  // batch add
  await page.click('#btn-add'); await sleep(300);
  await page.fill('#add-urls', 'http://127.0.0.1:8099/www/clip.mp4\nhttp://127.0.0.1:8099/file.bin\nnot a link\nhttp://127.0.0.1:8099/norange.bin');
  await page.dispatchEvent('#add-urls', 'input');
  console.log('add dialog says:', await page.textContent('#add-count'));
  await page.click('#add-ok'); await sleep(2500);
  console.log('rows:', await st());
  await page.screenshot({ path: SP + '/main.png' });
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
