// All AI calls (Claude or Gemini): live answers, chat, screenshot solving, post-call notes,
// mock-interviewer turns and resume text extraction.
const Anthropic = require('@anthropic-ai/sdk');

// Models that support server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

// Requests to write something concrete (a file, config, query, script or code). These always
// get the complete artifact, whatever the answer format, because a summary is useless there.
const ARTIFACT_RULE = [
  'IMPORTANT — if the question asks to write, create, show, fix or explain a file, config, script, query, command or code',
  '— any kind at all, for example Dockerfile, docker-compose.yml, Kubernetes manifests, Helm charts, Terraform, Ansible playbooks/roles, CloudFormation, Pulumi, Packer, Vagrantfile,',
  'Jenkinsfile, GitHub Actions, GitLab CI, Azure Pipelines, nginx/Apache config, systemd units, Prometheus/Grafana config, Makefile, crontab, .env, pom.xml, build.gradle, package.json,',
  'SQL, shell/PowerShell/Python scripts, regex, GraphQL, protobuf, API endpoints, functions or classes in any language:',
  '1) one short line saying what it does;',
  '2) the COMPLETE, working file in ONE fenced code block with the right language tag (dockerfile, yaml, sql, bash, js, python, …) and the file name as a comment on the first line when it is a file;',
  '3) then at most 3 short bullets on the key choices (and time/space complexity for algorithms).',
  'Never skip, shorten, summarise or describe the file instead of writing it. Word limits never apply to code.',
].join(' ');

const STYLE_GUIDE = {
  spoken: [
    'The candidate reads this while speaking, so it must be short and instantly scannable.',
    'Format: first a **bold 1-2 sentence direct answer** in natural first-person speech. Then at most 3 bullets, each max 15 words, with the key supporting points.',
    'Make it specific to the candidate: where it fits, one bullet names a real project, company, tool or number from the resume (behavioural questions: a one-line situation -> action -> result from the resume).',
    'Hard limit: 80 words, not counting code. No intro, no headings, no closing summary, no filler.',
    ARTIFACT_RULE,
  ].join(' '),
  bullets: [
    'Give short keyword bullet points (max 6 bullets, max 12 words each) the candidate can glance at while speaking. Where it fits, one bullet names a real project, tool or number from the resume.',
    ARTIFACT_RULE,
  ].join(' '),
  detailed: [
    'Write a complete answer as a first-person script the candidate can read out naturally, in short paragraphs (no headings).',
    'Use real details from the resume (projects, companies, tools, numbers); behavioural questions follow situation -> action -> result.',
    'Keep it under 200 words, not counting code.',
    ARTIFACT_RULE,
  ].join(' '),
};

function clientFor(settings) {
  if (!settings.anthropicKey) throw new Error('Anthropic API key is missing. Add it in Settings.');
  return new Anthropic({ apiKey: settings.anthropicKey, maxRetries: 2 });
}

// Meetings / regular calls do not use the resume or job description, only the
// user's instructions and uploaded documents.
function profileBlock(p, mode = 'interview') {
  const meeting = mode === 'meeting';
  const parts = [];
  if (p.name) parts.push(`${meeting ? 'User' : 'Candidate'} name: ${p.name}`);
  if (!meeting && p.role) parts.push(`Role being interviewed for: ${p.role}`);
  if (p.company) parts.push(`Company: ${p.company}`);
  if (!meeting && p.resume) parts.push(`<resume>\n${p.resume}\n</resume>`);
  if (!meeting && p.jobDescription) parts.push(`<job_description>\n${p.jobDescription}\n</job_description>`);
  if (p.documents) parts.push(`<reference_documents>\n${p.documents}\n</reference_documents>`);
  if (p.instructions) parts.push(`<${meeting ? 'user' : 'candidate'}_instructions>\n${p.instructions}\n</${meeting ? 'user' : 'candidate'}_instructions>`);
  return parts.length ? parts.join('\n\n') : 'No profile provided.';
}

