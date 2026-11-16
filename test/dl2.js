// Raw CDP (no Playwright download handling) with "Ask where to save" set by env PROMPT.
const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const SP = process.env.SP; const EXT = path.resolve(__dirname, '../extension');
const prof = SP + '/raw-profile'; fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof + '/Default', { recursive: true });
fs.rmSync(SP + '/chrome-dl', { recursive: true, force: true });
fs.writeFileSync(prof + '/Default/Preferences', JSON.stringify({ download: { prompt_for_download: process.env.PROMPT === '1', default_directory: SP + '/chrome-dl' } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const p = spawn('/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--remote-debugging-port=9334', 'http://127.0.0.1:8099/www/main.html'], { stdio: 'ignore' });
  await sleep(4000);
  const targets = await (await fetch('http://127.0.0.1:9334/json')).json();
  const pg = targets.find((t) => t.type === 'page' && t.url.includes('main.html'));
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r) => ws.onopen = r);
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.getElementById('dl').click()", userGesture: true } }));
  await sleep(5000);
  ws.close(); p.kill('SIGKILL');
  console.log('files Chrome saved:', fs.existsSync(SP + '/chrome-dl') ? fs.readdirSync(SP + '/chrome-dl') : []);
})();
