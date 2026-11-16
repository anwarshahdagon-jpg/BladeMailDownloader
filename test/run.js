'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { srv, DATA, SEGS } = require('./server');
const { DownloadManager } = require('../app/engine/manager');

const BASE = 'http://127.0.0.1:8099';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-'));
const dl = path.join(tmp, 'dl');

function mk() {
  const m = new DownloadManager({ dataDir: path.join(tmp, 'data'), defaultDownloadDir: dl });
  m.load();
  m.saveSettings({ duplicateAction: 'rename' }); // these older tests add the same links many times
  return m;
}
const waitFor = (m, id, states, ms = 120000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for ' + states)), ms);
  const check = () => {
    const it = m.get(id);
    if (it && states.includes(it.state)) { clearTimeout(t); m.off('update', check); resolve(it); }
  };
  m.on('update', check); check();
});
const stats = async () => (await fetch(BASE + '/stats')).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => srv.listen(8099, r));

  // 1. single vs multi connection speed
  let m = mk();
  m.saveSettings({ connections: 1 }); if (process.env.SKIP1) m.saveSettings({ connections: 8 });
  let t0 = Date.now();
  let a = m.add({ url: BASE + '/file.bin', filename: 'one.bin' });
  let it = await waitFor(m, a.id, ['completed', 'error']);
  const t1 = (Date.now() - t0) / 1000;
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA), 'single-connection data mismatch');
  console.log(`1 connection: ${t1.toFixed(1)}s`);

  m.saveSettings({ connections: 8 });
  t0 = Date.now();
  a = m.add({ url: BASE + '/redirect' });
  it = await waitFor(m, a.id, ['completed', 'error']);
  const t8 = (Date.now() - t0) / 1000;
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA), 'multi-connection data mismatch');
  assert.strictEqual(it.filename, 'test file.bin');
  const s = await stats();
  console.log(`8 connections: ${t8.toFixed(1)}s (max parallel seen ${s.maxConns}), file name "${it.filename}"`);
  if (!process.env.SKIP1) assert(t8 < t1 / 4, 'multi-connection should be much faster');

  // 2. pause / resume in-process
  a = m.add({ url: BASE + '/file.bin', filename: 'pause.bin' });
  await sleep(1500);
  m.pause(a.id);
  it = await waitFor(m, a.id, ['paused']);
  await sleep(500);
  const before = m.snapshot(it).downloaded;
  console.log(`paused at ${(before / 1048576).toFixed(1)} MB`);
  assert(before > 0 && before < DATA.length);
  m.resume(a.id);
  it = await waitFor(m, a.id, ['completed', 'error']);
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA), 'pause/resume data mismatch');
  console.log('pause/resume OK');

  // 3. resume after app "restart" (process shutdown mid-download)
  a = m.add({ url: BASE + '/file.bin', filename: 'restart.bin' });
  await sleep(1500);
  await m.shutdown();
  const partSize = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'downloads.json'))).find((x) => x.id === a.id);
  console.log(`shut down with ${partSize.segments.length} segments saved, state=${partSize.state}`);
  m = mk(); // new app instance; should auto-resume
  it = await waitFor(m, a.id, ['completed', 'error']);
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA), 'restart-resume data mismatch');
  console.log('resume after restart OK');

  // 4. flaky server (connections cut randomly)
  a = m.add({ url: BASE + '/flaky.bin', filename: 'flaky.bin' });
  it = await waitFor(m, a.id, ['completed', 'error'], 240000);
  assert.strictEqual(it.state, 'completed', it.error);
  assert(fs.readFileSync(it.filePath).equals(DATA), 'flaky data mismatch');
  console.log('flaky server OK');

  // 5. server without range support
  a = m.add({ url: BASE + '/norange.bin', filename: 'norange.bin' });
  it = await waitFor(m, a.id, ['completed', 'error']);
  assert.strictEqual(it.state, 'completed', it.error);
  assert.strictEqual(it.resumable, false);
  assert(fs.readFileSync(it.filePath).equals(DATA));
  console.log('no-range server OK (single connection, marked not resumable)');

  // 6. HLS master playlist -> best variant, joined in order
  m.saveSettings({ preferredQuality: 'best' });
  a = m.add({ url: BASE + '/master.m3u8', filename: 'My Video' });
  it = await waitFor(m, a.id, ['completed', 'error']);
  assert.strictEqual(it.state, 'completed', it.error);
  console.log(`HLS saved as ${path.basename(it.filePath)} quality=${it.quality}`);
  if (it.filePath.endsWith('.ts')) assert(fs.readFileSync(it.filePath).equals(Buffer.concat(SEGS)));

  // 7. encrypted + live are refused
  for (const p of ['/enc.m3u8', '/live.m3u8']) {
    a = m.add({ url: BASE + p });
    it = await waitFor(m, a.id, ['completed', 'error']);
    assert.strictEqual(it.state, 'error');
    console.log(`${p} refused: ${it.error}`);
  }

  await m.shutdown();
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
