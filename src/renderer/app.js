/* global api, marked, DOMPurify */
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const MODE_LABEL = { interview: 'Interview', meeting: 'Meeting', mock: 'Practice' };
const MODE_ICON = { interview: 'briefcase', meeting: 'users', mock: 'target' };

let settings = null;
let mode = 'interview'; // interview | meeting | mock

// ---------------------------------------------------------------- feedback
function toast(message, kind = 'success', ms = 3200) {
  const t = $('toast');
  $('toastText').textContent = message;
  $('toastIcon').innerHTML = `<use href="#i-${kind === 'error' ? 'alert' : kind === 'info' ? 'alert' : 'check'}"/>`;
  t.className = `toast ${kind}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? Math.max(ms, 6000) : ms);
}
// kept for compatibility with older call sites
const showBanner = (message, kind = 'error', ms) => toast(message, kind === 'info' ? 'info' : 'error', ms || undefined);

function setStatus(state, text) {
  const s = $('status');
  s.className = 'status' + (state === 'on' ? ' live' : state === 'warn' ? ' connecting' : state === 'err' ? ' error' : '');
  $('statusText').textContent = text || { on: 'Listening', warn: 'Connecting', err: 'Connection problem', off: 'Ready' }[state] || 'Ready';
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistoryList();
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function updateKeysCallout() {
  $('keysCallout').classList.toggle('hidden', !!(settings && settings.anthropicKey && settings.deepgramKey));
}

// ---------------------------------------------------------------- settings
async function loadSettingsIntoForms() {
  settings = await api.getSettings();
  const p = settings.profile;
  $('pName').value = p.name;
  $('pRole').value = p.role;
  $('pCompany').value = p.company;
  $('pResume').value = p.resume;
  $('pJD').value = p.jobDescription;
  $('pInstr').value = p.instructions;
  updateInstrCount();

  $('sAnthropic').value = settings.anthropicKey;
  $('sDeepgram').value = settings.deepgramKey;
  $('sModel').value = settings.model;
  $('sEffort').value = settings.effort;
  $('sStyle').value = settings.answerStyle;
  $('sLang').value = settings.language;
  $('sHideShare').checked = settings.hideFromScreenShare;
  $('sHideTaskbar').checked = settings.hideFromTaskbar;
  $('sOpacity').value = settings.opacity;
  $('opacityValue').textContent = `${Math.round(settings.opacity * 100)}%`;
  $('sTheme').value = settings.theme || 'system';
  $('autoToggle').checked = settings.autoAnswer;
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
    instructions: $('pInstr').value.slice(0, 20000),
  };
}

async function saveSettingsFromForm() {
  settings = await api.saveSettings({
    anthropicKey: $('sAnthropic').value.trim(),
    deepgramKey: $('sDeepgram').value.trim(),
    model: $('sModel').value,
    effort: $('sEffort').value,
    answerStyle: $('sStyle').value,
    language: $('sLang').value,
    hideFromScreenShare: $('sHideShare').checked,
    hideFromTaskbar: $('sHideTaskbar').checked,
    opacity: Number($('sOpacity').value),
    theme: $('sTheme').value,
  });
  applyTheme(settings.theme);
  updateKeysCallout();
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
};

const SPEAKER = (ch) => (ch === 0 ? 'them' : 'me');
const theirLabel = (m = mode) => (m === 'meeting' ? 'Them' : 'Interviewer');

// ---------------------------------------------------------------- level meters
const METER_SEGMENTS = 12;
function buildMeters() {
  for (const id of ['meter0', 'meter1']) {
    $(id).innerHTML = Array.from({ length: METER_SEGMENTS }, (_, i) => `<i style="height:${4 + Math.round((i / (METER_SEGMENTS - 1)) * 8)}px"></i>`).join('');
  }
}
function setMeter(id, level) {
  const lit = Math.min(METER_SEGMENTS, Math.round(Math.sqrt(Math.min(1, level * 4)) * METER_SEGMENTS));
  $(id).querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < lit));
}

// ---------------------------------------------------------------- transcript UI
function lineHtml(l, m = mode, interim = false) {
  return `<div class="line ${l.speaker}${interim ? ' interim' : ''}"><span class="who">${l.speaker === 'me' ? 'You' : theirLabel(m)}</span><span class="txt">${esc(l.text)}</span></div>`;
}

function renderTranscript() {
  const box = $('transcript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const lines = sess.transcript.slice(-80).map((l) => lineHtml(l));
  for (const ch of [0, 1]) {
    if (live.interim[ch]) lines.push(lineHtml({ speaker: SPEAKER(ch), text: live.interim[ch] }, mode, true));
  }
  box.innerHTML = lines.join('');
  $('lineCount').textContent = sess.transcript.length ? `${sess.transcript.length} lines` : '';
  if (atBottom) box.scrollTop = box.scrollHeight;
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
const Q_ANY = /\b(tell me about|walk me through|can you|could you|would you|how would you|what would you|why did you|have you ever|what is|what are|what's|explain|describe)\b/i;

function looksLikeQuestion(text) {
  const t = text.trim();
  if (t.split(/\s+/).length < 3) return false;
  if (t.includes('?')) return true;
  const sentences = t.split(/(?<=[.!?])\s+/).slice(-3);
  return sentences.some((s) => Q_START.test(s.trim())) || Q_ANY.test(t);
}

function scheduleDetection(delay) {
  clearTimeout(live.detectTimer);
  live.detectTimer = setTimeout(() => {
    if (!sess || mode === 'mock') return;
    const q = live.questionBuf.trim();
    if (!q || !$('autoToggle').checked) return;
    if (looksLikeQuestion(q)) {
      live.questionBuf = '';
      askAnswer(q, true);
    }
  }, delay);
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
      } else if (text.split(/\s+/).length >= 6 && !looksLikeQuestion(live.questionBuf)) {
        live.questionBuf = '';
      }
    }
    if (speechFinal) {
      live.openLine[ch] = null;
      if (ch === 0) scheduleDetection(600);
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
  if (ch === 0) scheduleDetection(100);
  if (ch === 1 && mode === 'mock') armMockSilence();
  renderTranscript();
});

api.onSpeechStarted(({ channel }) => {
  if (channel === 0) clearTimeout(live.detectTimer);
  if (channel === 1 && mode === 'mock') clearTimeout(live.mockSilenceTimer);
});

api.onSttStatus((s) => {
  if (!sess) return;
  if (s.state === 'connected') setStatus('on');
  else if (s.state === 'connecting') setStatus('warn');
  else if (s.state === 'reconnecting') setStatus('warn', 'Reconnecting');
  else if (s.state === 'error') {
    setStatus('err');
    toast(s.message || 'Transcription error', 'error');
  }
});

// ---------------------------------------------------------------- AI cards
const cards = new Map();
const KIND_LABEL = { answer: 'Answer', chat: 'Ask', screenshot: 'Screen', mock: 'Interviewer' };

function addCard(kind, label, onDone) {
  const requestId = uid();
  const el = document.createElement('article');
  el.className = `answer loading ${kind}`;
  el.innerHTML = `
    <div class="answer-head">
      <span class="badge">${KIND_LABEL[kind] || kind}</span>
      <span class="answer-q" title="${esc(label)}">${esc(label)}</span>
      <span class="typing"><i></i><i></i><i></i></span>
      <span class="answer-time">${clock(Date.now())}</span>
      <button class="icon-btn" data-act="copy" title="Copy">${icon('copy')}</button>
      <button class="icon-btn" data-act="close" title="Dismiss">${icon('x')}</button>
    </div>
    <div class="answer-body prose"></div>`;
  el.querySelector('[data-act="close"]').onclick = () => {
    api.aiCancel(requestId);
    el.remove();
  };
  el.querySelector('[data-act="copy"]').onclick = () => {
    navigator.clipboard.writeText(el.querySelector('.answer-body').innerText).then(() => toast('Copied to clipboard'));
  };
  const feed = $('answers');
  feed.prepend(el);
  feed.scrollTop = 0;
  while (feed.children.length > 20) feed.lastChild.remove();
  cards.set(requestId, { el, text: '', kind, question: label, onDone, raf: 0 });
  return requestId;
}

function renderCard(card) {
  if (card.raf) return;
  card.raf = requestAnimationFrame(() => {
    card.raf = 0;
    card.el.querySelector('.answer-body').innerHTML = md(card.text);
  });
}

api.onAiDelta(({ requestId, text }) => {
  const c = cards.get(requestId);
  if (!c) return;
  c.text += text;
  renderCard(c);
});

api.onAiDone(({ requestId, text, aborted }) => {
  const c = cards.get(requestId);
  if (!c) return;
  c.el.classList.remove('loading');
  if (!aborted && typeof text === 'string') {
    c.text = text;
    c.el.querySelector('.answer-body').innerHTML = md(text);
  }
  if (aborted && !c.text) c.el.remove();
  if (sess && !aborted && c.kind !== 'notes') {
    sess.answers.push({ kind: c.kind, question: c.question, text: c.text, t: Date.now() });
  }
  cards.delete(requestId);
  if (live.activeAnswerId === requestId) live.activeAnswerId = null;
  if (c.onDone) c.onDone(aborted ? null : c.text);
});

api.onAiError(({ requestId, message }) => {
  const c = cards.get(requestId);
  if (!c) return;
  c.el.classList.remove('loading');
  c.el.classList.add('error');
  c.el.querySelector('.badge').textContent = 'Error';
  c.el.querySelector('.answer-body').textContent = message;
  cards.delete(requestId);
  if (live.activeAnswerId === requestId) live.activeAnswerId = null;
  if (c.onDone) c.onDone(null, message);
});

function aiRequest(kind, label, payload, onDone) {
  const requestId = addCard(kind, label, onDone);
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
  if (live.activeAnswerId && auto) api.aiCancel(live.activeAnswerId);
  const q = (question || live.questionBuf.trim() || lastTheirLine()).trim();
  live.questionBuf = '';
  live.activeAnswerId = aiRequest('answer', q || 'Latest question', { question: q });
}

function askScreenshot() {
  if (!sess || mode === 'mock') return;
  aiRequest('screenshot', 'Screen capture', {}, null);
}

// ---------------------------------------------------------------- audio capture
async function startAudio(withSystemAudio) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const merger = ctx.createChannelMerger(2);

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
    setMeter('meter0', data.level0);
    setMeter('meter1', data.level1);
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
  setMeter('meter0', 0);
  setMeter('meter1', 0);
}

// ---------------------------------------------------------------- practice (mock) interview
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
  $('btnMockDone').disabled = true;
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
        toast('Practice complete. Your feedback is above — end the session to save it.', 'info', 8000);
      });
      return;
    }
    speak(text, () => {
      live.mockAnswerBuf = '';
      $('btnMockDone').disabled = false;
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
}

// ---------------------------------------------------------------- session lifecycle
function configureLiveView() {
  const practice = mode === 'mock';
  $('btnMockDone').classList.toggle('hidden', !practice);
  $('btnAnswer').classList.toggle('hidden', practice);
  $('btnShot').classList.toggle('hidden', practice);
  $('autoWrap').classList.toggle('hidden', practice);
  $('themLabel').textContent = practice ? 'Interviewer' : theirLabel();
  $('emptyTitle').textContent = practice ? 'Starting your practice interview' : 'Listening for questions';
  $('emptyText').textContent = practice
    ? 'The interviewer will speak each question. Answer out loud, then pause or press Done answering.'
    : 'Suggested answers appear here as soon as a question is asked. Press Ctrl+Shift+Enter to answer manually.';
}

async function startSession() {
  await api.saveSettings({ profile: profileFromForm(), autoAnswer: $('autoToggle').checked });
  settings = await api.getSettings();
  if (!settings.anthropicKey || !settings.deepgramKey) {
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
    profile: { role: settings.profile.role, company: settings.profile.company },
  };
  Object.assign(live, { openLine: { 0: null, 1: null }, interim: { 0: '', 1: '' }, questionBuf: '', mockHistory: [], mockAnswerBuf: '', mockFinished: false, speaking: false });
  $('answers').innerHTML = '';
  $('transcript').innerHTML = '';
  $('lineCount').textContent = '';
  configureLiveView();
  $('btnStart').disabled = true;
  document.querySelectorAll('.mode-card').forEach((b) => (b.disabled = true));
  switchView('live');
  setStatus('warn');

  try {
    await api.sttStart();
    await startAudio(mode !== 'mock');
  } catch (err) {
    toast(err.message, 'error');
    await teardown();
    sess = null;
    resetSetupControls();
    switchView('setup');
    return;
  }

  const t0 = sess.startedAt;
  $('timer').classList.remove('hidden');
  $('timer').textContent = '00:00';
  live.timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  if (mode === 'mock') mockInterviewerTurn();
}

function resetSetupControls() {
  $('btnStart').disabled = false;
  document.querySelectorAll('.mode-card').forEach((b) => (b.disabled = false));
}

async function teardown() {
  clearInterval(live.timerInt);
  clearTimeout(live.detectTimer);
  clearTimeout(live.mockSilenceTimer);
  if (window.speechSynthesis) speechSynthesis.cancel();
  for (const id of cards.keys()) api.aiCancel(id);
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
  if (finished.transcript.length === 0 && finished.answers.length === 0) {
    switchView('setup');
    return;
  }
  await api.saveSession(finished);
  toast('Session saved');
  switchView('history');
  openHistory(finished.id, true);
}

// ---------------------------------------------------------------- history
async function renderHistoryList() {
  $('historyDetail').classList.add('hidden');
  const list = $('historyList');
  list.classList.remove('hidden');
  const items = await api.listSessions();
  if (!items.length) {
    list.innerHTML = `<div class="empty-block"><div class="empty-icon" style="margin:0 auto 10px">${icon('clock')}</div><div class="empty-title">No sessions yet</div><div class="empty-text" style="margin:0 auto">Finished sessions are saved here with their transcript, answers and notes.</div></div>`;
    return;
  }
  list.innerHTML = `
    <div class="list-head"><div class="section-title" style="margin:0">Sessions</div><span class="count">${items.length}</span></div>
    <div class="list">${items
      .map((s) => {
        const mins = s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000)) : null;
        return `<div class="hist-row" data-id="${esc(s.id)}">
          <div class="hist-icon">${icon(MODE_ICON[s.mode] || 'doc')}</div>
          <div class="hist-main"><div class="hist-title">${esc(s.title)}</div>
          <div class="hist-meta">${MODE_LABEL[s.mode] || esc(s.mode)} · ${fmtDate(s.startedAt)}${mins ? ` · ${mins} min` : ''}</div></div>
          ${icon('chev-right')}
        </div>`;
      })
      .join('')}</div>`;
  list.querySelectorAll('.hist-row').forEach((el) => (el.onclick = () => openHistory(el.dataset.id)));
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
  const mins = s.endedAt ? Math.max(1, Math.round((s.endedAt - s.startedAt) / 60000)) : null;
  d.innerHTML = `
    <div class="detail-top">
      <button class="btn btn-sm" id="hBack">${icon('arrow-left')}Back</button>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="hNotes">${icon('refresh')}<span>${s.notes ? 'Regenerate notes' : 'Generate notes'}</span></button>
      <button class="btn btn-sm" id="hExport">${icon('download')}Export</button>
      <button class="icon-btn" id="hDelete" title="Delete session">${icon('trash')}</button>
    </div>
    <h2 class="detail-title">${esc(s.title)}</h2>
    <p class="detail-meta">${MODE_LABEL[s.mode] || esc(s.mode)} · ${fmtDate(s.startedAt)}${mins ? ` · ${mins} min` : ''}</p>
    <div class="seg" id="hTabs">
      <button data-pane="notes" class="active">Notes</button>
      <button data-pane="answers">Answers <span class="count">${s.answers.length}</span></button>
      <button data-pane="transcript">Transcript <span class="count">${s.transcript.length}</span></button>
    </div>
    <div class="detail-pane" id="pane-notes"><div class="notes prose" id="hNotesBody">${s.notes ? md(s.notes) : '<div class="muted-pad">No notes yet.</div>'}</div></div>
    <div class="detail-pane hidden" id="pane-answers">${
      s.answers.length
        ? s.answers.map((a) => `<div class="qa"><div class="qa-q">${esc(a.question)}</div><div class="qa-a prose">${md(a.text)}</div></div>`).join('')
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
    if (await api.exportSession({ title: s.title, markdown: sessionMarkdown(s) })) toast('Exported');
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
  document.querySelectorAll('.mode-card').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('mockOpts').classList.toggle('hidden', m !== 'mock');
}

