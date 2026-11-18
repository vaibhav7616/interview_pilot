// Settings and session storage in the user's AppData folder.
// API keys are encrypted with Windows DPAPI (Electron safeStorage) when available.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  anthropicKey: '',
  deepgramKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  language: 'en',
  answerStyle: 'spoken', // spoken | bullets | detailed
  autoAnswer: true,
  hideFromScreenShare: true,
  hideFromTaskbar: false,
  opacity: 0.96,
  theme: 'system', // system | dark | light
  profile: { name: '', role: '', company: '', resume: '', jobDescription: '', instructions: '' },
};

const SECRET_FIELDS = ['anthropicKey', 'deepgramKey'];

function dataDir() {
  return app.getPath('userData');
}
function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}
function sessionsDir() {
  const dir = path.join(dataDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function encrypt(value) {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'plain:' + value;
}
function decrypt(value) {
  if (!value) return '';
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  if (value.startsWith('plain:')) return value.slice(6);
  return value;
}

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    raw = {};
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    profile: { ...DEFAULT_SETTINGS.profile, ...(raw.profile || {}) },
  };
  for (const f of SECRET_FIELDS) settings[f] = decrypt(raw[f] || '');
  // Environment variables override stored keys (handy for testing).
  if (process.env.ANTHROPIC_API_KEY) settings.anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.DEEPGRAM_API_KEY) settings.deepgramKey = process.env.DEEPGRAM_API_KEY;
  return settings;
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = {
    ...current,
    ...partial,
    profile: { ...current.profile, ...(partial.profile || {}) },
  };
  const onDisk = { ...next };
  for (const f of SECRET_FIELDS) onDisk[f] = encrypt(next[f]);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(onDisk, null, 2));
  return next;
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

function saveSession(session) {
  const id = safeId(session.id);
  fs.writeFileSync(path.join(sessionsDir(), `${id}.json`), JSON.stringify(session, null, 2));
  return id;
}

function listSessions() {
  return fs
    .readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'));
        return { id: s.id, title: s.title, mode: s.mode, startedAt: s.startedAt, endedAt: s.endedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function getSession(id) {
  return JSON.parse(fs.readFileSync(path.join(sessionsDir(), `${safeId(id)}.json`), 'utf8'));
}

function deleteSession(id) {
  fs.rmSync(path.join(sessionsDir(), `${safeId(id)}.json`), { force: true });
}

module.exports = { loadSettings, saveSettings, saveSession, listSessions, getSession, deleteSession };
