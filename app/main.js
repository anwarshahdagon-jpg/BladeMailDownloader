'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, Notification, nativeImage, clipboard, screen, nativeTheme } = require('electron');
const post = require('./engine/post');
const { installFfmpeg } = require('./tools');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DownloadManager } = require('./engine/manager');
const { startServer, PORT } = require('./server');
const browsers = require('./browsers');

const VERSION = require('./package.json').version;
const ICON = path.join(__dirname, 'assets', 'icon.png');

// Renamed from FluxGet: keep using the old data folder's contents (download list, settings, history, ffmpeg).
(() => {
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'FluxGet');
  const newDir = path.join(appData, 'BladeMail');
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(path.join(newDir, 'settings.json'))) {
      try { fs.renameSync(oldDir, newDir); } catch { fs.cpSync(oldDir, newDir, { recursive: true }); }
    }
  } catch { /* fall back to a fresh folder */ }
  app.setPath('userData', newDir);
})();
app.setAppUserModelId('com.blademail.downloadmanager');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let quitting = false;
  const startHidden = process.argv.includes('--hidden');

  const manager = new DownloadManager({
    dataDir: app.getPath('userData'),
    defaultDownloadDir: path.join(app.getPath('downloads')),
  });

  function applyLoginItem() {
    // Start with Windows. In dev mode (npm start) Electron itself is started with this app folder.
    const args = app.isPackaged ? ['--hidden'] : [path.resolve(__dirname), '--hidden'];
    if (!manager.settings.startMinimized) args.pop();
    app.setLoginItemSettings({ openAtLogin: !!manager.settings.startWithSystem, path: process.execPath, args, name: 'BladeMail' });
    // remove the auto-start entry of the old FluxGet name, so Windows doesn't start two copies
    if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: false, name: 'FluxGet' });
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function showWindow() {
    if (!win || win.isDestroyed()) createWindow(true);
    else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  }

  // Windows blocks background apps from stealing focus, so briefly pin the window on top to make sure it shows.
  function bringToFront() {
    if (!win || win.isDestroyed()) createWindow(true);
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    win.moveTop();
    setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 1500);
  }

  function createWindow(show) {
    win = new BrowserWindow({
      width: 1080, height: 640, minWidth: 760, minHeight: 420, show: false, title: 'BladeMail Download Manager',
      icon: ICON, backgroundColor: '#0f1420', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu();
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    win.once('ready-to-show', () => { if (show) win.show(); });
    if (process.env.FLUXGET_SHOT) {
      // developer aid: save a screenshot of the window after a few seconds
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.FLUXGET_SHOT, img.toPNG());
      }, Number(process.env.FLUXGET_SHOT_DELAY || 4000));
    }
    win.on('close', (e) => {
      if (!quitting && manager.settings.closeToTray) {
        e.preventDefault();
        // while downloading, stay on the taskbar (minimized) so the progress bar on the icon stays visible
        const busy = manager.items.some((i) => i.state === 'downloading' || i.state === 'queued');
        if (busy && manager.settings.taskbarWhileDownloading !== false) win.minimize();
        else win.hide();
      }
    });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  }

  // ---- "download finished" popup (bottom-right, with Open / Open folder and a sound) ----
  let donePopup = null;
  function showDonePopup(s) {
    if (donePopup && !donePopup.isDestroyed()) donePopup.close();
    const W = 380; const H = 132;
    const wa = screen.getPrimaryDisplay().workArea;
    donePopup = new BrowserWindow({
      width: W, height: H, x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16, frame: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#151c2b', icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    donePopup.loadFile(path.join(__dirname, 'ui', 'done.html'), {
      query: { id: s.id, name: s.filename, size: String(s.size || 0), sound: manager.settings.completeSound ? '1' : '0' },
    });
    donePopup.once('ready-to-show', () => donePopup.showInactive());
  }

  // ---- after all downloads finish: sleep / shut down (with a 60 s chance to cancel) ----
  let powerTimer = null;
  function startPowerCountdown() {
    const action = manager.settings.afterAll;
    if (action !== 'sleep' && action !== 'shutdown') return;
    manager.saveSettings({ afterAll: 'nothing' }); // one-shot: applies to this batch only
    bringToFront();
    setTimeout(() => send('ui:power', { action, seconds: 60 }), 400);
    clearTimeout(powerTimer);
    powerTimer = setTimeout(() => {
      powerTimer = null;
      const p = action === 'shutdown'
        ? spawn('shutdown', ['/s', '/t', '0'], { detached: true, stdio: 'ignore', windowsHide: true })
        : spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => {});
      p.unref();
    }, 60000);
  }

  // ---- offer to download links you copy ----
  const FILE_LINK = /^https?:\/\/\S+\.(zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|apk|dmg|mp4|mkv|webm|avi|mov|m4v|flv|wmv|mp3|m4a|flac|wav|aac|ogg|pdf|epub|docx?|xlsx?|pptx?|m3u8|torrent|bin|img)(\?\S*)?$/i;
  let lastClip = '';
  function watchClipboard() {
    try { lastClip = clipboard.readText(); } catch { /* ignore */ }
    setInterval(() => {
      if (!manager.settings.watchClipboard) return;
      let t = '';
      try { t = clipboard.readText().trim(); } catch { return; }
      if (!t || t === lastClip) return;
      lastClip = t;
      if (!FILE_LINK.test(t) || manager.items.some((i) => i.url === t)) return;
      if (!Notification.isSupported()) return;
      let name = t;
      try { name = decodeURIComponent(new URL(t).pathname.split('/').pop()); } catch { /* keep url */ }
      const n = new Notification({ title: 'Download the copied link with BladeMail?', body: name + '\nClick to download', icon: ICON });
      n.on('click', () => { bringToFront(); setTimeout(() => send('ui:addPrefill', t), 300); });
      n.show();
    }, 1200);
  }

  // ---- theme ----
  function resolvedTheme() {
    const t = manager.settings.theme || 'dark';
    if (t === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    return t;
  }
  function broadcastTheme() { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ui:theme', resolvedTheme()); }
  nativeTheme.on('updated', broadcastTheme);

  // ---- mini speed window (small, always on top) ----
  let mini = null;
  function miniWanted(active) {
    const m = manager.settings.miniWindow;
    return m === 'always' || (m === 'downloading' && active > 0) || m === true;
  }
  function ensureMini(info) {
    const want = miniWanted(info ? info.active : manager.tasks.size);
    if (!want) { if (mini && !mini.isDestroyed()) mini.hide(); return; }
    if (!mini || mini.isDestroyed()) {
      const wa = screen.getPrimaryDisplay().workArea;
      const pos = manager.settings.miniPos || { x: wa.x + wa.width - 270, y: wa.y + 20 };
      mini = new BrowserWindow({
        width: 250, height: 86, x: pos.x, y: pos.y, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
        show: false, backgroundColor: '#151c2b', icon: ICON, focusable: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
      });
      mini.setAlwaysOnTop(true, 'screen-saver');
      mini.loadFile(path.join(__dirname, 'ui', 'mini.html'));
      mini.once('ready-to-show', () => mini.showInactive());
      mini.on('moved', () => { const [x, y] = mini.getPosition(); manager.saveSettings({ miniPos: { x, y } }); });
    } else if (!mini.isVisible()) mini.showInactive();
    if (info) mini.webContents.send('dl:tick', { ...info, overall: overallProgress() });
  }
  function overallProgress() {
    let done = 0; let total = 0;
    for (const i of manager.items) {
      if (i.state !== 'downloading' && i.state !== 'queued') continue;
      const s = manager.snapshot(i);
      if (s.size > 0) { done += s.downloaded; total += s.size; }
    }
    return total > 0 ? done / total : null;
  }

  // ---- progress on the Windows taskbar icon ----
  let lastBar = null;
  function updateTaskbar() {
    if (!win || win.isDestroyed()) return;
    const active = manager.items.filter((i) => i.state === 'downloading' || i.state === 'queued');
    let value = -1; // -1 removes the bar
    let mode = 'normal';
    if (active.length) {
      let done = 0; let total = 0; let unknown = false;
      for (const i of active) {
        const s = manager.snapshot(i);
        if (s.size > 0) { done += s.downloaded; total += s.size; } else unknown = true;
      }
      if (total > 0) value = Math.min(1, done / total);
      else if (unknown) { value = 2; mode = 'indeterminate'; } // size not known yet: moving bar
      else value = 0;
    } else if (manager.items.some((i) => i.state === 'error' && i.retryAt)) {
      value = 1; mode = 'error';
    }
    const key = value === -1 ? 'none' : mode + ':' + value.toFixed(3);
    if (key === lastBar) return;
    lastBar = key;
    win.setProgressBar(value, { mode });
  }

  function trayMenu() {
    return Menu.buildFromTemplate([
      { label: 'Open BladeMail', click: showWindow },
      { type: 'separator' },
      { label: 'Resume all', click: () => manager.resumeAll() },
      { label: 'Pause all', click: () => manager.pauseAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]);
  }

  function updateTray(info) {
    if (!tray) return;
    const t = info && info.active ? `BladeMail — ${info.active} downloading, ${fmtSpeed(info.totalSpeed)}` : 'BladeMail';
    tray.setToolTip(t);
  }

  app.on('second-instance', (_e, argv) => {
    showWindow();
    if (argv.includes('--setup-extensions')) setTimeout(() => send('ui:showExtGuide'), 500);
  });

  app.whenReady().then(async () => {
    manager.load();
    applyLoginItem();

    manager.on('update', (s) => send('dl:update', s));
    manager.on('added', (s) => send('dl:added', s));
    manager.on('removed', (id) => send('dl:removed', id));
    manager.on('list', () => send('dl:list', manager.list()));
    manager.on('tick', (info) => { send('dl:tick', info); updateTray(info); updateTaskbar(); ensureMini(info); });
    manager.on('duplicate', (s) => { bringToFront(); setTimeout(() => send('ui:duplicate', s), 300); });
    manager.on('skipped', (dup) => {
      if (Notification.isSupported()) new Notification({ title: 'Already downloaded — skipped', body: dup.name, icon: ICON, silent: true }).show();
    });
    manager.on('needQuality', (s) => { bringToFront(); setTimeout(() => send('ui:quality', s), 300); });
    manager.on('allDone', () => startPowerCountdown());
    manager.on('completed', (s) => {
      send('dl:update', s);
      if (manager.settings.completePopup) showDonePopup(s);
      else if (manager.settings.notifyOnComplete && Notification.isSupported()) {
        const n = new Notification({ title: 'Download complete', body: s.filename, icon: ICON });
        n.on('click', () => shell.showItemInFolder(s.filePath));
        n.show();
      }
    });

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setContextMenu(trayMenu());
    tray.setToolTip('BladeMail Download Manager');
    tray.on('click', showWindow);

    createWindow(!startHidden);
    watchClipboard();
    ensureMini(null);

    try {
      await startServer({
        manager, version: VERSION,
        onAdded: (added) => {
          if (manager.settings.bringToFront !== false) {
            bringToFront();
            setTimeout(() => send('ui:highlight', added.map((a) => a.id)), 300);
          }
          if (Notification.isSupported()) {
            new Notification({ title: 'Downloading', body: added.map((a) => a.filename).join('\n').slice(0, 200), icon: ICON, silent: true }).show();
          }
        },
      });
    } catch (e) {
      dialog.showErrorBox('BladeMail', `Could not open the browser connection on port ${PORT}.\n` +
        'Another program is using it, so the Chrome extension will not be able to reach BladeMail.\n\n' + e.message);
    }
  });

  // ---- IPC from the window ----
  ipcMain.handle('dl:list', () => manager.list());
  ipcMain.handle('dl:add', (_e, req) => manager.add(req));
  ipcMain.handle('dl:addMany', (_e, urls, opts) => {
    const out = [];
    for (const url of urls) { try { out.push(manager.add({ ...opts, url })); } catch { /* skip bad line */ } }
    return out.length;
  });
  ipcMain.handle('dl:setQuality', (_e, id, url) => manager.setQuality(id, url));
  ipcMain.handle('dl:schedule', (_e, id) => manager.schedule(id));
  ipcMain.handle('dl:resolveDuplicate', (_e, id, action) => manager.resolveDuplicate(id, action));
  ipcMain.handle('history:get', () => manager.getHistory());
  ipcMain.handle('history:clear', () => manager.clearHistory());
  ipcMain.handle('path:open', (_e, p) => (p && fs.existsSync(p) ? shell.openPath(p) : 'File not found'));
  ipcMain.handle('path:show', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); else return 'File not found'; });
  ipcMain.handle('hash:file', async (e, id) => {
    const it = manager.get(id);
    if (!it || !it.filePath || !fs.existsSync(it.filePath)) throw new Error('File not found');
    let last = 0;
    const h = await post.hashFile(it.filePath, ['md5', 'sha1', 'sha256'], (d, t) => {
      if (Date.now() - last > 200) { last = Date.now(); e.sender.send('hash:progress', t ? d / t : 0); }
    });
    return { ...h, expectedMd5: it.expectedMd5 || null };
  });
  ipcMain.handle('tools:ffmpegStatus', async () => ({ path: await post.findFfmpeg(true) }));
  ipcMain.handle('tools:installFfmpeg', async (e) => {
    const p = await installFfmpeg(path.join(app.getPath('userData'), 'tools'), (pr) => e.sender.send('tools:progress', pr));
    return { path: p };
  });
  ipcMain.handle('theme:get', () => resolvedTheme());
  ipcMain.handle('win:showMain', () => showWindow());
  ipcMain.handle('power:cancel', () => { clearTimeout(powerTimer); powerTimer = null; });
  ipcMain.handle('clipboard:ignore', (_e, text) => { lastClip = text; });
  ipcMain.handle('popup:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
  ipcMain.handle('dl:pause', (_e, id) => manager.pause(id));
  ipcMain.handle('dl:resume', (_e, id) => manager.resume(id));
  ipcMain.handle('dl:restart', (_e, id) => manager.restart(id));
  ipcMain.handle('dl:remove', (_e, id, del) => manager.remove(id, del));
  ipcMain.handle('dl:updateUrl', (_e, id, url) => manager.updateUrl(id, url));
  ipcMain.handle('dl:pauseAll', () => manager.pauseAll());
  ipcMain.handle('dl:resumeAll', () => manager.resumeAll());
  ipcMain.handle('dl:clearCompleted', () => manager.clearCompleted());
  ipcMain.handle('dl:open', (_e, id) => {
    const it = manager.get(id);
    if (it && it.filePath && fs.existsSync(it.filePath)) return shell.openPath(it.filePath);
    return 'File not found';
  });
  ipcMain.handle('dl:folder', (_e, id) => {
    const it = manager.get(id);
    if (it && it.filePath && fs.existsSync(it.filePath)) shell.showItemInFolder(it.filePath);
    else shell.openPath(it ? it.dir : manager.settings.downloadDir);
  });
  ipcMain.handle('settings:get', () => ({ ...manager.settings, version: VERSION, port: PORT,
    showExtensionGuide: !manager.settings.extensionGuideShown || process.argv.includes('--setup-extensions') }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = manager.saveSettings(patch);
    applyLoginItem();
    broadcastTheme();
    ensureMini(null);
    return s;
  });
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: manager.settings.downloadDir });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('ext:info', () => ({ browsers: browsers.detect(), folders: browsers.extensionFolders() }));
  ipcMain.handle('ext:open', (_e, id) => browsers.openExtensionsPage(id));
  ipcMain.handle('ext:folder', (_e, kind) => {
    const f = browsers.extensionFolders()[kind];
    if (f) shell.showItemInFolder(path.join(f, 'manifest.json'));
  });
  ipcMain.handle('ext:copy', (_e, kind) => { const f = browsers.extensionFolders()[kind]; if (f) clipboard.writeText(f); return f; });
  ipcMain.handle('ext:firstRunDone', () => manager.saveSettings({ extensionGuideShown: true }));

  app.on('before-quit', async (e) => {
    if (manager._shutdownDone) return;
    e.preventDefault();
    quitting = true;
    await manager.shutdown();
    manager._shutdownDone = true;
    app.quit();
  });

  app.on('window-all-closed', () => { /* keep running in the tray */ });
}

function fmtSpeed(b) {
  if (!b) return '0 KB/s';
  const mbps = ((b * 8) / 1e6).toFixed(1) + ' Mb/s';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB/s (' + mbps + ')';
  return (b / 1024).toFixed(0) + ' KB/s (' + mbps + ')';
}
