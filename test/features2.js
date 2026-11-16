'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const { srv } = require('./server');
const { DownloadManager } = require('../app/engine/manager');
const post = require('../app/engine/post');
const BASE = 'http://127.0.0.1:8099';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg2-'));
const waitFor = (m, id, pred, ms = 60000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout ' + id)), ms);
  const check = () => { const it = m.get(id); if (it && pred(it)) { clearTimeout(t); m.off('update', check); resolve(it); } };
  m.on('update', check); check();
});
const done = (m, id) => waitFor(m, id, (i) => i.state === 'completed' || (i.state === 'error' && !i.retryAt));
(async () => {
  await new Promise((r) => srv.listen(8099, r));
  const m = new DownloadManager({ dataDir: path.join(tmp, 'data'), defaultDownloadDir: path.join(tmp, 'dl') });
  m.load(); m.saveSettings({ preferredQuality: 'best' });

  // checksum auto verify
  let a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Clip.mp4' });
  let it = await done(m, a.id);
  console.log('server checksum check:', it.verified, '| note:', it.note || '-');
  assert.strictEqual(it.verified, true);
  a = m.add({ url: BASE + '/www/clip.mp4?bad=1', filename: 'Bad.mp4' });
  it = await done(m, a.id);
  console.log('corrupt checksum:', it.verified, '|', it.note);
  assert.strictEqual(it.verified, false);
  const h = await post.hashFile(it.filePath);
  console.log('manual hashes:', h.sha256.slice(0, 16) + '…', 'algo of pasted md5 =', post.algoForHash(h.md5));

  // duplicates
  let dupEvt = null; m.once('duplicate', (s) => { dupEvt = s; });
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Clip.mp4' });
  assert.strictEqual(m.get(a.id).state, 'duplicate'); console.log('duplicate asked:', dupEvt.dup.name);
  m.resolveDuplicate(a.id, 'rename'); it = await done(m, a.id); console.log('rename ->', it.filename);
  assert.strictEqual(it.filename, 'Clip (1).mp4');
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Clip.mp4', duplicateAction: 'skip' });
  assert(a.skipped); console.log('skip -> not added');
  const before = m.items.length;
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Clip.mp4', duplicateAction: 'replace' });
  it = await done(m, a.id);
  console.log('replace ->', it.filename, '(list', before, '->', m.items.length, ')');

  // audio only (direct mp4) and history
  a = m.add({ url: BASE + '/www/clip.mp4', filename: 'Song.mp4', audioOnly: true });
  it = await done(m, a.id);
  console.log('audio only ->', path.relative(tmp, it.filePath), it.size, 'bytes', it.note || '');
  assert(/\.(m4a|mp3)$/.test(it.filePath) && it.filePath.includes('Music'));
  // audio only (HLS)
  a = m.add({ url: BASE + '/master.m3u8', filename: 'Stream', audioOnly: true });
  it = await done(m, a.id);
  console.log('HLS audio only ->', it.state, path.basename(it.filePath || ''), it.note || '', it.error || '');
  console.log('history entries:', m.getHistory().length, 'total bytes:', m.getHistory().reduce((s, x) => s + x.size, 0));
  await m.shutdown(); srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ROUND 2 ENGINE TESTS PASSED'); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
