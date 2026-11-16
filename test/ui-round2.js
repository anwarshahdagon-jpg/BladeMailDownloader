// Round 2 UI: duplicate prompt, file check, history, light theme, mini window.
const { chromium } = require('playwright');
const SP = process.env.SP;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9555');
  const page = b.contexts()[0].pages().find((p) => p.url().includes('index.html'));
  await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  const st = async () => page.evaluate(() => [...document.querySelectorAll('.row')].map((r) => r.querySelector('.fn').textContent + ' | ' + r.querySelector('.sub').textContent));
  const add = async (url, audio) => {
    await page.click('#btn-add'); await sleep(300);
    await page.fill('#add-urls', url); await page.dispatchEvent('#add-urls', 'input');
    if (audio) await page.check('#add-audio');
    await page.click('#add-ok'); await sleep(2500);
  };
  await add('http://127.0.0.1:8099/www/clip.mp4');
  console.log('1:', await st());
  await add('http://127.0.0.1:8099/www/clip.mp4');
  console.log('dup dialog open:', await page.evaluate(() => document.getElementById('dlg-dup').open), await page.textContent('#dup-text'));
  await page.screenshot({ path: SP + '/r2-dup.png' });
  await page.click('#dlg-dup [data-a="rename"]'); await sleep(2500);
  console.log('after rename:', await st());
  // check file
  await page.evaluate(() => { const r = [...document.querySelectorAll('.row')].pop(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 })); });
  await sleep(200);
  console.log('menu:', await page.$$eval('#menu button', (bs) => bs.map((x) => x.textContent).join(' / ')));
  await page.click('#menu button:has-text("Check file")'); await sleep(1500);
  console.log('hash status:', await page.textContent('#h-status'));
  const md5 = await page.evaluate(() => document.querySelector('#h-list code').textContent);
  await page.fill('#h-expected', md5.toUpperCase()); await page.dispatchEvent('#h-expected', 'input');
  console.log('compare:', await page.textContent('#h-result'));
  await page.screenshot({ path: SP + '/r2-hash.png' });
  await page.fill('#h-expected', 'a'.repeat(64)); await page.dispatchEvent('#h-expected', 'input');
  console.log('compare bad:', await page.textContent('#h-result'));
  await page.click('#dlg-hash button.primary'); await sleep(200);
  // history
  await page.click('#btn-history'); await sleep(500);
  console.log('stats:', await page.$$eval('.stat', (s) => s.map((x) => x.textContent).join(' | ')));
  console.log('history rows:', await page.$$eval('#hist .hrow', (s) => s.length));
  await page.screenshot({ path: SP + '/r2-history.png' });
  await page.click('#dlg-history button.primary'); await sleep(200);
  // settings: light theme + mini always
  await page.click('#btn-settings'); await sleep(300);
  await page.click('.tabnav button[data-tab="files"]'); await sleep(800);
  console.log('ffmpeg status:', await page.textContent('#ff-status'));
  await page.screenshot({ path: SP + '/r2-files.png' });
  await page.click('.tabnav button[data-tab="general"]');
  await page.selectOption('#s-theme', 'light'); await page.selectOption('#s-mini', 'always');
  await page.click('#dlg-settings button.primary'); await sleep(1500);
  console.log('html.light:', await page.evaluate(() => document.documentElement.classList.contains('light')));
  await page.screenshot({ path: SP + '/r2-light.png' });
  const pages = b.contexts()[0].pages().map((p) => p.url());
  console.log('windows:', pages.join(', '));
  const mini = b.contexts()[0].pages().find((p) => p.url().includes('mini.html'));
  if (mini) { await sleep(1500); await mini.screenshot({ path: SP + '/r2-mini.png' }); console.log('mini text:', (await mini.textContent('body')).replace(/\s+/g, ' ').trim()); }
  const s = await page.evaluate(() => fluxget.getSettings());
  console.log('saved:', s.theme, s.miniWindow, s.duplicateAction);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