function copilotSystem(settings, mode) {
  const meeting = mode === 'meeting';
  const intro = meeting
    ? 'You are a real-time meeting copilot for the user. You see a live transcript of a call. "Them" is the other people on the call, "Me" is the user.'
    : 'You are a real-time interview copilot for the candidate. You see a live transcript of a job interview. "Interviewer" is the other side of the call, "Me" is the candidate.';
  const rules = [
    intro,
    'Your job is to give the user the best possible reply to the latest question, fast. Use the profile below (resume, job description, reference documents, instructions) so answers are specific to the user — use real details from it, never invent employers, degrees, facts or numbers that are not in it.',
    'For coding questions and any request to write a file, config, query, script or code: state the approach in one line, then the complete, working code in a fenced block with the right language tag, then key points / complexity. Always write the full code; never only describe it.',
    'The question may arrive in pieces from live speech recognition; answer the complete question the interviewer is asking, using the transcript for context.',
    'For system design questions: give the key components, data flow, scaling and trade-offs as short bullets, then a simple ASCII flow like "Client -> API -> Queue -> Worker -> DB".',
    'Keep answers short: the user glances at them mid-conversation. Follow the length and format rules in the request exactly.',
    'If the transcript is unclear or garbled, answer the most likely question and do not comment on transcription quality.',
    'Never mention that you are an AI, and never add disclaimers.',
    `Answer in the language the question was asked in.`,
  ];
  return [
    { type: 'text', text: rules.join('\n') },
    {
      type: 'text',
      text: `<profile>\n${profileBlock(settings.profile, mode)}\n</profile>`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

function formatTranscript(lines, mode, maxChars = 12000) {
  const them = mode === 'meeting' ? 'Them' : 'Interviewer';
  const text = lines.map((l) => `${l.speaker === 'me' ? 'Me' : them}: ${l.text}`).join('\n');
  return text.length > maxChars ? '…' + text.slice(-maxChars) : text;
}

function buildRequest(kind, payload, settings) {
  const style = STYLE_GUIDE[settings.answerStyle] || STYLE_GUIDE.spoken;
  const mode = payload.mode || 'interview';
  // Live answers only need recent context; a shorter prompt starts streaming sooner.
  const transcript = formatTranscript(payload.transcript || [], mode, kind === 'answer' ? 4000 : 12000);

  switch (kind) {
    case 'answer':
      return {
        system: copilotSystem(settings, mode),
        max_tokens: 4000,
        effort: settings.effort,
        messages: [
          {
            role: 'user',
            content: `Live transcript so far:\n<transcript>\n${transcript || '(empty)'}\n</transcript>\n\nLatest question to answer:\n"${payload.question || 'the most recent question in the transcript'}"\n\n${style}`,
          },
        ],
      };

    case 'chat':
      return {
        system: copilotSystem(settings, mode),
        max_tokens: 6000,
        effort: settings.effort,
        messages: [
          {
            role: 'user',
            content: `Live transcript so far:\n<transcript>\n${transcript || '(empty)'}\n</transcript>\n\nThe user typed this request to you privately (it is not part of the call):\n${payload.message}`,
          },
        ],
      };

    case 'screenshot':
      return {
        system: copilotSystem(settings, mode),
        max_tokens: 8000,
        effort: settings.effort === 'low' ? 'medium' : settings.effort,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: payload.imageBase64 } },
              {
                type: 'text',
                text: `This is a screenshot of the user's screen during the call. Recent transcript:\n<transcript>\n${transcript || '(empty)'}\n</transcript>\n\n${payload.prompt || 'Find the question or problem shown on screen (coding problem, MCQ, design question, error message, etc.) and solve it. For code: approach, complete working code, complexity.'}`,
              },
            ],
          },
        ],
      };

    case 'notes':
      return {
        system:
          'You write concise, useful post-call notes in Markdown. Sections: ## Summary, ## Questions asked (each with a one-line note on how well it was answered, for interviews), ## Key points / decisions, ## Next steps. Be factual and only use what is in the transcript.',
        max_tokens: 6000,
        effort: 'medium',
        messages: [
          {
            role: 'user',
            content: `Call type: ${mode}\n\nTranscript:\n<transcript>\n${formatTranscript(payload.transcript || [], mode, 150000)}\n</transcript>`,
          },
        ],
      };

    case 'mock': {
      const p = settings.profile;
      const n = payload.totalQuestions || 6;
      const system = [
        {
          type: 'text',
          text: `You are a professional interviewer running a realistic mock job interview${p.role ? ` for the role "${p.role}"` : ''}${p.company ? ` at ${p.company}` : ''}. Ask exactly one question per turn, mixing behavioural, role-specific and (if technical) technical questions, tailored to the candidate's resume and the job description. After each candidate answer, react briefly and naturally (max one sentence), then ask the next question. Keep every turn short and spoken-style (no Markdown, no lists) because it is read aloud. The interview has ${n} questions. After the candidate answers the last question, say "That concludes our interview." and then give feedback in Markdown: ## Overall, ## Strengths, ## Improve, and a score out of 10.`,
        },
        { type: 'text', text: `<profile>\n${profileBlock(p)}\n</profile>`, cache_control: { type: 'ephemeral' } },
      ];
      const messages = [{ role: 'user', content: 'Please start the interview now.' }];
      for (const turn of payload.history || []) {
        messages.push({ role: turn.role === 'interviewer' ? 'assistant' : 'user', content: turn.text || '(no answer)' });
      }
      return { system, max_tokens: 3000, effort: 'low', messages };
    }

    default:
      throw new Error(`Unknown request kind: ${kind}`);
  }
}

