/* global api, marked, DOMPurify */
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const MODE_LABEL = { interview: 'Interview', meeting: 'Regular call', mock: 'Mock interview' };
const MODE_ICON = { interview: 'briefcase', meeting: 'users', mock: 'target' };
const KIND_LABEL = { answer: 'Answer', chat: 'Chat', screenshot: 'Screenshot', mock: 'Interviewer' };

// Options shared by every <select data-setting="…"> (setup page, settings page, overlay menu).
// Languages: all accepted by Deepgram nova-3 (verified against the API).
const LANGUAGES = [
  ['multi', 'Auto-detect (multilingual)'], ['en', 'English'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'], ['en-AU', 'English (Australia)'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['bn', 'Bengali'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['ur', 'Urdu'], ['ar', 'Arabic'],
  ['bg', 'Bulgarian'], ['ca', 'Catalan'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'],
  ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['et', 'Estonian'], ['tl', 'Filipino'],
  ['fi', 'Finnish'], ['fr', 'French'], ['fr-CA', 'French (Canada)'], ['de', 'German'], ['de-CH', 'German (Switzerland)'],
  ['el', 'Greek'], ['he', 'Hebrew'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['ms', 'Malay'], ['no', 'Norwegian'], ['fa', 'Persian'],
  ['pl', 'Polish'], ['pt', 'Portuguese'], ['pt-BR', 'Portuguese (Brazil)'], ['ro', 'Romanian'], ['ru', 'Russian'],
  ['sr', 'Serbian'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['es', 'Spanish'], ['es-419', 'Spanish (Latin America)'],
  ['sv', 'Swedish'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['vi', 'Vietnamese'],
];
const MODELS = [
  ['Groq (free tier, fastest)', [['groq:qwen/qwen3.8-27b', 'Qwen 3.8 27B on Groq (fastest)'], ['groq:openai/gpt-oss-120b', 'GPT-OSS 120B on Groq'], ['groq:openai/gpt-oss-20b', 'GPT-OSS 20B on Groq']]],
  ['Google Gemini (free tier)', [['gemini-flash-lite-latest', 'Gemini Flash-Lite'], ['gemini-flash-latest', 'Gemini Flash']]],
  ['Anthropic Claude', [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5']]],
];
const STYLES = [
  ['bullets', 'Bullet points'],
  ['spoken', 'Script + bullets'],
  ['detailed', 'Full script'],
];

let settings = null;
let mode = 'interview'; // interview | meeting | mock

// ---------------------------------------------------------------- stealth: nothing outside the protected window
// The window is excluded from screen capture, but a few things Chromium/Windows draw in their
// own separate windows are not: hover tooltips (title="…") and native <select> lists (verified
// with a screen capture). So tooltips become screen-reader labels, and dropdowns are drawn in
// the page. The pointer stays the normal arrow (see styles.css).

function stripTooltip(el) {
  const t = el.getAttribute('title');
  if (t === null) return;
  el.setAttribute('aria-label', t);
  el.removeAttribute('title');
}

function startTooltipStripper() {
  $$('[title]').forEach(stripTooltip);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') stripTooltip(m.target);
      else {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          stripTooltip(n);
          n.querySelectorAll('[title]').forEach(stripTooltip);
        });
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
}

const customSelects = [];

function closeAllSelects() {
  customSelects.forEach((s) => s._cs.close());
}

function refreshSelects() {
  customSelects.forEach((s) => s._cs.update());
}

// Replaces a native <select> with an in-page dropdown. The <select> stays (hidden) as the source
// of truth: its options, value and change handlers keep working unchanged.
function enhanceSelect(sel) {
  if (sel._cs) return;
  const wrap = document.createElement('div');
  wrap.className = 'cs';
  wrap.innerHTML = `<button type="button" class="cs-btn"><span class="cs-label"></span>${icon('chev-down')}</button>`;
  sel.after(wrap);
  sel.classList.add('cs-native');
  const btn = wrap.firstElementChild;
  const label = btn.querySelector('.cs-label');
  let list = null;
  let active = -1;
  const opts = () => [...sel.options];

  const update = () => (label.textContent = sel.selectedOptions[0]?.textContent || '');
  const close = () => {
    if (!list) return;
    list.remove();
    list = null;
    wrap.classList.remove('open');
    fitOverlay();
  };
  const choose = (o) => {
    close();
    if (o && sel.value !== o.value) {
      sel.value = o.value;
      update();
      sel.dispatchEvent(new Event('change'));
    }
  };
  const highlight = () => {
    list.querySelectorAll('.cs-opt').forEach((el) => el.classList.toggle('active', +el.dataset.i === active));
    list.querySelector('.cs-opt.active')?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => {
    closeAllSelects();
    list = document.createElement('div');
    list.className = 'cs-list';
    let html = '';
    let group = null;
    opts().forEach((o, i) => {
      const g = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
      if (g && g !== group) html += `<div class="cs-group">${esc(g)}</div>`;
      group = g;
      html += `<div class="cs-opt${o.selected ? ' selected' : ''}" data-i="${i}">${esc(o.textContent)}</div>`;
    });
    list.innerHTML = html;
    wrap.appendChild(list);
    wrap.classList.add('open');
    if (!wrap.closest('.ov')) {
      // dashboard: open upwards when there is no room below
      const r = list.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8 && wrap.getBoundingClientRect().top > r.height + 8) list.classList.add('up');
    }
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    active = sel.selectedIndex;
    list.onmousedown = (e) => e.preventDefault(); // keep focus on the button
    list.onclick = (e) => {
      const el = e.target.closest('.cs-opt');
      if (el) choose(opts()[+el.dataset.i]);
    };
    fitOverlay();
  };

  btn.onclick = () => (list ? close() : open());
  btn.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list) open();
      active = Math.max(0, Math.min(sel.options.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      highlight();
    } else if (e.key === 'Enter' && list && active >= 0) {
      e.preventDefault();
      choose(opts()[active]);
    } else if (e.key === 'Escape') close();
  };
  sel._cs = { update, close };
  customSelects.push(sel);
  update();
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.cs')) closeAllSelects();
});

// ---------------------------------------------------------------- feedback
function toast(message, kind = 'success', ms = 3200) {
  const t = $('toast');
  $('toastText').textContent = message;
  $('toastIcon').innerHTML = `<use href="#i-${kind === 'error' || kind === 'info' ? 'alert' : 'check'}"/>`;
  t.className = `toast ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? Math.max(ms, 6000) : ms);
}

function setStatus(state, text) {
  const s = $('status');
  s.className = 'status' + (state === 'on' ? ' live' : state === 'warn' ? ' connecting' : state === 'err' ? ' error' : '');
  const label = text || { on: 'Listening', warn: 'Connecting', err: 'Connection problem', off: 'Ready' }[state] || 'Ready';
  $('statusText').textContent = label;
  $('ovTimer').title = label;
  $('ovTimer').style.color = state === 'err' ? '#ff8a8d' : state === 'warn' ? '#f0b45a' : '';
}

function switchView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistoryList();
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// Key needed for the selected model: Groq, Gemini or Anthropic.
function aiKeyMissing(s = settings) {
  if (!s) return true;
  const m = String(s.model || '');
  if (m.startsWith('groq:')) return !s.groqKey;
  return m.startsWith('gemini') ? !s.geminiKey : !s.anthropicKey;
}

function updateKeysCallout() {
  $('keysCallout').classList.toggle('hidden', !!(settings && !aiKeyMissing() && settings.deepgramKey));
}

// ---------------------------------------------------------------- window layout (dashboard / overlay)
let windowMode = 'dashboard';
let expanded = false;

function enterOverlay() {
  windowMode = 'overlay';
  document.body.className = 'mode-overlay';
  api.setWindowMode('overlay');
  $('liveBanner').classList.add('hidden');
  requestAnimationFrame(fitOverlay);
}

function enterDashboard() {
  windowMode = 'dashboard';
  document.body.className = 'mode-dashboard';
  api.setWindowMode('dashboard');
  $('liveBanner').classList.toggle('hidden', !sess);
}

// The overlay window is exactly as tall as its content, so empty space never blocks clicks.
function fitOverlay() {
  if (windowMode !== 'overlay') return;
  const h = Math.ceil(document.body.getBoundingClientRect().height);
  const width = expanded ? 1040 : 780;
  if (h === fitOverlay.h && width === fitOverlay.w) return; // only resize when something changed
  fitOverlay.h = h;
  fitOverlay.w = width;
  api.fitWindow({ width, height: h });
}

function setExpanded(on) {
  expanded = on;
  const max = on ? Math.max(420, (window.screen.availHeight || 900) - 300) : 420;
  $('overlay').style.setProperty('--ov-ans-max', `${max}px`);
  $('oExpand').innerHTML = icon(on ? 'collapse' : 'expand');
  $('oExpand').title = on ? 'Shrink' : 'Expand';
  fitOverlay();
}

// ---------------------------------------------------------------- settings
function fillSelect(sel, key) {
  if (key === 'language') sel.innerHTML = LANGUAGES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  else if (key === 'model') {
    sel.innerHTML = MODELS.map(([g, opts]) => `<optgroup label="${esc(g)}">${opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</optgroup>`).join('');
  } else if (key === 'answerStyle') sel.innerHTML = STYLES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
}

function syncSettingControls() {
  $$('[data-setting]').forEach((el) => {
    const v = settings[el.dataset.setting];
    if (v !== undefined) el.value = v;
  });
  const op = settings.opacity;
  $('sOpacity').value = op;
  $('ovOpacity').value = op;
  $('opacityValue').textContent = `${Math.round(op * 100)}%`;
  refreshSelects();
}

async function saveSetting(key, value) {
  settings = await api.saveSettings({ [key]: value });
  syncSettingControls();
  updateKeysCallout();
  // Language is fixed per transcription stream, so reconnect with the new one.
  if (key === 'language' && sess && mode !== 'mock') {
    await api.sttStart();
    toast(`Language: ${(LANGUAGES.find(([v]) => v === value) || [, value])[1]}`, 'info', 1800);
  } else {
    toast('Saved', 'success', 1200);
  }
}

async function loadSettingsIntoForms() {
  settings = await api.getSettings();
  const p = settings.profile;
  $('pName').value = p.name;
  $('pRole').value = p.role;
  $('pCompany').value = p.company;
  $('pResume').value = p.resume;
  $('pJD').value = p.jobDescription;
  $('pDocs').value = p.documents || '';
  $('pInstr').value = p.instructions;
  updateInstrCount();

  $('sGroq').value = settings.groqKey || '';
  $('sGemini').value = settings.geminiKey || '';
  $('sAnthropic').value = settings.anthropicKey;
  $('sDeepgram').value = settings.deepgramKey;
  $('sHideShare').checked = settings.hideFromScreenShare;
  $('sHideTaskbar').checked = settings.hideFromTaskbar;
  $('sTheme').value = settings.theme || 'system';
  refreshSelects();
  $('autoToggle').checked = settings.autoAnswer;
  syncSettingControls();
  updateAutoBadge();
  applyTheme(settings.theme);
  updateKeysCallout();
}

function updateInstrCount() {
  $('instrCount').textContent = `${$('pInstr').value.length.toLocaleString()} / 20,000`;
}

function profileFromForm() {
  return {
    name: $('pName').value.trim(),
    role: $('pRole').value.trim(),
    company: $('pCompany').value.trim(),
    resume: $('pResume').value.trim(),
    jobDescription: $('pJD').value.trim(),
    documents: $('pDocs').value.trim(),
    instructions: $('pInstr').value.slice(0, 20000),
  };
}

let saveTimer = null;
function autosaveFields(message = 'Settings saved') {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = await api.saveSettings({
      groqKey: $('sGroq').value.trim(),
      geminiKey: $('sGemini').value.trim(),
      anthropicKey: $('sAnthropic').value.trim(),
      deepgramKey: $('sDeepgram').value.trim(),
      hideFromScreenShare: $('sHideShare').checked,
      hideFromTaskbar: $('sHideTaskbar').checked,
      theme: $('sTheme').value,
    });
    applyTheme(settings.theme);
    updateKeysCallout();
    toast(message, 'success', 1600);
  }, 350);
}

// ---------------------------------------------------------------- session state
let sess = null;
const live = {
  audioCtx: null,
  streams: [],
  worklet: null,
  timerInt: null,
  openLine: { 0: null, 1: null },
  interim: { 0: '', 1: '' },
  questionBuf: '',
  detectTimer: null,
  activeAnswerId: null,
  mockHistory: [],
  mockAnswerBuf: '',
  mockSilenceTimer: null,
  speaking: false,
  mockFinished: false,
  stripFrom: 0, // transcript index the strip starts at (moved by "Clear")
  lastAuto: null, // { id, question, t } of the latest auto-answer, for joining question pieces
};

const SPEAKER = (ch) => (ch === 0 ? 'them' : 'me');
const theirLabel = (m = mode) => (m === 'meeting' ? 'Them' : 'Interviewer');

// ---------------------------------------------------------------- audio indicators
function setLevel(ch, level) {
  const on = level > 0.015;
  $(`ind${ch}`).classList.toggle('active', on);
  if (ch === 0) $('ovListen').classList.toggle('hot', on);
}

// ---------------------------------------------------------------- transcript UI
function lineHtml(l, m = mode, interim = false) {
  return `<div class="line ${l.speaker}${interim ? ' interim' : ''}"><span class="who">${l.speaker === 'me' ? 'You' : theirLabel(m)}</span><span class="txt">${esc(l.text)}</span></div>`;
}

const CHIP_WORDS = 3;
const MAX_CHIPS = 16;
function chipsFor(text, cls) {
  const words = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += CHIP_WORDS) out.push(`<span class="chip ${cls}">${esc(words.slice(i, i + CHIP_WORDS).join(' '))}</span>`);
  return out;
}

let renderQueued = false;
function renderTranscript() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!sess) return;
    // strip of chips: latest words, newest on the right
    let chips = [];
    for (const l of sess.transcript.slice(Math.max(live.stripFrom, sess.transcript.length - 4))) chips.push(...chipsFor(l.text, l.speaker));
    for (const ch of [0, 1]) if (live.interim[ch]) chips.push(...chipsFor(live.interim[ch], `${SPEAKER(ch)} interim`));
    chips = chips.slice(-MAX_CHIPS);
    $('chips').innerHTML = chips.length ? chips.join('') : '<span class="chip-empty">Listening…</span>';

    // full transcript panel (only when open)
    if (!$('ovTranscript').classList.contains('hidden')) {
      const box = $('transcript');
      const atBottom = box.parentElement.scrollHeight - box.parentElement.scrollTop - box.parentElement.clientHeight < 30;
      const lines = sess.transcript.slice(-120).map((l) => lineHtml(l));
      for (const ch of [0, 1]) if (live.interim[ch]) lines.push(lineHtml({ speaker: SPEAKER(ch), text: live.interim[ch] }, mode, true));
      box.innerHTML = lines.join('');
      if (atBottom) box.parentElement.scrollTop = box.parentElement.scrollHeight;
    }
  });
}

function addFinal(ch, text) {
  const speaker = SPEAKER(ch);
  const idx = live.openLine[ch];
  if (idx !== null && sess.transcript[idx] && sess.transcript[idx].speaker === speaker && idx === sess.transcript.length - 1) {
    sess.transcript[idx].text += ' ' + text;
  } else {
    sess.transcript.push({ speaker, text, t: Date.now() });
    live.openLine[ch] = sess.transcript.length - 1;
  }
}

// ---------------------------------------------------------------- question detection
const Q_START =
  /^(what|why|how|when|where|which|who|whom|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|tell me|walk me|describe|explain|give me|talk (me )?(about|through)|share|imagine|suppose|design|write|implement|solve|compare|define|list)\b/i;
const Q_ANY =
  /\b(tell me about|walk me through|can you|could you|would you|how would you|what would you|why did you|have you ever|what is|what are|what's|explain|describe|i want you to|i'd like you to|i would like you to|let's (write|create|build|design|implement|code|see)|(write|create|build|implement|set up|configure|fix|debug|optimi[sz]e|refactor|show me) (a|an|the|me|us|some|this|that|your)\b)/i;

function looksLikeQuestion(text) {
  const t = text.trim();
  if (t.split(/\s+/).length < 3) return false;
  if (t.includes('?')) return true;
  const sentences = t.split(/(?<=[.!?])\s+/).slice(-3);
  return sentences.some((s) => Q_START.test(s.trim())) || Q_ANY.test(t);
}

// Fires the auto-answer once the interviewer has really finished. Live speech arrives in
// pieces ("Walk me through…" pause "…a time you disagreed with your manager"), so:
//  - a piece ending in "?" is answered almost at once;
//  - otherwise we wait for the end of the utterance (about 1 s of silence);
//  - never while the interviewer is still mid-sentence (interim text pending).
function scheduleDetection(delay) {
  clearTimeout(live.detectTimer);
  live.detectTimer = setTimeout(() => {
    if (!sess || mode === 'mock') return;
    if (live.interim[0]) return; // still talking; the next final result reschedules
    const q = live.questionBuf.trim();
    if (!q || !$('autoToggle').checked) return;
    const continuing = isContinuation(live.lastAuto, q);
    if (looksLikeQuestion(q) || continuing) {
      live.questionBuf = '';
      askAnswer(q, true);
    }
  }, delay);
}

// If the interviewer keeps talking right after an auto-answer started (and the candidate has
// not replied yet), the new words are part of the same question: re-ask with the whole thing
// and replace the half-question answer.
const CONTINUATION_MS = 10000;

// The new piece continues the previous question only if that question was clearly unfinished
// (no "?" at the end) and the new piece does not start like a question of its own.
function isContinuation(prev, piece) {
  if (!prev || Date.now() - prev.t > CONTINUATION_MS || !byId.has(prev.id)) return false;
  if (/\?\s*$/.test(prev.question)) return false;
  return !Q_START.test(piece.trim()) && !/^(i want you|i'd like you|i would like you|let's|okay|ok|so|now|next|alright|great)\b/i.test(piece.trim());
}

// ---------------------------------------------------------------- STT events
api.onTranscript(({ channel, text, isFinal, speechFinal }) => {
  if (!sess) return;
  const ch = channel === 1 ? 1 : 0;
  if (mode === 'mock' && live.speaking) return;

  if (isFinal) {
    live.interim[ch] = '';
    if (text) {
      addFinal(ch, text);
      if (mode === 'mock') {
        if (ch === 1) onMockSpeech(text);
      } else if (ch === 0) {
        live.questionBuf += ' ' + text;
        if (live.questionBuf.length > 2000) live.questionBuf = live.questionBuf.slice(-2000);
      } else {
        // The candidate is answering: what the interviewer says next is a new question.
        live.lastAuto = null;
        if (text.split(/\s+/).length >= 6 && !looksLikeQuestion(live.questionBuf)) live.questionBuf = '';
      }
    }
    if (speechFinal) {
      live.openLine[ch] = null;
      // A question mark means the question is complete: answer at once. Otherwise give the
      // interviewer a moment to finish the sentence (utterance end usually fires first).
      if (ch === 0) scheduleDetection(/\?\s*$/.test(live.questionBuf.trim()) ? 120 : 800);
    }
  } else {
    live.interim[ch] = text;
    if (ch === 0) clearTimeout(live.detectTimer);
  }
  renderTranscript();
});

api.onUtteranceEnd(({ channel }) => {
  if (!sess) return;
  const ch = channel === 1 ? 1 : 0;
  live.openLine[ch] = null;
  live.interim[ch] = '';
  if (ch === 0) scheduleDetection(0);
  if (ch === 1 && mode === 'mock') armMockSilence();
  renderTranscript();
});

api.onSpeechStarted(({ channel }) => {
  if (channel === 0) clearTimeout(live.detectTimer);
  if (channel === 1 && mode === 'mock') clearTimeout(live.mockSilenceTimer);
});

api.onSttStatus((s) => {
  if (!sess) return;
  if (s.state === 'connected') setStatus('on', mode === 'mock' && live.speaking ? 'Interviewer speaking' : undefined);
  else if (s.state === 'connecting') setStatus('warn');
  else if (s.state === 'reconnecting') setStatus('warn', 'Reconnecting');
  else if (s.state === 'error') {
    setStatus('err');
    toast(s.message || 'Transcription error', 'error');
  }
});

// ---------------------------------------------------------------- answers (overlay panel)
// Every AI response (answer, chat, screenshot, mock turn) is one item; the panel shows one
// at a time and ←/→ browse them, like flipping through cards.
const answers = [];
const byId = new Map();
let current = -1;
let answerRaf = 0;

function addAnswer(kind, question, onDone) {
  const item = { id: uid(), kind, question, text: '', shown: 0, t: Date.now(), status: 'loading', rating: 0, onDone };
  answers.push(item);
  byId.set(item.id, item);
  while (answers.length > 50) byId.delete(answers.shift().id);
  current = answers.length - 1;
  $('ovCard').scrollTop = 0;
  renderAnswer();
  return item.id;
}

// Safety net for the most obvious "written by AI" punctuation in the prose of an answer:
// em/en dashes become commas, semicolons become full stops. Code (fenced blocks, including one
// still streaming in, and `inline code`) is never touched.
function tidy(text) {
  return String(text || '')
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part
        .replace(/\s*[—–]\s*/g, ', ')
        .replace(/;\s+([a-z])/g, (_, c) => '. ' + c.toUpperCase())
        .replace(/;(\s|$)/g, '.$1');
    })
    .join('');
}

// Removes an answer (used when a half question is replaced by the full one).
function removeAnswer(id) {
  const item = byId.get(id);
  if (!item) return;
  if (item.status === 'loading') api.aiCancel(id);
  byId.delete(id);
  answers.splice(answers.indexOf(item), 1);
  if (sess) sess.answers = sess.answers.filter((a) => a.id !== id);
  if (current >= answers.length) current = answers.length - 1;
}

// Text is revealed smoothly: each frame shows a share of what has arrived but is not yet on
// screen, so a big chunk from the server flows in over ~0.3 s instead of jumping, and the
// display never falls behind the stream.
function revealStep(item) {
  const backlog = item.text.length - item.shown;
  if (backlog <= 0) return false;
  item.shown = Math.min(item.text.length, item.shown + Math.max(8, Math.ceil(backlog / 5)));
  return item.shown < item.text.length;
}

// Code blocks get a header with the language (dockerfile, yaml, sql, …) and a Copy button.
const LANG_NAMES = {
  dockerfile: 'Dockerfile', docker: 'Dockerfile', yaml: 'YAML', yml: 'YAML', sql: 'SQL', mysql: 'SQL', postgresql: 'SQL', pgsql: 'SQL', plsql: 'PL/SQL',
  bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Shell', console: 'Terminal', powershell: 'PowerShell', ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', py: 'Python', python: 'Python',
  json: 'JSON', jsonc: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS', ini: 'INI', toml: 'TOML', properties: 'Properties', env: '.env', dotenv: '.env',
  hcl: 'Terraform (HCL)', terraform: 'Terraform', tf: 'Terraform', groovy: 'Groovy', jenkinsfile: 'Jenkinsfile', makefile: 'Makefile', make: 'Makefile',
  nginx: 'nginx', apache: 'Apache', apacheconf: 'Apache', systemd: 'systemd', cron: 'crontab', crontab: 'crontab', gitignore: '.gitignore',
  graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf', protobuf: 'Protobuf', ruby: 'Ruby', rb: 'Ruby', vagrantfile: 'Vagrantfile', jinja: 'Jinja', j2: 'Jinja',
  java: 'Java', kotlin: 'Kotlin', kt: 'Kotlin', scala: 'Scala', go: 'Go', golang: 'Go', rust: 'Rust', rs: 'Rust', c: 'C', cpp: 'C++', 'c++': 'C++',
  csharp: 'C#', cs: 'C#', fsharp: 'F#', php: 'PHP', swift: 'Swift', dart: 'Dart', r: 'R', lua: 'Lua', perl: 'Perl', elixir: 'Elixir', haskell: 'Haskell',
  regex: 'Regex', diff: 'Diff', text: 'Text', plaintext: 'Text', promql: 'PromQL', rego: 'Rego', bicep: 'Bicep', nix: 'Nix', cue: 'CUE',
};
function decorateCode(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const lang = ((code && code.className.match(/language-(\S+)/)) || [])[1] || '';
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    wrap.innerHTML = `<div class="code-bar"><span>${esc(LANG_NAMES[lang.toLowerCase()] || lang || 'Code')}</span><button class="code-copy" data-copy title="Copy code">${icon('copy')}Copy</button></div>`;
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  });
}

let lastHtml = '';
function drawAnswer() {
  answerRaf = 0;
  const item = answers[current];
  $('ovCard').classList.toggle('hidden', !item);
  $('ovEmpty').classList.toggle('hidden', !!item);
  $('ovPos').textContent = answers.length ? `${current + 1} / ${answers.length}` : '';
  $('oPrev').disabled = current <= 0;
  $('oNext').disabled = current >= answers.length - 1;
  let more = false;
  if (item) {
    const card = $('ovCard');
    card.classList.toggle('loading', item.status === 'loading');
    card.classList.toggle('error', item.status === 'error');
    $('ovQ').textContent = item.question;
    $('ovKind').textContent = item.status === 'error' ? 'Error' : KIND_LABEL[item.kind] || item.kind;
    $('ovTime').textContent = clock(item.t);
    if (item.status === 'error') {
      $('ovA').textContent = item.text;
      lastHtml = '';
    } else {
      more = revealStep(item);
      const html = md(tidy(item.text.slice(0, item.shown)));
      if (html !== lastHtml) {
        lastHtml = html;
        $('ovA').innerHTML = html;
        decorateCode($('ovA'));
      }
    }
    $('oUp').classList.toggle('on', item.rating === 1);
    $('oDown').classList.toggle('on', item.rating === -1);
    $('oUp').classList.toggle('hidden', item.status !== 'done');
    $('oDown').classList.toggle('hidden', item.status !== 'done');
  }
  fitOverlay();
  if (more) renderAnswer();
}

function renderAnswer() {
  if (!answerRaf) answerRaf = requestAnimationFrame(drawAnswer);
}

// Slow, smooth scrolling for long answers. Each press (or each key-repeat while the shortcut is
// held) moves the target a little; the view glides towards it at a fixed, readable speed
// (time-based, so the same on 60 Hz and 144 Hz screens) instead of jumping.
const SCROLL_STEP = 60; // px added per press / repeat
const SCROLL_SPEED = 220; // px per second, at most
const SCROLL_LEAD = 90; // while held, the target stays at most this far ahead of the view
const scroller = { target: null, pos: 0, raf: 0, last: 0 };

function slowScroll(dy) {
  const el = $('ovCard');
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  if (scroller.target === null) {
    scroller.pos = el.scrollTop;
    scroller.target = el.scrollTop;
  }
  // holding the key keeps adding; cap how far ahead it gets so it stops soon after release
  const ahead = Math.max(-SCROLL_LEAD, Math.min(SCROLL_LEAD, scroller.target - scroller.pos + dy));
  scroller.target = Math.max(0, Math.min(max, scroller.pos + ahead));
  if (scroller.raf) return;
  scroller.last = performance.now();
  const step = (now) => {
    const dt = Math.min(64, now - scroller.last);
    scroller.last = now;
    const diff = scroller.target - scroller.pos;
    if (Math.abs(diff) < 0.5) {
      el.scrollTop = Math.round(scroller.target);
      scroller.raf = 0;
      scroller.target = null;
      return;
    }
    // ease in the last few pixels, otherwise a steady speed
    const move = Math.min(Math.abs(diff), Math.max((SCROLL_SPEED * dt) / 1000 * Math.min(1, Math.abs(diff) / 20), 0.5));
    scroller.pos += Math.sign(diff) * move;
    el.scrollTop = Math.round(scroller.pos);
    scroller.raf = requestAnimationFrame(step);
  };
  scroller.raf = requestAnimationFrame(step);
}

// Press and hold a scroll button to keep scrolling slowly.
function holdToScroll(btn, dir) {
  let timer = null;
  const stop = () => clearInterval(timer);
  btn.onmousedown = () => {
    slowScroll(dir * SCROLL_STEP);
    stop();
    timer = setInterval(() => slowScroll(dir * 16), 60);
  };
  btn.onmouseup = stop;
  btn.onmouseleave = stop;
}


function showAnswer(i) {
  if (i < 0 || i >= answers.length) return;
  current = i;
  answers[i].shown = answers[i].text.length; // browsing: show it whole at once
  $('ovCard').scrollTop = 0;
  renderAnswer();
}

function clearAnswers() {
  live.lastAuto = null;
  lastHtml = '';
  for (const a of answers) if (a.status === 'loading') api.aiCancel(a.id);
  answers.length = 0;
  byId.clear();
  current = -1;
  renderAnswer();
}

function rate(value) {
  const item = answers[current];
  if (!item || item.status !== 'done') return;
  item.rating = item.rating === value ? 0 : value;
  const saved = sess && sess.answers.find((a) => a.id === item.id);
  if (saved) saved.rating = item.rating;
  renderAnswer();
}

api.onAiDelta(({ requestId, text }) => {
  const item = byId.get(requestId);
  if (!item) return;
  item.text += text;
  if (answers[current] === item) renderAnswer();
});

api.onAiDone(({ requestId, text, aborted }) => {
  const item = byId.get(requestId);
  if (!item) return;
  if (!aborted && typeof text === 'string') item.text = text;
  item.status = 'done';
  if (aborted && !item.text) {
    const i = answers.indexOf(item);
    answers.splice(i, 1);
    byId.delete(item.id);
    if (current >= answers.length) current = answers.length - 1;
  } else if (sess && !aborted) {
    sess.answers.push({ id: item.id, kind: item.kind, question: item.question, text: tidy(item.text), t: item.t, rating: 0 });
  }
  if (live.activeAnswerId === requestId) live.activeAnswerId = null;
  renderAnswer();
  if (item.onDone) item.onDone(aborted ? null : item.text);
});

api.onAiError(({ requestId, message }) => {
  const item = byId.get(requestId);
  if (!item) return;
  item.status = 'error';
  item.text = message;
  if (live.activeAnswerId === requestId) live.activeAnswerId = null;
  renderAnswer();
  if (item.onDone) item.onDone(null, message);
});

function aiRequest(kind, label, payload, onDone) {
  const requestId = addAnswer(kind, label, onDone);
  api.aiStream({ requestId, kind, payload: { mode: mode === 'mock' ? 'interview' : mode, transcript: sess ? sess.transcript : [], ...payload } });
  return requestId;
}

function lastTheirLine() {
  for (let i = sess.transcript.length - 1; i >= 0; i--) {
    if (sess.transcript[i].speaker === 'them') return sess.transcript[i].text;
  }
  return '';
}

function askAnswer(question, auto = false) {
  if (!sess || mode === 'mock') return;
  let q = (question || live.questionBuf.trim() || lastTheirLine()).trim();
  live.questionBuf = '';
  if (auto) {
    const prev = live.lastAuto;
    if (prev && isContinuation(prev, q)) {
      // Continuation of the same question: answer the whole thing, replacing the half answer.
      q = `${prev.question} ${q}`.trim();
      removeAnswer(prev.id);
    } else if (live.activeAnswerId) {
      api.aiCancel(live.activeAnswerId);
    }
  }
  live.activeAnswerId = aiRequest('answer', q || 'Latest question', { question: q });
  live.lastAuto = auto ? { id: live.activeAnswerId, question: q, t: Date.now() } : null;
}

function askScreenshot() {
  if (!sess || mode === 'mock') return;
  aiRequest('screenshot', 'Solve what is on my screen', {}, null);
}

function toggleChat(force) {
  if (!sess || mode === 'mock') return;
  const form = $('chatForm');
  const show = force ?? form.classList.contains('hidden');
  form.classList.toggle('hidden', !show);
  $('oChat').classList.toggle('active', show);
  if (show) {
    $('overlay').classList.remove('collapsed');
    setTimeout(() => $('chatInput').focus(), 0);
  }
  fitOverlay();
}

// ---------------------------------------------------------------- audio capture
async function startAudio(withSystemAudio) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const merger = ctx.createChannelMerger(2);

  $('ind0').classList.toggle('off', !withSystemAudio);
  if (withSystemAudio) {
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      throw new Error('Could not capture computer audio: ' + err.message);
    }
    live.streams.push(display);
    display.getVideoTracks().forEach((t) => (t.enabled = false));
    if (display.getAudioTracks().length === 0) {
      toast('Computer audio is not available on this system. Only your microphone will be transcribed.', 'error', 9000);
      $('ind0').classList.add('off');
    } else {
      ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(merger, 0, 0);
    }
  }

  let mic;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw new Error('Could not open the microphone: ' + err.message);
  }
  live.streams.push(mic);
  ctx.createMediaStreamSource(mic).connect(merger, 0, 1);

  const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  merger.connect(node);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  node.port.onmessage = ({ data }) => {
    api.sttAudio(new Uint8Array(data.pcm));
    setLevel(0, data.level0);
    setLevel(1, data.level1);
  };
  live.audioCtx = ctx;
  live.worklet = node;
}

function stopAudio() {
  live.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  live.streams = [];
  if (live.worklet) live.worklet.port.onmessage = null;
  if (live.audioCtx) live.audioCtx.close().catch(() => {});
  live.audioCtx = null;
  live.worklet = null;
  setLevel(0, 0);
  setLevel(1, 0);
}

// ---------------------------------------------------------------- mock interview
function speak(text, onEnd) {
  const plain = text.replace(/[#*_`>]/g, '').trim();
  if (!plain || !window.speechSynthesis) return onEnd && onEnd();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain);
  const voice = speechSynthesis.getVoices().find((v) => v.name === $('mockVoice').value);
  if (voice) u.voice = voice;
  u.rate = 1.02;
  live.speaking = true;
  setStatus('on', 'Interviewer speaking');
  const done = () => {
    setTimeout(() => {
      live.speaking = false;
      if (sess) setStatus('on', 'Your turn');
      onEnd && onEnd();
    }, 400);
  };
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

function mockInterviewerTurn() {
  if (!sess || live.mockFinished) return;
  $('oMockDone').disabled = true;
  aiRequest('mock', 'Interviewer', { history: live.mockHistory, totalQuestions: Number($('mockCount').value) }, (text) => {
    if (!text || !sess) return;
    const finished = /that concludes our interview/i.test(text);
    const spoken = finished ? text.split(/that concludes our interview\.?/i)[0] + 'That concludes our interview.' : text;
    live.mockHistory.push({ role: 'interviewer', text });
    sess.transcript.push({ speaker: 'them', text: spoken.trim(), t: Date.now() });
    renderTranscript();
    if (finished) {
      live.mockFinished = true;
      speak(spoken, () => {
        setStatus('on', 'Finished');
        toast('Practice complete. Your feedback is in the panel — press End to save it.', 'info', 8000);
      });
      return;
    }
    speak(text, () => {
      live.mockAnswerBuf = '';
      $('oMockDone').disabled = false;
    });
  });
}

function onMockSpeech(text) {
  live.mockAnswerBuf += ' ' + text;
  clearTimeout(live.mockSilenceTimer);
}

function armMockSilence() {
  clearTimeout(live.mockSilenceTimer);
  if (!live.mockAnswerBuf.trim()) return;
  live.mockSilenceTimer = setTimeout(submitMockAnswer, 3500);
}

function submitMockAnswer() {
  clearTimeout(live.mockSilenceTimer);
  if (!sess || live.mockFinished || live.speaking) return;
  const ans = live.mockAnswerBuf.trim();
  live.mockAnswerBuf = '';
  live.mockHistory.push({ role: 'candidate', text: ans || '(the candidate did not answer)' });
  mockInterviewerTurn();
}

function populateVoices() {
  const sel = $('mockVoice');
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  sel.innerHTML = voices.map((v) => `<option>${esc(v.name)}</option>`).join('') || '<option>System default</option>';
  refreshSelects();
}

// ---------------------------------------------------------------- session lifecycle
function configureOverlay() {
  const practice = mode === 'mock';
  $('oMockDone').classList.toggle('hidden', !practice);
  for (const id of ['oAnswer', 'oShot', 'oChat', 'ovAutoBadge']) $(id).classList.toggle('hidden', practice);
  $('chatForm').classList.add('hidden');
  $('oChat').classList.remove('active');
  $('ovMenu').classList.add('hidden');
  $('ovTranscript').classList.add('hidden');
  $('overlay').classList.remove('collapsed');
  $('emptyTitle').textContent = practice ? 'Starting your mock interview' : 'Listening for questions';
  $('emptyText').textContent = practice
    ? 'The interviewer speaks each question. Answer out loud, then pause or press Done answering.'
    : 'Answers appear here as soon as a question is asked. Press Ctrl+Shift+Enter to answer manually.';
  setExpanded(false);
}

function updateAutoBadge() {
  const on = $('autoToggle').checked;
  $('ovAutoBadge').textContent = on ? 'Auto-answer on' : 'Auto-answer off';
}

async function startSession() {
  await api.saveSettings({ profile: profileFromForm(), autoAnswer: $('autoToggle').checked });
  settings = await api.getSettings();
  if (aiKeyMissing() || !settings.deepgramKey) {
    updateKeysCallout();
    return toast('Add your API keys in Settings first.', 'error');
  }

  sess = {
    id: uid(),
    title: $('sessTitle').value.trim() || `${MODE_LABEL[mode]} — ${fmtDate(Date.now())}`,
    mode,
    startedAt: Date.now(),
    endedAt: null,
    transcript: [],
    answers: [],
    notes: '',
    language: settings.language,
    model: settings.model,
    profile: { role: settings.profile.role, company: settings.profile.company },
  };
  Object.assign(live, { openLine: { 0: null, 1: null }, interim: { 0: '', 1: '' }, questionBuf: '', mockHistory: [], mockAnswerBuf: '', mockFinished: false, speaking: false, stripFrom: 0, lastAuto: null });
  clearAnswers();
  $('transcript').innerHTML = '';
  $('chips').innerHTML = '<span class="chip-empty">Listening…</span>';
  configureOverlay();
  $('btnStart').disabled = true;
  $$('.mode-card').forEach((b) => (b.disabled = true));
  setStatus('warn');
  $('ovTimer').textContent = '00:00';
  enterOverlay();

  try {
    await api.sttStart();
    await startAudio(mode !== 'mock');
  } catch (err) {
    await teardown();
    sess = null;
    resetSetupControls();
    enterDashboard();
    switchView('setup');
    toast(err.message, 'error');
    return;
  }

  const t0 = sess.startedAt;
  $('timer').classList.remove('hidden');
  $('timer').textContent = '00:00';
  live.timerInt = setInterval(() => {
    const t = fmtDuration(Date.now() - t0);
    $('timer').textContent = t;
    $('ovTimer').textContent = t;
  }, 1000);

  if (mode === 'mock') mockInterviewerTurn();
}

function resetSetupControls() {
  $('btnStart').disabled = false;
  $$('.mode-card').forEach((b) => (b.disabled = false));
}

async function teardown() {
  clearInterval(live.timerInt);
  clearTimeout(live.detectTimer);
  clearTimeout(live.mockSilenceTimer);
  if (window.speechSynthesis) speechSynthesis.cancel();
  for (const a of answers) if (a.status === 'loading') api.aiCancel(a.id);
  stopAudio();
  await api.sttStop();
  $('timer').classList.add('hidden');
  setStatus('off');
}

async function endSession() {
  if (!sess) return;
  const finished = sess;
  await teardown();
  finished.endedAt = Date.now();
  sess = null;
  resetSetupControls();
  enterDashboard();
  if (finished.transcript.length === 0 && finished.answers.length === 0) {
    switchView('setup');
    toast('Session ended — nothing was transcribed, so it was not saved.', 'info');
    return;
  }
  await api.saveSession(finished);
  toast('Session saved');
  switchView('history');
  openHistory(finished.id, true);
}

// ---------------------------------------------------------------- history
let histFilter = 'all';
let histQuery = '';
let histItems = [];

async function renderHistoryList() {
  $('historyDetail').classList.add('hidden');
  const list = $('historyList');
  list.classList.remove('hidden');
  histItems = await api.listSessions();
  list.innerHTML = `
    <h1 class="page-title">History</h1>
    <p class="page-sub">Every finished session with its transcript, answers and AI notes.</p>
    <div class="hist-tools">
      <div class="seg" id="histSeg">
        ${['all', 'interview', 'meeting', 'mock'].map((f) => `<button data-f="${f}" class="${f === histFilter ? 'active' : ''}">${f === 'all' ? 'All' : MODE_LABEL[f]}</button>`).join('')}
      </div>
      <div class="hist-search">${icon('search')}<input id="histSearch" placeholder="Search by title, role or company" value="${esc(histQuery)}" /></div>
    </div>
    <div id="histRows"></div>`;
  $$('#histSeg button').forEach(
    (b) =>
      (b.onclick = () => {
        histFilter = b.dataset.f;
        $$('#histSeg button').forEach((x) => x.classList.toggle('active', x === b));
        renderHistoryRows();
      }),
  );
  $('histSearch').oninput = (e) => {
    histQuery = e.target.value;
    renderHistoryRows();
  };
  renderHistoryRows();
}

function renderHistoryRows() {
  const q = histQuery.trim().toLowerCase();
  const items = histItems.filter(
    (s) => (histFilter === 'all' || s.mode === histFilter) && (!q || [s.title, s.role, s.company].some((v) => (v || '').toLowerCase().includes(q))),
  );
  const rows = $('histRows');
  if (!items.length) {
    rows.innerHTML = `<div class="empty-block"><div class="empty-icon">${icon('clock')}</div><div class="empty-title">${histItems.length ? 'No matching sessions' : 'No sessions yet'}</div><div class="empty-text">${histItems.length ? 'Try another filter or search.' : 'Finished sessions are saved here with their transcript, answers and notes.'}</div></div>`;
    return;
  }
  rows.innerHTML = `<div class="list">${items
    .map((s) => {
      const dur = s.endedAt ? fmtDuration(s.endedAt - s.startedAt) : '';
      const sub = [s.role, s.company].filter(Boolean).join(' · ');
      return `<div class="hist-row" data-id="${esc(s.id)}">
        <div class="hist-icon">${icon(MODE_ICON[s.mode] || 'doc')}</div>
        <div class="hist-main"><div class="hist-title">${esc(s.title)}</div>
        <div class="hist-meta">${fmtDate(s.startedAt)}${dur ? ` · ${dur}` : ''}${sub ? ` · ${esc(sub)}` : ''} · ${s.answers} answer${s.answers === 1 ? '' : 's'}</div></div>
        <span class="pill">${MODE_LABEL[s.mode] || esc(s.mode)}</span>
        ${icon('chev-right')}
      </div>`;
    })
    .join('')}</div>`;
  rows.querySelectorAll('.hist-row').forEach((el) => (el.onclick = () => openHistory(el.dataset.id)));
}

function sessionMarkdown(s) {
  const them = theirLabel(s.mode);
  let out = `# ${s.title}\n\n${new Date(s.startedAt).toLocaleString()} · ${MODE_LABEL[s.mode] || s.mode}\n\n`;
  if (s.notes) out += `${s.notes}\n\n`;
  if (s.answers.length) {
    out += `## AI answers\n\n`;
    for (const a of s.answers) out += `### ${a.question}\n\n${a.text}\n\n`;
  }
  out += `## Transcript\n\n`;
  for (const l of s.transcript) out += `**${l.speaker === 'me' ? 'Me' : them}:** ${l.text}\n\n`;
  return out;
}

async function openHistory(id, generateNotes = false) {
  const s = await api.getSession(id);
  $('historyList').classList.add('hidden');
  const d = $('historyDetail');
  d.classList.remove('hidden');
  const dur = s.endedAt ? fmtDuration(s.endedAt - s.startedAt) : '';
  const sub = [s.profile?.role, s.profile?.company].filter(Boolean).join(' · ');
  d.innerHTML = `
    <div class="detail-top">
      <button class="btn btn-sm" id="hBack">${icon('arrow-left')}Back</button>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="hNotes">${icon('refresh')}<span>${s.notes ? 'Regenerate notes' : 'Generate notes'}</span></button>
      <button class="btn btn-sm" id="hExport">${icon('download')}Save transcript</button>
      <button class="icon-btn" id="hDelete" title="Delete session">${icon('trash')}</button>
    </div>
    <h2 class="detail-title">${esc(s.title)}</h2>
    <p class="detail-meta">${MODE_LABEL[s.mode] || esc(s.mode)} · ${fmtDate(s.startedAt)}${dur ? ` · ${dur}` : ''}${sub ? ` · ${esc(sub)}` : ''}</p>
    <div class="seg" id="hTabs">
      <button data-pane="notes" class="active">AI notes</button>
      <button data-pane="answers">Answers <span class="count">${s.answers.length}</span></button>
      <button data-pane="transcript">Transcript <span class="count">${s.transcript.length}</span></button>
    </div>
    <div class="detail-pane" id="pane-notes"><div class="notes prose" id="hNotesBody">${s.notes ? md(s.notes) : '<div class="muted-pad">No notes yet.</div>'}</div></div>
    <div class="detail-pane hidden" id="pane-answers">${
      s.answers.length
        ? s.answers
            .map(
              (a) =>
                `<div class="qa"><div class="qa-q"><span>${esc(a.question)}</span>${a.rating === 1 ? '<span class="rating up">Helpful</span>' : a.rating === -1 ? '<span class="rating down">Not helpful</span>' : ''}</div><div class="qa-a prose">${md(a.text)}</div></div>`,
            )
            .join('')
        : '<div class="muted-pad">No answers in this session.</div>'
    }</div>
    <div class="detail-pane hidden" id="pane-transcript"><div class="transcript">${s.transcript.map((l) => lineHtml(l, s.mode)).join('')}</div></div>`;

  d.querySelectorAll('#hTabs button').forEach(
    (b) =>
      (b.onclick = () => {
        d.querySelectorAll('#hTabs button').forEach((x) => x.classList.toggle('active', x === b));
        ['notes', 'answers', 'transcript'].forEach((p) => $(`pane-${p}`).classList.toggle('hidden', p !== b.dataset.pane));
      }),
  );
  $('hBack').onclick = renderHistoryList;
  $('hExport').onclick = async () => {
    if (await api.exportSession({ title: s.title, markdown: sessionMarkdown(s) })) toast('Saved');
  };
  $('hDelete').onclick = async () => {
    await api.deleteSession(s.id);
    toast('Session deleted');
    renderHistoryList();
  };

  const runNotes = () => {
    if (!s.transcript.length) {
      $('hNotesBody').innerHTML = '<div class="muted-pad">Nothing was transcribed, so there is nothing to summarise.</div>';
      return;
    }
    $('hNotes').disabled = true;
    const requestId = uid();
    const body = $('hNotesBody');
    let text = '';
    body.innerHTML = '<div class="muted-pad">Writing notes…</div>';
    const offDelta = api.onAiDelta((e) => {
      if (e.requestId !== requestId) return;
      text += e.text;
      body.innerHTML = md(text);
    });
    const finish = async (final, error) => {
      offDelta();
      offDone();
      offErr();
      $('hNotes').disabled = false;
      if (error) {
        body.innerHTML = `<div class="muted-pad">${esc(error)}</div>`;
        return;
      }
      s.notes = final || text;
      body.innerHTML = md(s.notes);
      $('hNotes').querySelector('span').textContent = 'Regenerate notes';
      await api.saveSession(s);
    };
    const offDone = api.onAiDone((e) => e.requestId === requestId && finish(e.text));
    const offErr = api.onAiError((e) => e.requestId === requestId && finish(null, e.message));
    api.aiStream({ requestId, kind: 'notes', payload: { mode: s.mode === 'mock' ? 'interview' : s.mode, transcript: s.transcript } });
  };
  $('hNotes').onclick = runNotes;
  if (generateNotes && !s.notes) runNotes();
}

// ---------------------------------------------------------------- wiring
function setMode(m) {
  mode = m;
  $$('.mode-card').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('mockOpts').classList.toggle('hidden', m !== 'mock');
  // Regular calls do not use the resume or job description.
  $('resumeField').classList.toggle('hidden', m === 'meeting');
  $('jdField').classList.toggle('hidden', m === 'meeting');
}

async function importDoc(target, info, append) {
  $(info).textContent = 'Reading file…';
  const res = await api.importProfileDoc();
  if (res.canceled) return ($(info).textContent = '');
  if (res.error) {
    $(info).textContent = '';
    return toast(res.error, 'error');
  }
  const el = $(target);
  el.value = append && el.value.trim() ? `${el.value.trim()}\n\n--- ${res.name} ---\n${res.text}` : append ? `--- ${res.name} ---\n${res.text}` : res.text;
  $(info).textContent = append ? `Added ${res.name}` : `Imported from ${res.name}`;
}

function toggleAuto() {
  $('autoToggle').checked = !$('autoToggle').checked;
  api.saveSettings({ autoAnswer: $('autoToggle').checked });
  updateAutoBadge();
  toast(`Auto-answer ${$('autoToggle').checked ? 'on' : 'off'}`, 'info', 1500);
}

async function init() {
  // selects
  $$('[data-setting]').forEach((el) => {
    fillSelect(el, el.dataset.setting);
    el.onchange = () => saveSetting(el.dataset.setting, el.value);
  });

  // dashboard
  $$('#tabs button').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  $$('.mode-card').forEach((b) => (b.onclick = () => !sess && setMode(b.dataset.mode)));
  $('btnGoSettings').onclick = () => switchView('settings');
  $('btnHide').onclick = () => api.minimize();
  $('btnQuit').onclick = async () => {
    if (sess) await endSession();
    api.quit();
  };
  $('pInstr').oninput = updateInstrCount;
  $('btnImportResume').onclick = () => importDoc('pResume', 'resumeInfo', false);
  $('btnImportDoc').onclick = () => importDoc('pDocs', 'docsInfo', true);
  $('btnStart').onclick = startSession;
  $('btnReturn').onclick = enterOverlay;
  $('btnEndFromDash').onclick = endSession;

  ['sHideShare', 'sHideTaskbar', 'sTheme'].forEach((id) => ($(id).onchange = () => autosaveFields()));
  ['sGroq', 'sGemini', 'sAnthropic', 'sDeepgram'].forEach((id) => ($(id).onchange = () => autosaveFields('API key saved')));
  for (const id of ['sOpacity', 'ovOpacity']) {
    $(id).oninput = () => {
      const v = Number($(id).value);
      $('sOpacity').value = v;
      $('ovOpacity').value = v;
      $('opacityValue').textContent = `${Math.round(v * 100)}%`;
      api.saveSettings({ opacity: v });
    };
  }

  // overlay toolbar
  $('oAnswer').onclick = () => askAnswer();
  $('oShot').onclick = askScreenshot;
  $('oChat').onclick = () => toggleChat();
  $('oMockDone').onclick = submitMockAnswer;
  $('oEnd').onclick = endSession;
  $('oHide').onclick = () => api.minimize(); // hides; Ctrl+Q brings it back
  holdToScroll($('oScrollUp'), -1);
  holdToScroll($('oScrollDown'), 1);
  $('oCollapse').onclick = () => {
    const c = $('overlay').classList.toggle('collapsed');
    $('oCollapse').innerHTML = icon(c ? 'chev-down' : 'collapse');
    $('oCollapse').title = c ? 'Show answers' : 'Collapse';
    fitOverlay();
  };
  $('oMenu').onclick = () => {
    const open = $('ovMenu').classList.toggle('hidden') === false;
    $('oMenu').classList.toggle('on', open);
    fitOverlay();
  };
  $('oDashboard').onclick = () => {
    $('ovMenu').classList.add('hidden');
    $('oMenu').classList.remove('on');
    enterDashboard();
    switchView('setup');
    toast('The session is still running. Press Return to session to go back.', 'info', 4000);
  };
  $('oClickThrough').onclick = () => api.setClickThrough(true);
  $('autoToggle').onchange = () => {
    api.saveSettings({ autoAnswer: $('autoToggle').checked });
    updateAutoBadge();
  };
  $('ovAutoBadge').onclick = toggleAuto;
  $('ovAutoBadge').style.cursor = 'pointer';
  $('ovAutoBadge').title = 'Toggle auto-answer (Ctrl+Shift+A)';

  // transcript strip
  $('oClearT').onclick = () => {
    if (!sess) return;
    live.stripFrom = sess.transcript.length;
    live.interim = { 0: '', 1: '' };
    renderTranscript();
  };
  $('oTranscript').onclick = () => {
    const open = $('ovTranscript').classList.toggle('hidden') === false;
    $('oTranscript').innerHTML = icon(open ? 'collapse' : 'expand');
    $('oTranscript').title = open ? 'Hide full transcript' : 'Show full transcript';
    renderTranscript();
    fitOverlay();
  };

  // chat
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const msg = $('chatInput').value.trim();
    if (!msg) return;
    if (aiKeyMissing()) return toast('Add the API key for your selected model in Settings first.', 'error');
    $('chatInput').value = '';
    aiRequest('chat', msg, { message: msg });
  };
  $('chatInput').onkeydown = (e) => {
    if (e.key === 'Escape') toggleChat(false);
  };

  // answers panel
  $('oPrev').onclick = () => showAnswer(current - 1);
  $('oNext').onclick = () => showAnswer(current + 1);
  $('oClearA').onclick = clearAnswers;
  $('oExpand').onclick = () => setExpanded(!expanded);
  $('ovA').onclick = (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.code-wrap').querySelector('pre').innerText;
    navigator.clipboard.writeText(code).then(() => toast('Code copied', 'success', 1200));
  };
  $('oCopy').onclick = () => {
    const item = answers[current];
    if (item) navigator.clipboard.writeText(tidy(item.text)).then(() => toast('Copied', 'success', 1200));
  };
  $('oUp').onclick = () => rate(1);
  $('oDown').onclick = () => rate(-1);

  // keep the overlay window sized to its content
  new ResizeObserver(fitOverlay).observe(document.body);

  api.onHotkey((k) => {
    if (k === 'answer') askAnswer();
    else if (k === 'screenshot') askScreenshot();
    else if (k === 'toggle-auto') toggleAuto();
    else if (k === 'chat') toggleChat(true);
    else if (k === 'clear') clearAnswers();
    else if (k === 'prev') showAnswer(current - 1);
    else if (k === 'next') showAnswer(current + 1);
    else if (k === 'scroll-up') slowScroll(-SCROLL_STEP);
    else if (k === 'scroll-down') slowScroll(SCROLL_STEP);
  });
  api.onClickThrough((on) => {
    $('oClickThrough').classList.toggle('active', on);
    toast(on ? 'Click-through on — press Ctrl+Shift+X to turn off' : 'Click-through off', 'info', 2200);
  });

  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
  // stealth: in-page dropdowns, no tooltips, no autofill popups (all would appear in a screen share)
  $$('select').forEach(enhanceSelect);
  $$('input').forEach((i) => (i.autocomplete = 'off'));
  startTooltipStripper();
  setMode('interview');
  await loadSettingsIntoForms();
  const info = await api.appInfo();
  $('version').textContent = `Version ${info.version}`;
}

init();
