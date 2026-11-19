const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  session,
  screen,
  dialog,
  shell,
} = require('electron');
const store = require('./store');
const ai = require('./ai');
const { DeepgramSTT } = require('./stt');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let clickThrough = false;
const stt = new DeepgramSTT();
const aborts = new Map(); // requestId -> abort fn

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// The single window has two layouts:
//  - "dashboard": session setup, history and settings; a normal window centered on screen.
//  - "overlay":   the live-session toolbar + answer panel; always on top, centered near the
//                 top of the screen, and sized to its content so empty space never blocks clicks.
let windowMode = 'dashboard';
const OVERLAY_TOP_RATIO = 0.08; // overlay top edge, as a fraction of the screen height

function activeWorkArea() {
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  const display = b ? screen.getDisplayMatching(b) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function dashboardBounds(wa) {
  const width = Math.min(1040, wa.width - 60);
  const height = Math.min(740, wa.height - 60);
  return {
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
  };
}

// Hide from screen sharing: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE), Windows 10 2004+ /
// Server 2022+. Windows only honours it while the window is visible: set on a hidden window
// (at startup, or after hide → show with Ctrl+Q) it does not take effect, and the overlay
// showed up in Meet's screen share. So it is applied again every time the window is shown.
// Verified with a screen capture: 100% of the window visible before this fix, 0% after.
let hideFromShare = true;
function protectFromCapture() {
  if (win && !win.isDestroyed() && hideFromShare) win.setContentProtection(true);
}

function applyWindowSettings(settings) {
  if (!win) return;
  hideFromShare = !!settings.hideFromScreenShare;
  win.setContentProtection(hideFromShare);
  // During a live session the overlay never shows in the taskbar (where a shared screen would
  // reveal its icon and name) and has no title (Alt+Tab shows nothing readable).
  const live = windowMode === 'overlay';
  win.setSkipTaskbar(live || !!settings.hideFromTaskbar);
  win.setTitle(live ? '' : 'Interview Pilot');
  const opacity = Math.min(1, Math.max(0.3, Number(settings.opacity) || 1));
  win.setOpacity(live ? opacity : 1);
}

// Hide / show without stealing focus from the call. A hidden window keeps the session running:
// audio is still transcribed and answers still arrive, ready when it is shown again.
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else {
    win.showInactive();
    protectFromCapture();
  }
}

function setWindowMode(mode) {
  if (!win) return;
  windowMode = mode === 'overlay' ? 'overlay' : 'dashboard';
  const wa = activeWorkArea();
  if (windowMode === 'overlay') {
    const width = 780;
    const height = 140; // grows to fit the content via win:fit
    win.setResizable(false);
    win.setMinimumSize(1, 1);
    win.setBounds({
      width,
      height,
      x: slotX(overlaySlot, width, wa),
      y: Math.round(wa.y + wa.height * OVERLAY_TOP_RATIO),
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    registerSessionShortcuts();
  } else {
    win.setResizable(true);
    win.setMinimumSize(640, 480);
    win.setBounds(dashboardBounds(wa));
    win.setAlwaysOnTop(false);
    unregisterSessionShortcuts();
  }
  if (!win.isVisible()) win.show();
  applyWindowSettings(store.loadSettings()); // after show, so capture protection takes effect
}

// The overlay has exactly three positions along the top of the screen: left corner, middle,
// right corner. ‹ / › (or Ctrl+Alt+Shift+←/→) move it one position, sliding smoothly.
const SLOTS = ['left', 'center', 'right'];
const SLOT_MARGIN = 16;
let overlaySlot = 'center';
let slideTimer = null;

function slotX(slot, width, wa) {
  if (slot === 'left') return Math.round(wa.x + SLOT_MARGIN);
  if (slot === 'right') return Math.round(wa.x + wa.width - width - SLOT_MARGIN);
  return Math.round(wa.x + (wa.width - width) / 2);
}

// Slides the window to x over ~280 ms with an ease-out curve (Windows has no animated move).
function slideTo(targetX) {
  if (!win) return;
  clearInterval(slideTimer);
  const startX = win.getBounds().x;
  const t0 = Date.now();
  const DURATION = 280;
  slideTimer = setInterval(() => {
    const stop = () => {
      clearInterval(slideTimer);
      slideTimer = null;
    };
    if (!win || win.isDestroyed()) return stop();
    const t = Math.min(1, (Date.now() - t0) / DURATION);
    const eased = 1 - Math.pow(1 - t, 3);
    const b = win.getBounds();
    win.setBounds({ ...b, x: Math.round(startX + (targetX - startX) * eased) });
    if (t >= 1) stop();
  }, 12);
}

function moveSlot(step) {
  if (!win || windowMode !== 'overlay') return;
  const i = Math.max(0, Math.min(SLOTS.length - 1, SLOTS.indexOf(overlaySlot) + step));
  if (SLOTS[i] === overlaySlot) return;
  overlaySlot = SLOTS[i];
  slideTo(slotX(overlaySlot, win.getBounds().width, activeWorkArea()));
}

// Overlay only: resize to the rendered content, staying in its position (left / middle / right)
// and inside the screen.
function fitOverlay({ width, height }) {
  if (!win || windowMode !== 'overlay') return;
  const wa = activeWorkArea();
  const b = win.getBounds();
  const w = Math.round(Math.min(Math.max(width, 420), wa.width - 20));
  const h = Math.round(Math.min(Math.max(height, 60), wa.y + wa.height - b.y));
  // while sliding, keep the current x; otherwise snap to the slot for the (possibly new) width
  const x = slideTimer && w === b.width ? b.x : slotX(overlaySlot, w, wa);
  if (w !== b.width || h !== b.height || x !== b.x) win.setBounds({ x, y: b.y, width: w, height: h });
}

function createWindow() {
  const settings = store.loadSettings();
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;

  win = new BrowserWindow({
    ...dashboardBounds(wa), // opens centered on the screen
    minWidth: 640,
    minHeight: 480,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'Interview Pilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true);
  applyWindowSettings(settings);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Every time the window becomes visible (startup, Ctrl+Q, hide button, second launch).
  win.on('show', protectFromCapture);
  win.on('restore', protectFromCapture);

  // Links in answers open in the normal browser, never inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // The window title is managed here (blank during a session), not by the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault());

  win.on('closed', () => {
    win = null;
  });
}

// getDisplayMedia() in the renderer is answered here: no picker, whole screen,
// and on Windows/macOS the system audio loopback (what the call sounds like).
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const supportsLoopback = process.platform === 'win32' || process.platform === 'darwin';
      callback(supportsLoopback ? { video: sources[0], audio: 'loopback' } : { video: sources[0] });
    } catch (err) {
      console.error('display media error', err);
      callback({});
    }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission));
  });
}