let saveTimer = null;
function autosave(message = 'Settings saved') {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettingsFromForm();
    toast(message, 'success', 1600);
  }, 350);
}

async function init() {
  buildMeters();
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  document.querySelectorAll('.mode-card').forEach((b) => (b.onclick = () => !sess && setMode(b.dataset.mode)));
  $('btnGoSettings').onclick = () => switchView('settings');
  $('btnHide').onclick = () => api.minimize();
  $('btnQuit').onclick = async () => {
    if (sess) await endSession();
    api.quit();
  };
  $('pInstr').oninput = updateInstrCount;

  $('btnImportResume').onclick = async () => {
    $('resumeInfo').textContent = 'Reading file…';
    const res = await api.importProfileDoc();
    if (res.canceled) return ($('resumeInfo').textContent = '');
    if (res.error) {
      $('resumeInfo').textContent = '';
      return toast(res.error, 'error');
    }
    $('pResume').value = res.text;
    $('resumeInfo').textContent = `Imported from ${res.name}`;
  };

  $('btnStart').onclick = startSession;
  $('btnEnd').onclick = endSession;
  $('btnAnswer').onclick = () => askAnswer();
  $('btnShot').onclick = askScreenshot;
  $('btnMockDone').onclick = submitMockAnswer;
  $('autoToggle').onchange = () => api.saveSettings({ autoAnswer: $('autoToggle').checked });
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const msg = $('chatInput').value.trim();
    if (!msg) return;
    if (!settings?.anthropicKey) return toast('Add your Anthropic API key in Settings first.', 'error');
    $('chatInput').value = '';
    aiRequest('chat', msg, { message: msg });
  };

  // Settings save automatically.
  ['sModel', 'sEffort', 'sStyle', 'sLang', 'sHideShare', 'sHideTaskbar', 'sTheme'].forEach((id) => ($(id).onchange = () => autosave()));
  ['sAnthropic', 'sDeepgram'].forEach((id) => ($(id).onchange = () => autosave('API key saved')));
  $('sOpacity').oninput = () => {
    $('opacityValue').textContent = `${Math.round($('sOpacity').value * 100)}%`;
    api.saveSettings({ opacity: Number($('sOpacity').value) });
  };

  api.onHotkey((k) => {
    if (k === 'answer') askAnswer();
    else if (k === 'screenshot') askScreenshot();
    else if (k === 'toggle-auto') {
      $('autoToggle').checked = !$('autoToggle').checked;
      api.saveSettings({ autoAnswer: $('autoToggle').checked });
      toast(`Auto-answer ${$('autoToggle').checked ? 'on' : 'off'}`, 'info', 1500);
    }
  });
  api.onClickThrough((on) => toast(on ? 'Click-through on — press Ctrl+Shift+X to turn off' : 'Click-through off', 'info', 2200));

  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
  setMode('interview');
  await loadSettingsIntoForms();
  const info = await api.appInfo();
  $('version').textContent = `Interview Pilot ${info.version}`;
}

init();
