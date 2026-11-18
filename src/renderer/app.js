/* global api, marked, DOMPurify */
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let settings = null;
let mode = 'interview'; // interview | meeting | mock

function showBanner(message, kind = 'error', ms = 8000) {
  const b = $('banner');
  b.textContent = message;
  b.className = `banner ${kind === 'info' ? 'info' : ''}`;
  clearTimeout(showBanner.t);
  if (ms) showBanner.t = setTimeout(() => b.classList.add('hidden'), ms);
}

function setStatus(state) {
  const d = $('statusDot');
  d.className = 'dot' + (state === 'on' ? ' on' : state === 'warn' ? ' warn' : state === 'err' ? ' err' : '');
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'history') renderHistoryList();
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
  $('instrCount').textContent = `${p.instructions.length} / 20000`;

  $('sAnthropic').value = settings.anthropicKey;
  $('sDeepgram').value = settings.deepgramKey;
  $('sModel').value = settings.model;
  $('sEffort').value = settings.effort;
  $('sStyle').value = settings.answerStyle;
  $('sLang').value = settings.language;
  $('sHideShare').checked = settings.hideFromScreenShare;
  $('sHideTaskbar').checked = settings.hideFromTaskbar;
  $('sOpacity').value = settings.opacity;
  $('autoToggle').checked = settings.autoAnswer;

  if (!settings.anthropicKey || !settings.deepgramKey) {
    showBanner('Add your Anthropic and Deepgram API keys in Settings to get started.', 'info', 0);
  }
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
  });
  if (settings.anthropicKey && settings.deepgramKey) $('banner').classList.add('hidden');
}

// ---------------------------------------------------------------- session state
let sess = null; // current session object
const live = {
  audioCtx: null,
  streams: [],
  worklet: null,
  timerInt: null,
  openLine: { 0: null, 1: null }, // index into sess.transcript being appended to
  interim: { 0: '', 1: '' },
  questionBuf: '',
  detectTimer: null,
  activeAnswerId: null,
  // mock
  mockHistory: [],
  mockAnswerBuf: '',
  mockSilenceTimer: null,
  speaking: false,
  mockFinished: false,
};

const SPEAKER = (ch) => (ch === 0 ? 'them' : 'me');
const theirLabel = () => (mode === 'meeting' ? 'Them' : 'Interviewer');

// ---------------------------------------------------------------- transcript UI
function renderTranscript() {
  const box = $('transcript');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const lines = sess.transcript.slice(-60).map(
    (l) => `<div class="line ${l.speaker}"><span class="who">${l.speaker === 'me' ? 'Me' : theirLabel()}:</span>${esc(l.text)}</div>`,
  );
  for (const ch of [0, 1]) {
    if (live.interim[ch]) {
      lines.push(`<div class="line ${SPEAKER(ch)} interim"><span class="who">${ch === 1 ? 'Me' : theirLabel()}:</span>${esc(live.interim[ch])}</div>`);
    }
  }
  box.innerHTML = lines.join('');
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
  if (mode === 'mock' && live.speaking) return; // ignore our own TTS bleed

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
        live.questionBuf = ''; // user is talking; old non-question chatter is stale
      }
    }
    if (speechFinal) {
      live.openLine[ch] = null;
      if (ch === 0) scheduleDetection(600);
    }
  } else {
    live.interim[ch] = text;
    if (ch === 0) clearTimeout(live.detectTimer); // they are still talking
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
  else if (s.state === 'connecting' || s.state === 'reconnecting') setStatus('warn');
  else if (s.state === 'error') {
    setStatus('err');
    showBanner(s.message || 'Transcription error');
  }
});

// ---------------------------------------------------------------- AI cards
const cards = new Map(); // requestId -> {el, text, kind, question, onDone}

function addCard(kind, label, onDone) {
  const requestId = uid();
  const el = document.createElement('div');
  el.className = `answer loading ${kind}`;
  el.innerHTML = `<div class="q"><span class="tag">${esc(kind === 'answer' ? 'Answer' : kind)}</span><span>${esc(label).slice(0, 220)}</span><span class="x" title="Dismiss">✕</span></div><div class="body"></div>`;
  el.querySelector('.x').onclick = () => {
    api.aiCancel(requestId);
    el.remove();
  };
  const container = $('answers');
  container.prepend(el);
  while (container.children.length > 20) container.lastChild.remove();
  cards.set(requestId, { el, text: '', kind, question: label, onDone, raf: 0 });
  return requestId;
}

