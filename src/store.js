// Settings and session storage in the user's AppData folder.
// API keys are encrypted with Windows DPAPI (Electron safeStorage) when available.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Loads API keys from a .env file so they do not need to be typed into Settings.
// Looked up in the project folder (dev), next to the .exe (portable/installed), then in AppData.
// Real environment variables win over the file. Keys from .env override keys saved in Settings.
function loadEnvFile() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(path.dirname(process.execPath), '.env'),
    path.join(app.getPath('userData'), '.env'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value && !process.env[key]) process.env[key] = value;
  }
}
loadEnvFile();

const DEFAULT_SETTINGS = {
  anthropicKey: '',
  geminiKey: '',
  groqKey: '',
  deepgramKey: '',
  model: 'groq:qwen/qwen3.8-27b',
  effort: 'low',
  language: 'en',
  answerStyle: 'spoken', // spoken | bullets | detailed
  autoAnswer: true,
  hideFromScreenShare: true,
  hideFromTaskbar: false,
  opacity: 0.96,
  theme: 'system', // system | dark | light
  profile: { name: '', role: '', company: '', resume: '', jobDescription: '', instructions: '', documents: '' },
};

const SECRET_FIELDS = ['anthropicKey', 'geminiKey', 'groqKey', 'deepgramKey'];
const ENV_KEYS = { anthropicKey: 'ANTHROPIC_API_KEY', geminiKey: 'GEMINI_API_KEY', groqKey: 'GROQ_API_KEY', deepgramKey: 'DEEPGRAM_API_KEY' };

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
  // Environment variables (and .env) override stored keys.
  for (const f of SECRET_FIELDS) {
    if (process.env[ENV_KEYS[f]]) settings[f] = process.env[ENV_KEYS[f]];
  }
  return settings;
}

function readRawSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const raw = readRawSettings();
  const next = {
    ...current,
    ...partial,
    profile: { ...current.profile, ...(partial.profile || {}) },
  };
  const onDisk = { ...next };
  for (const f of SECRET_FIELDS) {
    // A key that comes from .env / the environment is not copied into settings.json.
    const fromEnv = process.env[ENV_KEYS[f]];
    onDisk[f] = fromEnv && next[f] === fromEnv ? raw[f] || '' : encrypt(next[f]);
  }
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
        return {
          id: s.id,
          title: s.title,
          mode: s.mode,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          answers: (s.answers || []).length,
          role: s.profile?.role || '',
          company: s.profile?.company || '',
          hasNotes: !!s.notes,
        };
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