function bindShortcut(accel, fn) {
  if (!globalShortcut.register(accel, fn)) console.warn('Shortcut in use by another app:', accel);
}

function setClickThrough(on) {
  if (!win) return;
  clickThrough = on;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  send('click-through', clickThrough);
}

// Always available.
function registerShortcuts() {
  bindShortcut('CommandOrControl+Q', toggleWindow);
  bindShortcut('CommandOrControl+Shift+Space', toggleWindow);
}

// Only while the live overlay is showing, so they never steal keys from other apps otherwise.
// Chosen to avoid common editor shortcuts (Ctrl+Shift+Arrows selects words in code editors).
const SESSION_SHORTCUTS = {
  'CommandOrControl+Shift+Enter': () => send('hotkey', 'answer'),
  'CommandOrControl+Shift+S': () => send('hotkey', 'screenshot'),
  'CommandOrControl+Shift+A': () => send('hotkey', 'toggle-auto'),
  'CommandOrControl+Shift+K': () => {
    if (!win) return;
    win.show();
    win.focus();
    protectFromCapture();
    send('hotkey', 'chat');
  },
  'CommandOrControl+Shift+Backspace': () => send('hotkey', 'clear'),
  'CommandOrControl+Alt+Left': () => send('hotkey', 'prev'),
  'CommandOrControl+Alt+Right': () => send('hotkey', 'next'),
  'CommandOrControl+Alt+Up': () => send('hotkey', 'scroll-up'),
  'CommandOrControl+Alt+Down': () => send('hotkey', 'scroll-down'),
  'CommandOrControl+Shift+X': () => setClickThrough(!clickThrough),
  // Move the overlay between left corner / middle / right corner: Ctrl+< and Ctrl+> (the comma
  // and full-stop keys, with or without Shift). Not Ctrl+Arrows: those jump words in every editor.
  'CommandOrControl+,': () => moveSlot(-1),
  'CommandOrControl+.': () => moveSlot(1),
  'CommandOrControl+Shift+,': () => moveSlot(-1),
  'CommandOrControl+Shift+.': () => moveSlot(1),
};
let sessionShortcutsOn = false;

function registerSessionShortcuts() {
  if (sessionShortcutsOn) return;
  for (const [accel, fn] of Object.entries(SESSION_SHORTCUTS)) bindShortcut(accel, fn);
  sessionShortcutsOn = true;
}

