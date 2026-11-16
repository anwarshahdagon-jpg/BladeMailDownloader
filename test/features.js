'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const { srv, DATA } = require('./server');
const { DownloadManager } = require('../app/engine/manager');
const BASE = 'http://127.0.0.1:8099';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fgf-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (m, id, pred, ms = 120000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout ' + id)), ms);
  const check = () => { const it = m.get(id); if (it && pred(it)) { clearTimeout(t); m.off('update', check); resolve(it); } };
  m.on('update', check); check();
});
const done = (m, id) => waitFor(m, id, (i) => i.state === 'completed' || (i.state === 'error' && !i.retryAt));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

(async () => {
  await new Promise((r) => srv.listen(8099, r));
  const m = new DownloadManager({ dataDir: path.join(tmp, 'data'), defaultDownloadDir: path.join(tmp, 'dl') });
  m.load();
  m.saveSettings({ duplicateAction: 'rename' }); // these older tests add the same links many times
  let allDone = 0; m.on('allDone', () => allDone++);

  // 1. speed limit 40 Mb/s = 5 MB/s
  m.saveSettings({ speedLimitMbps: 40, connections: 8 });
  let a = m.add({ url: BASE + '/file.bin', filename: 'limited.bin' });
  await sleep(4000);
  const got = m.snapshot(m.get(a.id)).downloaded;
  const rate = got / 4 / 1e6 * 8;
  console.log(`speed limit 40 Mb/s -> measured ${rate.toFixed(1)} Mb/s`);
  assert(rate > 25 && rate < 50, 'limit not respected');
  m.saveSettings({ speedLimitMbps: 0 });
  let it = await done(m, a.id);
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA));
  console.log('limit removed mid-download, finished; saved to', path.relative(tmp, it.filePath));
  assert(it.filePath.includes(path.join('dl', 'Other')));

  // 2. sort by type
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Clip.mp4' });
  it = await done(m, a.id);
  assert(it.filePath.includes(path.join('dl', 'Video')), it.filePath);
  console.log('sorted:', path.relative(tmp, it.filePath));

  // 3. quality picker (ask)
  let asked = null; m.once('needQuality', (s) => { asked = s; });
  a = m.add({ url: BASE + '/master.m3u8', filename: 'Show' });
  it = await waitFor(m, a.id, (i) => i.needQuality);
  console.log('asked for quality, choices:', asked.variants.map((v) => v.height + 'p').join(', '));
  m.setQuality(a.id, asked.variants.find((v) => v.height === 360).url);
  it = await done(m, a.id);
  assert.strictEqual(it.state, 'completed', it.error);
  assert.strictEqual(it.quality, '360p');
  console.log('picked 360p ->', path.relative(tmp, it.filePath));
  m.saveSettings({ preferredQuality: '720' });
  a = m.add({ url: BASE + '/master.m3u8', filename: 'Show2' });
  it = await done(m, a.id);
  assert.strictEqual(it.quality, '720p');
  console.log('preferred 720p used automatically');

  // 4. link refresh
  a = m.add({ url: BASE + '/file.bin?token=old', filename: 'refresh.bin' });
  await sleep(300); m.pause(a.id); await waitFor(m, a.id, (i) => i.state === 'paused'); await sleep(500);
  const b = m.add({ url: BASE + '/file.bin?token=new', filename: 'refresh.bin' });
  assert.strictEqual(b.id, a.id); assert(b.refreshed);
  it = await done(m, a.id);
  assert.strictEqual(it.state, 'completed'); assert(it.url.endsWith('token=new'));
  assert(fs.readFileSync(it.filePath).equals(DATA));
  console.log('same file added with a new link -> continued the existing download');

  // 5. schedule
  const now = new Date();
  m.saveSettings({ scheduleEnabled: true, scheduleStart: hhmm(new Date(now.getTime() + 3 * 3600e3)), scheduleStop: hhmm(new Date(now.getTime() + 4 * 3600e3)) });
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'later.mp4', schedule: true });
  await sleep(500);
  assert.strictEqual(m.get(a.id).state, 'scheduled');
  console.log('scheduled download waits');
  m.saveSettings({ scheduleStart: hhmm(new Date(now.getTime() - 60e3)), scheduleStop: hhmm(new Date(now.getTime() + 3600e3)) });
  it = await done(m, a.id);
  assert.strictEqual(it.state, 'completed');
  console.log('started when the schedule window opened');
  m.saveSettings({ scheduleEnabled: false });

  // 6. auto-retry on connection errors
  m.saveSettings({ autoRetryMax: 1 });
  a = m.add({ url: 'http://127.0.0.1:1/x.bin' });
  it = await waitFor(m, a.id, (i) => i.state === 'error', 60000);
  assert(it.retryAt, 'should schedule a retry');
  console.log(`connection failed -> retry in ${Math.round((it.retryAt - Date.now()) / 1000)}s ("${it.error}")`);
  m.pause(a.id);
  await sleep(200);
  await m.remove(a.id);
  await sleep(200);
  console.log('allDone events:', allDone);
  assert(allDone >= 1);

  await m.shutdown(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('FEATURE TESTS PASSED'); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
