'use strict';
/*
 * BladeMail Connector — floating "Download video" button.
 *
 * The button only appears on videos that look like something the user is actually watching:
 *  - big enough (at least 300x168 on screen) and visible
 *  - not a DRM-protected player (those can't be downloaded)
 *  - NOT a hover / autoplay preview. A video counts as "real" only when
 *      it plays with sound, or the user started it (click / key press), or it has native controls.
 *    Muted, looping or auto-started clips (thumbnail previews, feed autoplay, background loops) are ignored
 *    until the user interacts with them.
 */
(() => {
  if (window.__fluxgetLoaded) return;
  window.__fluxgetLoaded = true;

  const MIN_W = 300;
  const MIN_H = 168;
  const PREVIEW_HINT = /(^|[\s_-])(preview|thumbnail|thumb|hover|inline-player|moving-thumbnail|teaser|gif|background|bg-video|hero)([\s_-]|$)/i;
  // Sites whose videos are protected or which forbid downloading in their terms: no button there.
  const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|netflix\.com|primevideo\.com|amazon\.[a-z.]+|disneyplus\.com|hulu\.com|max\.com|hbomax\.com|spotify\.com|tv\.apple\.com|music\.youtube\.com)$/i;

  if (BLOCKED_HOSTS.test(location.hostname)) return;

  let enabled = true;
  try {
    chrome.storage.local.get({ videoButton: true }, (r) => { enabled = r.videoButton; schedule(); });
    chrome.storage.onChanged.addListener((c) => { if (c.videoButton) { enabled = c.videoButton.newValue; schedule(); } });
  } catch { /* extension reloaded */ }

  const info = new WeakMap(); // video -> { userStarted, dismissed, btn }
  const known = new Set();
  let lastGesture = 0;

  const gesture = () => { lastGesture = Date.now(); };
  addEventListener('pointerdown', gesture, true);
  addEventListener('keydown', gesture, true);

  const meta = (v) => {
    let m = info.get(v);
    if (!m) { m = { userStarted: false, dismissed: false, btn: null }; info.set(v, m); }
    return m;
  };

  // Catch videos everywhere (also inside shadow DOM) through their media events.
  const track = (e) => {
    const v = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    known.add(v);
    const m = meta(v);
    if (e.type === 'play' || e.type === 'playing') {
      const byUser = (navigator.userActivation && navigator.userActivation.isActive) || Date.now() - lastGesture < 1500;
      if (byUser) m.userStarted = true;
    }
    if (e.type === 'volumechange' && !v.muted && v.volume > 0 && Date.now() - lastGesture < 1500) m.userStarted = true;
    schedule();
  };
  for (const t of ['play', 'playing', 'pause', 'volumechange', 'loadedmetadata', 'emptied', 'ended']) {
    document.addEventListener(t, track, true);
  }

  function insidePreview(v) {
    let n = v;
    for (let i = 0; n && i < 6; i++) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : '';
      if (PREVIEW_HINT.test(id) || PREVIEW_HINT.test(cls)) return true;
      if (n.tagName === 'A' && n.href && i > 0) return true; // a video inside a link card is a preview
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
    return false;
  }

  function isRealVideo(v) {
    if (!v.isConnected) return false;
    const m = meta(v);
    if (m.dismissed) return false;
    if (v.mediaKeys) return false; // DRM (Encrypted Media Extensions)
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    if (r.bottom < 40 || r.right < 40 || r.top > innerHeight - 40 || r.left > innerWidth - 40) return false;
    const st = getComputedStyle(v);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.2) return false;
    if (!v.currentSrc && !v.src && !v.querySelector('source')) return false;
    const d = v.duration;
    if (d && isFinite(d) && d < 8) return false; // short loops / animated clips
    if (m.userStarted) return true;
    if (insidePreview(v)) return false;
    if (v.loop && (v.muted || v.volume === 0)) return false;
    const audible = !v.muted && v.volume > 0;
    if (audible && (!v.paused || v.currentTime > 0)) return true;
    if (v.controls && !v.autoplay) return true;
    return false;
  }

  // ---------- button UI (isolated in a shadow root so page styles can't break it) ----------
  function makeButton(v) {
    const host = document.createElement('fluxget-button');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;display:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .w{display:flex;align-items:center;gap:2px;font:600 12.5px/1 "Segoe UI",system-ui,sans-serif;opacity:.88;transition:opacity .15s;filter:drop-shadow(0 3px 8px rgba(0,0,0,.35))}
        .w:hover{opacity:1}
        button{all:unset;cursor:pointer;display:flex;align-items:center;gap:7px;color:#06121a;background:linear-gradient(135deg,#3ad1b0,#2a9bf5);padding:7px 12px 7px 9px;border-radius:8px 0 0 8px}
        button:hover{filter:brightness(1.08)}
        .au{border-radius:0;padding:7px 9px;background:#1b2436;color:#cfd8ea;font-size:14px}
        .au:hover{background:#26324b;filter:none}
        .x{border-radius:0 8px 8px 0;padding:7px 8px;background:#1b2436;color:#cfd8ea}
        .x:hover{background:#26324b;filter:none}
        svg{width:15px;height:15px}
        .msg{position:absolute;top:calc(100% + 6px);right:0;white-space:normal;width:max-content;max-width:280px;background:#151c2b;color:#e6ebf5;border:1px solid #26314a;border-radius:7px;padding:7px 9px;font:500 12px/1.35 "Segoe UI",system-ui,sans-serif;display:none}
        .msg.err{border-color:#f2617a}
      </style>
      <div class="w">
        <button class="go" title="Download this video with BladeMail">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M6.5 10.5 12 16l5.5-5.5"/><path d="M5 20h14"/></svg>
          <span class="t">Download video</span>
        </button>
        <button class="au" title="Download only the sound (audio) with BladeMail">♪</button>
        <button class="x" title="Hide for this video">✕</button>
        <div class="msg"></div>
      </div>`;
    const go = root.querySelector('.go');
    const label = root.querySelector('.t');
    const msg = root.querySelector('.msg');
    const show = (text, err) => {
      msg.textContent = text;
      msg.className = 'msg' + (err ? ' err' : '');
      msg.style.display = 'block';
      clearTimeout(host._t);
      host._t = setTimeout(() => { msg.style.display = 'none'; }, err ? 7000 : 2500);
    };
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'dblclick']) host.addEventListener(t, (e) => e.stopPropagation());
    const send = (e, audioOnly) => {
      stop(e);
      label.textContent = 'Sending…';
      const sources = [...v.querySelectorAll('source')].map((s) => s.src).filter(Boolean);
      try {
        chrome.runtime.sendMessage(
          { type: 'downloadVideo', src: v.currentSrc || v.src, sources, title: document.title, duration: v.duration, audioOnly },
          (res) => {
            label.textContent = 'Download video';
            if (chrome.runtime.lastError) return show('Extension was updated — reload this page.', true);
            show(res && res.message ? res.message : 'Something went wrong', !(res && res.ok));
          },
        );
      } catch {
        label.textContent = 'Download video';
        show('Extension was updated — reload this page.', true);
      }
    };
    go.addEventListener('click', (e) => send(e, false));
    root.querySelector('.au').addEventListener('click', (e) => send(e, true));
    root.querySelector('.x').addEventListener('click', (e) => { stop(e); meta(v).dismissed = true; schedule(); });
    return host;
  }

  function place(v, m) {
    if (!m.btn) m.btn = makeButton(v);
    const host = m.btn;
    // In fullscreen only the fullscreen element is painted, so the button must live inside it.
    const fs = document.fullscreenElement;
    const parent = fs && fs.contains(v) && fs !== v ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
    const r = v.getBoundingClientRect();
    host.style.display = 'block';
    const w = host.offsetWidth || 160;
    host.style.top = Math.max(4, r.top + 10) + 'px';
    host.style.left = Math.max(4, Math.min(r.right - w - 10, innerWidth - w - 4)) + 'px';
  }

  function hide(m) { if (m && m.btn) m.btn.style.display = 'none'; }

  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  }

  function update() {
    pending = false;
    for (const v of document.querySelectorAll('video')) known.add(v);
    for (const v of known) {
      const m = meta(v);
      if (!v.isConnected) { hide(m); if (m.btn) m.btn.remove(); known.delete(v); continue; }
      if (enabled && isRealVideo(v)) place(v, m);
      else hide(m);
    }
  }

  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);
  document.addEventListener('fullscreenchange', schedule);
  setInterval(schedule, 1000);
  schedule();
})();
