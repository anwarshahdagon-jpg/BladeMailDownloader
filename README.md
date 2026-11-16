# BladeMail Download Manager

A free download manager for Windows, with a browser extension for Chrome, Edge, Brave, Opera, Vivaldi and Firefox.

BladeMail splits every file into several parts and downloads them over parallel connections, so a single
download can use your full internet speed. Downloads pause and resume, even after a crash or a reboot. It starts
with Windows, takes over your browser's downloads (no "Save as" box), and puts a **Download video** button
on videos you are actually watching.

**[⬇ Download the latest installer](https://github.com/anwarshahdagon-jpg/BladeMailDownloader/releases/latest)**: open the release and click
`BladeMail-Download-Manager-Setup-x.y.z.exe` under *Assets*.

> **About the Windows warning:** the installer is not code-signed (a certificate costs money every year), so
> Windows SmartScreen may say *"Windows protected your PC"*. Click **More info → Run anyway**. Your browser may
> also ask whether to keep the file. The installer is built by GitHub from the code in this repository
> (see [.github/workflows/build-windows.yml](.github/workflows/build-windows.yml)), so you can check exactly what it contains.

## Features at a glance

- **Fast:** 8 connections per file by default (up to 32), shown in MB/s and in Mb/s like your internet plan
- **Pause / resume:** continues from the exact byte, auto-retries dropped connections, and refreshes expired links
- **Browser takeover:** downloads go to BladeMail instead of the browser, with your cookies so logged-in downloads work
- **Video button:** "Download video" and a ♪ audio-only button on real videos (not on previews or muted feed clips)
- **Right-click:** download a link, image, video or page, or "Download all links on this page…" with type filters
- **Organised:** files are sorted into Video, Music, Documents, Programs, Compressed and Pictures; duplicate files are detected
- **Control:** speed limiter, scheduler (with sleep or shut down when done), choice of video quality, batch add, clipboard links
- **Checks:** checksum verification (MD5, SHA-1, SHA-256), automatic when the server provides one
- **Feedback:** taskbar progress bar, finish popup with sound, mini always-on-top speed window, history and stats
- **Looks:** dark, light, or follow Windows

## 1. Install

1. Download **BladeMail-Download-Manager-Setup-x.y.z.exe** from the [latest release](https://github.com/anwarshahdagon-jpg/BladeMailDownloader/releases/latest) and double-click it.
   - Windows may show *"Windows protected your PC"* because the installer is not code-signed.
     Click **More info → Run anyway**.
2. Click through the installer. It installs for your user only (no admin password), adds Start-menu and
   desktop shortcuts, an uninstaller (Settings → Apps), and sets BladeMail to start with Windows.
3. On the last page leave **Start BladeMail and set up browser extensions** ticked and click Finish.

### Updating from FluxGet

BladeMail Download Manager was called FluxGet before version 1.5.0. Run the new installer over it: it removes FluxGet's
program files, shortcuts and auto-start entry, and BladeMail keeps your download list, settings, history and ffmpeg
(the data folder moves from `%APPDATA%\FluxGet` to `%APPDATA%\BladeMail`). Downloaded files stay where they are.
In each browser, remove the old "FluxGet Connector" extension and add the new one (step 2).

## 2. Add the extension to your browsers (one click each)

BladeMail opens a **Add BladeMail to your browsers** window listing every browser it found
(Chrome, Edge, Brave, Opera, Opera GX, Vivaldi, Chromium, Firefox). You can open it again any time from
the **Browser extensions** button or Start menu → BladeMail → *Set up browser extensions*.

For Chrome, Edge, Brave, Opera, Vivaldi:
1. Click **Open extensions page** next to the browser. The browser opens its extensions page, an
   Explorer window opens on the extension folder, and the folder path is copied.
2. Turn on **Developer mode**, click **Load unpacked**, and choose that folder (or paste the path).
3. Pin the BladeMail icon. A green dot in its popup means it is connected to the app.

For Firefox: click **Open add-on page**, then **Load Temporary Add-on…** and pick `manifest.json` in the
`extension-firefox` folder. Then allow *Access your data for all websites* in the add-on's permissions.

**Why this last click can't be automated:** Chrome, Edge, Brave, Opera and Vivaldi on Windows only allow
programs to install extensions silently if the extension is published in their web store (or the PC is
managed by a company IT policy). Firefox only keeps add-ons signed by Mozilla. BladeMail is not in those
stores, so the browser requires you to approve it yourself. Publishing to the Chrome Web Store / Firefox
Add-ons would remove this step later.

## What it does

| Feature | How |
|---|---|
| Full-speed downloads | 8 parallel connections per file by default (up to 32 in Settings). When one part finishes, the slowest remaining part is split again, so all connections stay busy until the end. No speed limit. |
| Speed in ISP units | Speed is shown in MB/s (megabytes) and in Mb/s (megabits, the unit internet plans use: 100 Mb/s, 300 Mb/s…). 1 MB/s ≈ 8 Mb/s. A peak speed is shown under the graph. |
| No browser "Save as" dialog | In Chrome, Edge, Brave, Opera and Vivaldi the extension hands the download to BladeMail before the browser asks where to save it, so the dialog doesn't appear. |
| Shows you it started | When a download comes from the browser, the BladeMail window jumps to the front and the new download flashes at the top of the list (can be turned off in Settings). |
| Speed limiter | Settings → Speed. Set a total limit in Mb/s (e.g. 80 Mb/s on a 100 Mb/s plan) so browsing, games and calls stay smooth. Off by default. |
| Sorted folders | Settings → Files. Files go into Video, Music, Documents, Programs, Compressed, Pictures or Other inside your download folder. |
| Video quality | When a stream offers several qualities, BladeMail asks (1080p, 720p…) or uses your preferred quality from Settings → Files. |
| Scheduler | Settings → Schedule. Tick "Download at the scheduled time" when adding, or right-click a download. Choose to sleep or shut down the PC when everything finishes (60-second cancel, applies once). |
| Many links at once | "+ Add link" takes one link per line. When you copy a download link anywhere, BladeMail offers to download it (Settings → Browser & links). |
| Finish box | A small "Download complete" box with Open / Open folder buttons and a chime (Settings → Notifications). |
| Auto-retry & link refresh | Connection drops are retried automatically (15 s, 30 s, 1 min, 2 min, 5 min). If a link expired, just download the same file again in the browser: BladeMail continues the old download with the new link. |
| Taskbar progress | The BladeMail taskbar icon fills up with the total progress of running downloads. While downloading, closing the window minimizes it instead of hiding it, so the icon stays on the taskbar (Settings → General). |
| Pause / resume | Pause any time; resume continues from the exact byte. Progress is saved every second, so it also survives closing the app, crashes and reboots. |
| Expired links | Right-click a paused/failed download → **Change link…**, paste a fresh link to the same file, and it continues where it stopped. |
| Takes over Chrome downloads | When you download a file in Chrome, the extension cancels Chrome's copy and hands it (with your cookies, so logged-in downloads work) to BladeMail. If BladeMail isn't running, Chrome downloads normally. Toggle in the extension popup or in app Settings. |
| Download video button | Appears at the top-right of a video you are actually watching. It does **not** appear on hover previews, muted autoplay clips in feeds, background loops or small thumbnails. Once you unmute or click play on a muted clip it becomes a "real" video and the button appears. Click ✕ to hide it for that video. |
| Streams | Ordinary HLS streams (`.m3u8`) are downloaded in the best quality, segments in parallel, and joined into one file. |
| Right-click menu | On links, images, videos and pages: "Download … with BladeMail". On any page: **"Download all links on this page…"** opens a list of every file link, image and video on the page, with filter buttons (Video, Audio, Archives, Programs, Documents, Images, Other), a text filter, "Select all shown" and "Download selected". |
| Audio only | The ♪ button next to "Download video", the right-click item "Download audio only with BladeMail", or the "Audio only" box in "+ Add link". The sound is saved into Music as M4A (no quality loss) or MP3 if needed (Settings → Files). Needs the free **ffmpeg** tool once: Settings → Files → **Get ffmpeg** (about 100 MB, stored in BladeMail's own folder). |
| File check | Downloads are checked automatically when the server publishes a checksum ("file check passed ✓"). Right-click a finished download → **Check file (checksum)…** shows MD5, SHA-1 and SHA-256 and compares them with the checksum you paste from the website. |
| Duplicates | If you download a file you already have, BladeMail asks: Skip, Replace it, or Download a renamed copy. Pick a default in Settings → Files. |
| Themes & mini window | Settings → General: Dark, Light or "Same as Windows". A small always-on-top window with speed and progress can be shown while downloading or always (double-click it to open BladeMail). |
| History & stats | "History & stats" in the sidebar: every finished download (searchable, with Open / Folder), total downloaded, this month, today, number of files and average speed. Removing a download from the list doesn't remove it from history. |
| Media list | The extension popup lists every video/stream detected on the current page with its own Download button. |

Stream videos are saved as `.ts`, which plays in VLC, Windows Media Player and most players.
If [ffmpeg](https://ffmpeg.org) is installed and on your PATH, BladeMail converts them to `.mp4` automatically
and merges separate audio tracks.

## What it does not do (on purpose or by limitation)

- **DRM-protected video** (Netflix, Prime Video, Disney+, Spotify, Apple TV, most paid streaming): these
  are encrypted and BladeMail does not try to break that. The button is hidden on those players.
- **YouTube**: YouTube streams video and audio as separate pieces through its own player, and its terms forbid
  downloading, so the button is not shown there.
- **Encrypted HLS** (any `#EXT-X-KEY` other than `NONE`) — refused with a clear message.
- **Live streams** — only finished (on-demand) videos are saved.
- **DASH streams** (`.mpd`) — detected and listed, but not downloadable yet.
- **No silent extension install:** browsers only let you add extensions from outside their store yourself (one
  "Load unpacked" click per browser, see step 2). Firefox removes such add-ons when it restarts.
- **No auto-extract and no site logins or proxy settings** (yet).
- **Windows only.** The engine is plain Node.js, but there is no Mac or Linux installer.
- Downloads that need a POST form submit or a browser-only token may fail; Chrome is not affected in that case
  if you turn the takeover off.

## Privacy and safety

- The app listens only on `127.0.0.1:47815` (your own computer), and only accepts requests from browser
  extensions with a special header, so websites cannot add downloads behind your back.
- Nothing is sent anywhere except the download requests themselves.
- Settings and the download list are stored in `%APPDATA%\BladeMail`.

## For developers

```
app/                Electron app (main.js, engine/ = download engine, ui/ = windows)
extension/          Browser extension for Chrome, Edge, Brave, Opera, Vivaldi (Manifest V3)
extension-firefox/  Same extension for Firefox (keep in sync with extension/)
installer/          NSIS script for the Windows installer (BladeMail-Download-Manager-Setup-x.y.z.exe)
test/               Engine tests (node test/run.js, features.js, features2.js),
                    a local test server (test/server.js) and Playwright UI/extension tests
```

Run from source: install Node.js 20+, then `cd app && npm install && npm start`.

Tests: `node test/run.js`, `node test/features.js`, `node test/features2.js` (each starts its own test server on port 8099).

Build the Windows installer:

- **On GitHub (recommended):** push a version tag, for example
  `git tag v1.5.0 && git push origin v1.5.0`. The *Build Windows installer* workflow builds
  `BladeMail-Download-Manager-Setup-1.5.0.exe` on a Windows machine and attaches it to the release for that tag,
  using [RELEASE_NOTES.md](RELEASE_NOTES.md) as the description. You can also start it from the **Actions** tab
  (*Run workflow*) to get the installer as a downloadable artifact without making a release.
- **By hand on Windows:**
  1. `cd app && npm ci && npx @electron/packager . BladeMail --platform=win32 --arch=x64 --icon=assets/icon.ico --out=../dist --overwrite --asar --ignore="^/node_modules"`
  2. Copy `extension/` and `extension-firefox/` into `dist/BladeMail-win32-x64/resources/`, and `README.md` into `dist/BladeMail-win32-x64/`.
  3. Install [NSIS](https://nsis.sourceforge.io), then `cd installer && makensis blademail.nsi` → `dist/BladeMail-Download-Manager-Setup-<version>.exe`.

Downloads, settings and history are stored in the app's user-data folder (`%APPDATA%\BladeMail`), never in this repository.
