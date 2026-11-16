'use strict';
/**
 * Finds the browsers installed on this Windows PC and opens their extension pages,
 * so the BladeMail extension can be loaded with a couple of clicks.
 * (Browsers do not allow other programs to install extensions silently unless they come from
 * the browser's own store, so the final "Load unpacked" click has to be done by the user.)
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const env = (k) => process.env[k] || '';
const PF = env('ProgramFiles') || 'C:\\Program Files';
const PF86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
const LAD = env('LOCALAPPDATA');

const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', page: 'chrome://extensions', kind: 'chromium',
    paths: [[PF, 'Google\\Chrome\\Application\\chrome.exe'], [PF86, 'Google\\Chrome\\Application\\chrome.exe'], [LAD, 'Google\\Chrome\\Application\\chrome.exe']] },
  { id: 'edge', name: 'Microsoft Edge', page: 'edge://extensions', kind: 'chromium',
    paths: [[PF86, 'Microsoft\\Edge\\Application\\msedge.exe'], [PF, 'Microsoft\\Edge\\Application\\msedge.exe']] },
  { id: 'brave', name: 'Brave', page: 'brave://extensions', kind: 'chromium',
    paths: [[PF, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], [PF86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'], [LAD, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']] },
  { id: 'opera', name: 'Opera', page: 'opera://extensions', kind: 'chromium',
    paths: [[LAD, 'Programs\\Opera\\opera.exe'], [PF, 'Opera\\opera.exe']] },
  { id: 'operagx', name: 'Opera GX', page: 'opera://extensions', kind: 'chromium',
    paths: [[LAD, 'Programs\\Opera GX\\opera.exe']] },
  { id: 'vivaldi', name: 'Vivaldi', page: 'vivaldi://extensions', kind: 'chromium',
    paths: [[LAD, 'Vivaldi\\Application\\vivaldi.exe'], [PF, 'Vivaldi\\Application\\vivaldi.exe']] },
  { id: 'chromium', name: 'Chromium', page: 'chrome://extensions', kind: 'chromium',
    paths: [[LAD, 'Chromium\\Application\\chrome.exe']] },
  { id: 'firefox', name: 'Mozilla Firefox', page: 'about:debugging#/runtime/this-firefox', kind: 'firefox',
    paths: [[PF, 'Mozilla Firefox\\firefox.exe'], [PF86, 'Mozilla Firefox\\firefox.exe'], [LAD, 'Mozilla Firefox\\firefox.exe']] },
];

function exeOf(b) {
  for (const [base, rel] of b.paths) {
    if (!base) continue;
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detect() {
  return BROWSERS.map((b) => ({ id: b.id, name: b.name, kind: b.kind, page: b.page, installed: !!exeOf(b) }))
    .filter((b) => b.installed || process.platform !== 'win32');
}

function extensionFolders() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  return { chromium: path.join(base, 'extension'), firefox: path.join(base, 'extension-firefox') };
}

function openExtensionsPage(id) {
  const b = BROWSERS.find((x) => x.id === id);
  const exe = b && exeOf(b);
  if (!exe) return false;
  spawn(exe, [b.page], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { detect, extensionFolders, openExtensionsPage };