// ---------------------------------------------------------------- Gemini
// Google Gemini via the REST API (streamGenerateContent, server-sent events).

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// Used when the chosen model is overloaded (503) or out of free quota (429).
const GEMINI_FALLBACK = 'gemini-flash-lite-latest';
// Default wait for a first word before also trying the fallback model (see GEMINI_RACE).
const GEMINI_STALL_MS = 20000;

class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

function isGemini(settings) {
  return String(settings.model || '').startsWith('gemini');
}

function toGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((b) => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'image' || b.type === 'document') {
      return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    }
    throw new Error(`Unsupported content block: ${b.type}`);
  });
}

// Thinking level per model. Flash-Lite supports "minimal", which cuts time-to-first-word
// from ~7s to ~1s; Flash rejects "minimal", so its fastest level is "low".
function geminiThinkingLevel(model, effort) {
  if (effort === 'high') return 'high';
  if (effort === 'medium') return 'medium';
  return model.includes('lite') ? 'minimal' : 'low';
}

function toGeminiBody(req, model) {
  const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join('\n\n') : req.system;
  const effort = req.effort || 'low';
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(m.content),
    })),
    generationConfig: {
      maxOutputTokens: req.max_tokens,
      thinkingConfig: { thinkingLevel: geminiThinkingLevel(model, effort) },
    },
  };
}

async function geminiStreamOnce(model, body, apiKey, onDelta, signal) {
  const res = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error?.message || message;
    } catch {}
    throw new GeminiError(res.status, message);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finish = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const evt = JSON.parse(line.slice(5));
      if (evt.promptFeedback?.blockReason) {
        throw new GeminiError(400, `Gemini blocked the request (${evt.promptFeedback.blockReason}).`);
      }
      const cand = evt.candidates?.[0];
      for (const part of cand?.content?.parts || []) {
        if (part.text && !part.thought) {
          text += part.text;
          onDelta(part.text);
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
    }
  }
  if (finish && !['STOP', 'MAX_TOKENS'].includes(finish) && !text) {
    throw new Error('The model declined to answer this one.');
  }
  return text;
}

// Raced request. Measured on the free tier, identical requests take anywhere from 0.7 s to 7 s
// to start, depending on the server that picks them up. So time-critical requests start
// `parallel` copies at once (the first on the chosen model, the rest on Flash-Lite); if none has
// sent a word within `hedgeMs`, or one fails with an overload / quota error, another starts, up
// to `maxAttempts`. The first to stream wins and the others are cancelled.
function geminiStream(req, settings, onDelta, registerAbort, { hedgeMs = GEMINI_STALL_MS, parallel = 1, maxAttempts = 2 } = {}) {
  if (!settings.geminiKey) return Promise.reject(new Error('Gemini API key is missing. Add it in Settings.'));
  return new Promise((resolve, reject) => {
    const attempts = [];
    let winner = null;
    let settled = false;
    let lastErr = null;
    let hedgeTimer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      for (const a of attempts) if (a !== winner) a.ctrl.abort();
      fn(value);
    };

    const start = (model) => {
      const a = { ctrl: new AbortController(), done: false };
      attempts.push(a);
      geminiStreamOnce(
        model,
        toGeminiBody(req, model),
        settings.geminiKey,
        (t) => {
          if (settled && winner !== a) return;
          if (!winner) {
            winner = a;
            clearTimeout(hedgeTimer);
            for (const o of attempts) if (o !== a) o.ctrl.abort();
          }
          if (winner === a) onDelta(t);
        },
        a.ctrl.signal,
      ).then(
        (text) => {
          a.done = true;
          if (!winner) winner = a;
          if (winner === a) finish(resolve, text);
        },
        (err) => {
          a.done = true;
          if (settled || (winner && winner !== a)) return;
          if (winner === a) return finish(reject, err); // failed mid-answer
          lastErr = err;
          const retryable = err instanceof GeminiError && [429, 500, 503].includes(err.status);
          if (retryable && attempts.length < maxAttempts) return start(GEMINI_FALLBACK);
          if (attempts.every((x) => x.done)) finish(reject, lastErr);
        },
      );
    };

    if (registerAbort) {
      registerAbort(() => {
        for (const a of attempts) a.ctrl.abort();
        finish(reject, new DOMException('The request was cancelled.', 'AbortError'));
      });
    }
    start(settings.model);
    for (let i = 1; i < Math.min(parallel, maxAttempts); i++) start(GEMINI_FALLBACK);
    hedgeTimer = setTimeout(() => {
      if (!winner && !settled && attempts.length < maxAttempts) start(GEMINI_FALLBACK);
    }, hedgeMs);
  });
}

