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
const Anthropic = require('@anthropic-ai/sdk');
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

function applyWindowSettings(settings) {
  if (!win) return;
  // Uses SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) on Windows 10 2004+ / Server 2022+.
  win.setContentProtection(!!settings.hideFromScreenShare);
  win.setSkipTaskbar(!!settings.hideFromTaskbar);
  win.setOpacity(Math.min(1, Math.max(0.3, Number(settings.opacity) || 1)));
}

function createWindow() {
  const settings = store.loadSettings();
  const { workArea } = screen.getPrimaryDisplay();
  const width = 540;
  const height = Math.min(780, workArea.height - 40);

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + 20,
    minWidth: 380,
    minHeight: 300,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
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
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  applyWindowSettings(settings);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Links in answers open in the normal browser, never inside the overlay.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

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

function registerShortcuts() {
  const bind = (accel, fn) => {
    if (!globalShortcut.register(accel, fn)) console.warn('Shortcut in use by another app:', accel);
  };
  bind('CommandOrControl+Shift+Space', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  bind('CommandOrControl+Shift+Enter', () => send('hotkey', 'answer'));
  bind('CommandOrControl+Shift+S', () => send('hotkey', 'screenshot'));
  bind('CommandOrControl+Shift+A', () => send('hotkey', 'toggle-auto'));
  bind('CommandOrControl+Shift+X', () => {
    if (!win) return;
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    send('click-through', clickThrough);
  });
  const step = 40;
  const move = (dx, dy) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  };
  bind('CommandOrControl+Shift+Up', () => move(0, -step));
  bind('CommandOrControl+Shift+Down', () => move(0, step));
  bind('CommandOrControl+Shift+Left', () => move(-step, 0));
  bind('CommandOrControl+Shift+Right', () => move(step, 0));
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
      if (err instanceof Anthropic.APIUserAbortError) {
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
  ipcMain.on('win:minimize', () => win && win.hide());
  ipcMain.on('win:quit', () => app.quit());
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }));
}

app.on('second-instance', () => {
  if (win) win.show();
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