function renderCard(card) {
  if (card.raf) return;
  card.raf = requestAnimationFrame(() => {
    card.raf = 0;
    card.el.querySelector('.body').innerHTML = md(card.text);
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
    c.el.querySelector('.body').innerHTML = md(text);
  }
  if (aborted) c.el.querySelector('.body').insertAdjacentHTML('beforeend', '<p class="hint">(stopped)</p>');
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
  c.el.querySelector('.body').innerHTML = `<p>${esc(message)}</p>`;
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
  if (!sess) return;
  if (live.activeAnswerId && auto) api.aiCancel(live.activeAnswerId); // newer question wins
  const q = (question || live.questionBuf.trim() || lastTheirLine()).trim();
  live.questionBuf = '';
  live.activeAnswerId = aiRequest('answer', q || 'Latest question', { question: q });
}

function askScreenshot() {
  if (!sess) return;
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
      showBanner('Computer audio capture is not available on this OS — only your microphone will be transcribed.', 'error', 0);
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
    $('meter0').style.width = Math.min(100, data.level0 * 400) + '%';
    $('meter1').style.width = Math.min(100, data.level1 * 400) + '%';
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
}

// ---------------------------------------------------------------- mock interview
function speak(text, onEnd) {
  const plain = text.replace(/[#*_`>-]/g, '').trim();
  if (!plain || !window.speechSynthesis) return onEnd && onEnd();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain);
  const voice = speechSynthesis.getVoices().find((v) => v.name === $('mockVoice').value);
  if (voice) u.voice = voice;
  u.rate = 1.02;
  live.speaking = true;
  const done = () => {
    // small tail so the mic doesn't catch the end of the voice
    setTimeout(() => {
      live.speaking = false;
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
      speak(spoken, () => showBanner('Mock interview finished — feedback is shown above. Press End to save it.', 'info', 0));
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
  sel.innerHTML = voices.map((v) => `<option>${esc(v.name)}</option>`).join('') || '<option>Default</option>';
}

// ---------------------------------------------------------------- session lifecycle
async function startSession() {
  await api.saveSettings({ profile: profileFromForm(), autoAnswer: $('autoToggle').checked });
  settings = await api.getSettings();
  if (!settings.anthropicKey) return showBanner('Add your Anthropic API key in Settings first.');
  if (!settings.deepgramKey) return showBanner('Add your Deepgram API key in Settings first.');

  sess = {
    id: uid(),
    title: $('sessTitle').value.trim() || `${mode === 'mock' ? 'Mock interview' : mode === 'meeting' ? 'Call' : 'Interview'} – ${new Date().toLocaleString()}`,
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
  $('btnMockDone').classList.toggle('hidden', mode !== 'mock');
  $('btnAnswer').classList.toggle('hidden', mode === 'mock');
  $('btnShot').classList.toggle('hidden', mode === 'mock');
  $('autoToggle').parentElement.classList.toggle('hidden', mode === 'mock');
  $('btnStart').disabled = true;
  switchView('live');
  setStatus('warn');

  try {
    await api.sttStart();
    await startAudio(mode !== 'mock');
  } catch (err) {
    showBanner(err.message, 'error', 0);
    await teardown();
    sess = null;
    $('btnStart').disabled = false;
    switchView('setup');
    return;
  }

  const t0 = sess.startedAt;
  live.timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);

  if (mode === 'mock') mockInterviewerTurn();
}

async function teardown() {
  clearInterval(live.timerInt);
  clearTimeout(live.detectTimer);
  clearTimeout(live.mockSilenceTimer);
  if (window.speechSynthesis) speechSynthesis.cancel();
  for (const id of cards.keys()) api.aiCancel(id);
  stopAudio();
  await api.sttStop();
  setStatus('off');
}

async function endSession() {
  if (!sess) return;
  const finished = sess;
  await teardown();
  finished.endedAt = Date.now();
  sess = null;
  $('btnStart').disabled = false;
  $('timer').textContent = '00:00';
  $('meter0').style.width = '0';
  $('meter1').style.width = '0';
  if (finished.transcript.length === 0 && finished.answers.length === 0) {
    switchView('setup');
    return;
  }
  await api.saveSession(finished);
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
    list.innerHTML = '<p class="hint">No saved sessions yet.</p>';
    return;
  }
  list.innerHTML = items
    .map(
      (s) =>
        `<div class="hist-item" data-id="${esc(s.id)}"><div>${esc(s.title)}<br/><small>${esc(s.mode)} · ${new Date(s.startedAt).toLocaleString()}</small></div><small>${s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) + ' min' : ''}</small></div>`,
    )
    .join('');
  list.querySelectorAll('.hist-item').forEach((el) => (el.onclick = () => openHistory(el.dataset.id)));
}

function sessionMarkdown(s) {
  const them = s.mode === 'meeting' ? 'Them' : 'Interviewer';
  let out = `# ${s.title}\n\n${new Date(s.startedAt).toLocaleString()} · ${s.mode}\n\n`;
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
  const them = s.mode === 'meeting' ? 'Them' : 'Interviewer';
  d.innerHTML = `
    <div class="hist-actions">
      <button id="hBack">← Back</button>
      <button id="hNotes">${s.notes ? 'Regenerate notes' : 'Generate AI notes'}</button>
      <button id="hExport">Export .md</button>
      <button class="danger" id="hDelete">Delete</button>
    </div>
    <h3>${esc(s.title)}</h3>
    <p class="hint">${new Date(s.startedAt).toLocaleString()} · ${esc(s.mode)}</p>
    <div class="notes" id="hNotesBody">${s.notes ? md(s.notes) : '<p class="hint">No notes yet.</p>'}</div>
    <details><summary>AI answers (${s.answers.length})</summary>${s.answers.map((a) => `<div class="answer"><div class="q">${esc(a.question)}</div><div class="body">${md(a.text)}</div></div>`).join('')}</details>
    <details><summary>Transcript (${s.transcript.length} lines)</summary><div class="transcript" style="max-height:none">${s.transcript
      .map((l) => `<div class="line ${l.speaker}"><span class="who">${l.speaker === 'me' ? 'Me' : them}:</span>${esc(l.text)}</div>`)
      .join('')}</div></details>`;

  $('hBack').onclick = renderHistoryList;
  $('hExport').onclick = () => api.exportSession({ title: s.title, markdown: sessionMarkdown(s) });
  $('hDelete').onclick = async () => {
    await api.deleteSession(s.id);
    renderHistoryList();
  };
  const runNotes = () => {
    if (!s.transcript.length) {
      $('hNotesBody').innerHTML = '<p class="hint">Nothing was transcribed, so there is nothing to summarise.</p>';
      return;
    }
    $('hNotes').disabled = true;
    const requestId = uid();
    const body = $('hNotesBody');
    let text = '';
    body.innerHTML = '<p class="hint">Writing notes…</p>';
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
        body.innerHTML = `<p>${esc(error)}</p>`;
        return;
      }
      s.notes = final || text;
      body.innerHTML = md(s.notes);
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
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('mockOpts').classList.toggle('hidden', m !== 'mock');
  $('modeHint').textContent = {
    interview: 'Listens to the call, detects interviewer questions and suggests answers using your resume.',
    meeting: 'For sales calls, client meetings and other calls — suggests replies, no resume needed.',
    mock: 'Practice: an AI interviewer asks questions out loud, listens to your answers and scores you.',
  }[m];
}

function init() {
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => !sess && setMode(b.dataset.mode)));
  $('btnHide').onclick = () => api.minimize();
  $('btnQuit').onclick = async () => {
    if (sess) await endSession();
    api.quit();
  };
  $('pInstr').oninput = () => ($('instrCount').textContent = `${$('pInstr').value.length} / 20000`);

  $('btnImportResume').onclick = async () => {
    $('resumeInfo').textContent = 'Reading…';
    const res = await api.importProfileDoc();
    if (res.canceled) return ($('resumeInfo').textContent = '');
    if (res.error) {
      $('resumeInfo').textContent = '';
      return showBanner(res.error);
    }
    $('pResume').value = res.text;
    $('resumeInfo').textContent = `Imported ${res.name}`;
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
    $('chatInput').value = '';
    if (!settings?.anthropicKey) return showBanner('Add your Anthropic API key in Settings first.');
    aiRequest('chat', msg, { message: msg });
  };
  $('btnSaveSettings').onclick = async () => {
    await saveSettingsFromForm();
    showBanner('Settings saved.', 'info', 2500);
  };
  $('sOpacity').oninput = () => api.saveSettings({ opacity: Number($('sOpacity').value) });

  api.onHotkey((k) => {
    if (k === 'answer') askAnswer();
    else if (k === 'screenshot') askScreenshot();
    else if (k === 'toggle-auto') {
      $('autoToggle').checked = !$('autoToggle').checked;
      api.saveSettings({ autoAnswer: $('autoToggle').checked });
      showBanner(`Auto answer ${$('autoToggle').checked ? 'on' : 'off'}`, 'info', 1500);
    }
  });
  api.onClickThrough((on) => showBanner(on ? 'Click-through ON (Ctrl+Shift+X to turn off)' : 'Click-through off', 'info', 2000));

  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
  setMode('interview');
  loadSettingsIntoForms();
}

init();