function unregisterSessionShortcuts() {
  if (!sessionShortcutsOn) return;
  for (const accel of Object.keys(SESSION_SHORTCUTS)) globalShortcut.unregister(accel);
  sessionShortcutsOn = false;
  if (clickThrough) setClickThrough(false);
}

async function captureScreenJpeg() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  let w = Math.round(display.size.width * scale);
  let h = Math.round(display.size.height * scale);
  const maxSide = 1920;
  if (Math.max(w, h) > maxSide) {
    const r = maxSide / Math.max(w, h);
    w = Math.round(w * r);
    h = Math.round(h * r);
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
  const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Could not capture the screen.');
  return src.thumbnail.toJPEG(85).toString('base64');
}

function setupIpc() {
  ipcMain.handle('settings:get', () => store.loadSettings());
  ipcMain.handle('settings:save', (_e, partial) => {
    const next = store.saveSettings(partial || {});
    applyWindowSettings(next);
    return next;
  });

  // ---- Speech to text ----
  stt.on('transcript', (t) => send('stt:transcript', t));
  stt.on('utteranceEnd', (u) => send('stt:utteranceEnd', u));
  stt.on('speechStarted', (u) => send('stt:speechStarted', u));
  stt.on('status', (s) => send('stt:status', s));
  stt.on('error', (err) => send('stt:status', { state: 'error', message: err.message }));

  ipcMain.handle('stt:start', () => {
    const settings = store.loadSettings();
    stt.stop();
    stt.start({ apiKey: settings.deepgramKey, language: settings.language });
    ai.warmup(settings);
    return true;
  });
  ipcMain.on('stt:audio', (_e, chunk) => {
    stt.sendAudio(Buffer.from(chunk));
  });
  ipcMain.handle('stt:stop', () => {
    stt.stop();
    return true;
  });

  // ---- AI streaming ----
  ipcMain.handle('ai:stream', async (_e, { requestId, kind, payload }) => {
    const settings = store.loadSettings();
    try {
      let finalPayload = payload || {};
      if (kind === 'screenshot') {
        finalPayload = { ...finalPayload, imageBase64: await captureScreenJpeg() };
      }
      const text = await ai.streamText(
        kind,
        finalPayload,
        settings,
        (delta) => send('ai:delta', { requestId, text: delta }),
        (abortFn) => aborts.set(requestId, abortFn),
      );
      send('ai:done', { requestId, text });
      return { ok: true };
    } catch (err) {
      if (ai.isAbortError(err)) {
        send('ai:done', { requestId, aborted: true });
        return { ok: false, aborted: true };
      }
      const message = ai.describeError(err);
      send('ai:error', { requestId, message });
      return { ok: false, message };
    } finally {
      aborts.delete(requestId);
    }
  });
  ipcMain.handle('ai:cancel', (_e, requestId) => {
    const fn = aborts.get(requestId);
    if (fn) fn();
    return true;
  });

  // ---- Profile documents ----
  ipcMain.handle('profile:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a resume / document',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const file = res.filePaths[0];
    const ext = path.extname(file).toLowerCase();
    try {
      let text = '';
      if (ext === '.pdf') {
        text = await ai.extractPdfText(fs.readFileSync(file), store.loadSettings());
      } else if (ext === '.docx') {
        const mammoth = require('mammoth');
        text = (await mammoth.extractRawText({ path: file })).value;
      } else {
        text = fs.readFileSync(file, 'utf8');
      }
      return { text: text.trim(), name: path.basename(file) };
    } catch (err) {
      return { error: ai.describeError(err) };
    }
  });

  // ---- Sessions ----
  ipcMain.handle('sessions:save', (_e, s) => store.saveSession(s));
  ipcMain.handle('sessions:list', () => store.listSessions());
  ipcMain.handle('sessions:get', (_e, id) => store.getSession(id));
  ipcMain.handle('sessions:delete', (_e, id) => store.deleteSession(id));
  ipcMain.handle('sessions:export', async (_e, { title, markdown }) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${(title || 'session').replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, markdown);
    return true;
  });

  // ---- Window ----
  ipcMain.on('win:mode', (_e, mode) => setWindowMode(mode));
  ipcMain.on('win:fit', (_e, size) => fitOverlay(size || {}));
  ipcMain.on('win:click-through', (_e, on) => setClickThrough(!!on));
  ipcMain.on('win:minimize', () => win && win.hide());
  ipcMain.on('win:quit', () => app.quit());
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));
}

app.on('second-instance', () => {
  if (!win) return;
  win.show();
  win.focus();
  protectFromCapture();
});

app.whenReady().then(() => {
  setupDisplayMedia();
  setupIpc();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stt.stop();
});

app.on('window-all-closed', () => app.quit());