// Per request kind: copies started at once, wait before one more, and the cap.
// Live answers are time-critical; notes and resume parsing are not.
const GEMINI_RACE = {
  answer: { parallel: 2, hedgeMs: 1500, maxAttempts: 3 },
  chat: { parallel: 2, hedgeMs: 2500, maxAttempts: 3 },
  mock: { parallel: 2, hedgeMs: 2500, maxAttempts: 3 },
  screenshot: { parallel: 2, hedgeMs: 6000, maxAttempts: 3 },
};

// Opens the HTTPS connection to Gemini ahead of time so the first answer skips the TLS handshake.
function warmup(settings) {
  if (!isGemini(settings) || !settings.geminiKey) return;
  fetch(`${GEMINI_BASE}?pageSize=1`, { headers: { 'x-goog-api-key': settings.geminiKey } }).catch(() => {});
}

function isAbortError(err) {
  return err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError';
}

// Streams text deltas through onDelta. Returns the final text.
// `registerAbort` receives a function that cancels the request.
async function streamText(kind, payload, settings, onDelta, registerAbort) {
  const req = buildRequest(kind, payload, settings);
  if (isGemini(settings)) {
    return geminiStream(req, settings, onDelta, registerAbort, GEMINI_RACE[kind] || {});
  }
  const client = clientFor(settings);
  const model = settings.model || 'claude-opus-5-5';
  const params = {
    model,
    max_tokens: req.max_tokens,
    system: req.system,
    messages: req.messages,
    output_config: { effort: req.effort || 'low' },
  };

  const stream = FALLBACK_MODELS.has(model)
    ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : client.messages.stream(params);

  if (registerAbort) registerAbort(() => stream.abort());
  stream.on('text', (t) => onDelta(t));

  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('The model declined to answer this one.');
  }
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// Turns an uploaded PDF resume into plain text using Claude.
async function extractPdfText(pdfBuffer, settings) {
  if (isGemini(settings)) {
    const req = {
      max_tokens: 16000,
      effort: 'low',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { type: 'text', text: 'Extract the complete text of this document as clean plain text, keeping the section structure. Output only the text.' },
          ],
        },
      ],
    };
    return geminiStream(req, settings, () => {});
  }
  const client = clientFor(settings);
  const stream = client.messages.stream({
    model: settings.model || 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
          },
          {
            type: 'text',
            text: 'Extract the complete text of this document as clean plain text, keeping the section structure. Output only the text.',
          },
        ],
      },
    ],
  });
  const msg = await stream.finalMessage();
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function describeError(err) {
  if (err instanceof GeminiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return 'Gemini API key is invalid.';
    if (err.status === 401 || err.status === 403) return 'Gemini API key is invalid or has no access to this model.';
    if (err.status === 429) return 'Gemini free-tier limit reached — wait a minute and try again, or switch to Flash-Lite.';
    if (err.status === 503) return 'Gemini is overloaded right now — try again in a moment.';
    return `Gemini API error ${err.status}: ${err.message}`;
  }
  if (err?.cause?.code && /ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED/.test(err.cause.code)) {
    return 'Cannot reach the AI service — check the internet connection.';
  }
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key is invalid.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key has no access to the selected model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic — wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Cannot reach the Anthropic API — check the internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}

module.exports = { streamText, extractPdfText, describeError, isAbortError, isGemini, warmup };
