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

// What kind of question it is decides what the answer contains. Example of the problem this
// fixes: "Explain Docker" got one definition line plus three resume achievements, with no actual
// explanation. Concept questions must be explained; the resume is only for questions about the
// candidate.
const QUESTION_TYPES = [
  'First decide what kind of question it is, and answer THAT question:',
  '(A) CONCEPT / TECHNICAL ("explain Docker", "what is Kubernetes", "difference between X and Y", "how does X work", "why use X"):',
  'actually explain it, in simple everyday words, the way a person who knows it well would explain it out loud: what it is, the problem it solves, how it works (the 2-4 main ideas), and a short real-world example.',
  'Do NOT bring in the resume, projects, companies or achievements for these. Only if the interviewer asks about the candidate\'s own experience with it (for example "have you used Docker?", "how did you use it?") talk about the resume.',
  '(B) ABOUT THE CANDIDATE ("tell me about yourself", "your projects", "your experience with X", "a time when…", "why should we hire you"): answer from the resume with real details,',
  'and for "a time when…" questions tell it as a short story: situation, what I did, result. Build the story from what the resume really says;',
  'if the resume has no matching incident, use the closest real work from it and keep the specifics general rather than inventing incidents, numbers or tools the candidate may be questioned on.',
  'Say resume achievements in your own spoken words, not copied CV phrasing. Do not add analogies to questions about the candidate.',
  '(C) WRITE / CODE / FILE: follow the file and code rule below.',
  '(D) SYSTEM DESIGN: components, data flow, scaling and trade-offs, then a simple ASCII flow like "Client -> API -> Queue -> Worker -> DB".',
].join(' ');

// The candidate reads the answer out loud, so it must sound like a normal person talking, not
// like a written article or an AI. Measured on test answers before this rule: reading ease ~51
// ("fairly difficult"), 15-24 words per sentence, and AI patterns such as "Think of it like…",
// "Imagine…" and "**Label:**" bullets.
const HUMAN_TONE = [
  'TONE: it must sound like a normal person talking to the interviewer, not like an article and not like AI.',
  'Use simple, everyday words, the way you would explain it to a friend who is also a developer. Use a technical term only when needed, and say it plainly.',
  'Short sentences: mostly 8 to 14 words, one idea per sentence. First person, contractions (it\'s, I\'ve, don\'t).',
  'It is fine to start naturally, like "So, Docker is…" or "Yeah, I\'ve used it for…". Do not repeat the question back.',
  'Never use: em dashes, semicolons, "Think of it like/as", "Imagine", "In short", "Essentially", "Basically" more than once, bold labels inside bullets (like "**Cost:**"),',
  '"not only… but also", rhetorical questions, lists of three adjectives, exaggerated enthusiasm ("I\'m excited", "passionate", "thrilled").',
  'Avoid these words: leverage, robust, seamless, streamline, utilize, ensure, crucial, vital, key role, pivotal, foster, enhance, empower, comprehensive, various, numerous, facilitate, optimal, delve, landscape, realm, furthermore, moreover, additionally, spearheaded, cutting-edge, standardized.',
  'If an example helps, say it simply ("For example, …") in one sentence. It should sound a little casual, not polished.',
].join(' ');

const STYLE_GUIDE = {
  spoken: [
    'Format: first line is a **bold, short direct answer** (one sentence, at most 15 words). Then explain in 3-5 short plain sentences, or 2-4 plain bullets (no bold inside them), each easy to say out loud.',
    'For concept questions add one simple example in one sentence.',
    'Length: about 50-110 words, enough to explain properly but quick to read. No headings, no closing summary.',
    HUMAN_TONE,
    ARTIFACT_RULE,
  ].join(' '),
  bullets: [
    'Give short bullet points (max 6 bullets, max 15 words each) the candidate can glance at while speaking. For concept questions the bullets must explain the idea (what it is, why, how, an example), not list achievements.',
    HUMAN_TONE,
    ARTIFACT_RULE,
  ].join(' '),
  detailed: [
    'Write a complete answer as a first-person script the candidate can read out naturally, in short paragraphs (no headings).',
    'For concept questions: what it is, why it exists, how it works, and a simple example. For questions about the candidate: real details from the resume; "a time when" questions as situation -> what I did -> result.',
    'Keep it under 220 words, not counting code.',
    HUMAN_TONE,
    ARTIFACT_RULE,
  ].join(' '),
};

function clientFor(settings) {
  if (!settings.anthropicKey) throw new Error('Anthropic API key is missing. Add it in Settings.');
  return new Anthropic({ apiKey: settings.anthropicKey, maxRetries: 2 });
}

// A pure concept question ("explain Docker", "what is Kubernetes", "difference between X and Y")
// that does not ask about the candidate ("you", "your"). For these the resume is not sent at
// all: asked only by instructions, models still slipped resume achievements into the
// explanation (2 of 4 in testing), which sounds rehearsed.
const CONCEPT_Q =
  /\b(explain|what is|what are|what's|what does|define|definition of|difference between|differences between|compare|how does|how do .+ work|why (do|would) we|why is|when (should|would) (we|one)|advantages|disadvantages|pros and cons|meaning of|concept of|tell me about (docker|kubernetes|the|a|an))\b/i;
const ABOUT_CANDIDATE = /\b(you|your|yours|yourself|you've|you're|you'd)\b/i;

function isConceptQuestion(q) {
  const t = String(q || '');
  return CONCEPT_Q.test(t) && !ABOUT_CANDIDATE.test(t);
}

// Meetings / regular calls do not use the resume or job description, only the
// user's instructions and uploaded documents.
function profileBlock(p, mode = 'interview', { withResume = true } = {}) {
  const meeting = mode === 'meeting';
  const parts = [];
  if (p.name) parts.push(`${meeting ? 'User' : 'Candidate'} name: ${p.name}`);
  if (!meeting && p.role) parts.push(`Role being interviewed for: ${p.role}`);
  if (p.company) parts.push(`Company: ${p.company}`);
  if (!meeting && withResume && p.resume) parts.push(`<resume>\n${p.resume}\n</resume>`);
  if (!meeting && withResume && p.jobDescription) parts.push(`<job_description>\n${p.jobDescription}\n</job_description>`);
  if (p.documents) parts.push(`<reference_documents>\n${p.documents}\n</reference_documents>`);
  if (p.instructions) parts.push(`<${meeting ? 'user' : 'candidate'}_instructions>\n${p.instructions}\n</${meeting ? 'user' : 'candidate'}_instructions>`);
  return parts.length ? parts.join('\n\n') : 'No profile provided.';
}

function copilotSystem(settings, mode, profileOpts = {}) {
  const meeting = mode === 'meeting';
  const intro = meeting
    ? 'You are a real-time meeting copilot for the user. You see a live transcript of a call. "Them" is the other people on the call, "Me" is the user.'
    : 'You are a real-time interview copilot for the candidate. You see a live transcript of a job interview. "Interviewer" is the other side of the call, "Me" is the candidate.';
  const rules = [
    intro,
    'Your job is to give the user the best possible reply to the latest question, fast, that answers exactly what was asked.',
    QUESTION_TYPES,
    'The profile below (resume, job description, reference documents, instructions) is background. Use it when the question is about the candidate; when you use it, use only real details from it and never invent employers, degrees, facts or numbers.',
    'For coding questions and any request to write a file, config, query, script or code: state the approach in one line, then the complete, working code in a fenced block with the right language tag, then key points / complexity. Always write the full code; never only describe it.',
    'The question may arrive in pieces from live speech recognition; answer the complete question the interviewer is asking, using the transcript for context.',
    'The user glances at the answer mid-conversation, so keep it clear and easy to read. Follow the length and format rules in the request.',
    'If the transcript is unclear or garbled, answer the most likely question and do not comment on transcription quality.',
    'Never mention that you are an AI, and never add disclaimers.',
    `Answer in the language the question was asked in.`,
  ];
  return [
    { type: 'text', text: rules.join('\n') },
    {
      type: 'text',
      text: `<profile>\n${profileBlock(settings.profile, mode, profileOpts)}\n</profile>`,
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
    case 'answer': {
      const concept = mode !== 'meeting' && isConceptQuestion(payload.question);
      const hint = concept
        ? 'This is a concept question: explain the concept itself clearly and simply. Do not talk about the candidate\'s own projects or experience.\n\n'
        : '';
      return {
        system: copilotSystem(settings, mode, { withResume: !concept }),
        max_tokens: 4000,
        effort: settings.effort,
        messages: [
          {
            role: 'user',
            content: `Live transcript so far:\n<transcript>\n${transcript || '(empty)'}\n</transcript>\n\nLatest question to answer:\n"${payload.question || 'the most recent question in the transcript'}"\n\n${hint}${style}`,
          },
        ],
      };
    }

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
          if (err instanceof GeminiError && err.status === 429) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
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

// Free-tier quota protection. Racing uses 2-3 requests per question; after a 429 (requests per
// minute used up) the app sends a single request per question for a minute, and a question that
// still hits the limit waits briefly and is retried once instead of failing.
const RATE_LIMIT_COOLDOWN_MS = 60000;
const RATE_LIMIT_RETRY_MAX_MS = 8000;
let rateLimitedUntil = 0;

function retryDelayMs(err) {
  const m = /retry in ([\d.]+)s/i.exec(err.message || '');
  const ms = m ? Math.ceil(parseFloat(m[1]) * 1000) : 3000;
  return Math.min(Math.max(ms, 1000), RATE_LIMIT_RETRY_MAX_MS);
}

async function geminiStreamLive(req, settings, onDelta, registerAbort, race) {
  let cancelled = false;
  let cancelCurrent = null;
  if (registerAbort) {
    registerAbort(() => {
      cancelled = true;
      if (cancelCurrent) cancelCurrent();
    });
  }
  const opts = Date.now() < rateLimitedUntil ? { ...race, parallel: 1, maxAttempts: 2 } : race;
  try {
    return await geminiStream(req, settings, onDelta, (fn) => (cancelCurrent = fn), opts);
  } catch (err) {
    if (cancelled || !(err instanceof GeminiError && err.status === 429)) throw err;
    await new Promise((r) => setTimeout(r, retryDelayMs(err)));
    if (cancelled) throw new DOMException('The request was cancelled.', 'AbortError');
    return geminiStream(req, settings, onDelta, (fn) => (cancelCurrent = fn), { ...race, parallel: 1, maxAttempts: 1 });
  }
}

// ---------------------------------------------------------------- Groq
// Groq (OpenAI-compatible API) runs open models on very fast hardware: measured first word in
// ~0.1 s and a full answer in ~0.3 s for Qwen 3.8 27B, versus 0.5-7 s on Gemini's free tier.
// The free tier allows about 8,000 tokens per minute per model (prompt + answer, and Qwen also
// ~1,000 output tokens per minute), so requests are never raced here. Instead each live request
// tries the chosen Groq model, then the other Groq models (each has its own quota), then Gemini.

const GROQ_URL = 'https://api.groq.com/openai/v1';
const GROQ_PREFIX = 'groq:';
const GROQ_FAST_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
const GROQ_VISION_MODELS = new Set(['qwen/qwen3.8-27b']);
// Kinds that go to Groq; notes and PDF import are long and not time-critical, so they use
// Gemini when a Gemini key is available.
const GROQ_KINDS = new Set(['answer', 'chat', 'mock', 'screenshot']);
// If a Groq model has not sent a word in this long, move on to the next one.
const GROQ_STALL_MS = 3000;

class GroqError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
  }
}

function isGroq(settings) {
  return String(settings.model || '').startsWith(GROQ_PREFIX);
}

// Remaining quota per model, read from Groq's x-ratelimit-* response headers.
const groqBudget = new Map(); // model -> { tokens, resetAt, blockedUntil }

function parseResetMs(v) {
  if (!v) return 0;
  let ms = 0;
  for (const [, n, unit] of String(v).matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    ms += parseFloat(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  }
  return ms;
}

function noteGroqHeaders(model, headers) {
  const tokens = Number(headers.get('x-ratelimit-remaining-tokens'));
  if (!Number.isFinite(tokens)) return;
  groqBudget.set(model, { tokens, resetAt: Date.now() + parseResetMs(headers.get('x-ratelimit-reset-tokens')), blockedUntil: 0 });
}

function groqLooksAvailable(model, estimatedTokens) {
  const b = groqBudget.get(model);
  if (!b) return true;
  const now = Date.now();
  if (b.blockedUntil > now) return false;
  return b.resetAt <= now || b.tokens >= estimatedTokens;
}

function toOpenAiContent(content) {
  if (typeof content === 'string') return content;
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    throw new Error('This file type is not supported by Groq models.');
  });
}

function toGroqBody(req, model) {
  const system = Array.isArray(req.system) ? req.system.map((b) => b.text).join('\n\n') : req.system;
  const effort = req.effort || 'low';
  const body = {
    model,
    stream: true,
    max_tokens: Math.min(req.max_tokens || 4000, 6000),
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) })),
    ],
  };
  // Thinking adds latency: off for Qwen on "Fast", lowest level for GPT-OSS.
  if (model.startsWith('qwen/')) {
    if (effort === 'low') body.reasoning_effort = 'none';
  } else if (model.startsWith('openai/gpt-oss')) {
    body.reasoning_effort = effort === 'high' ? 'high' : effort === 'medium' ? 'medium' : 'low';
  }
  return body;
}

function estimateTokens(body) {
  let chars = 0;
  for (const m of body.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const p of m.content) chars += p.type === 'text' ? p.text.length : 6000; // images ≈ 1.5k tokens
  }
  return Math.ceil(chars / 3.5) + 600; // + a typical answer
}

async function groqStreamOnce(model, body, apiKey, onDelta, signal) {
  const res = await fetch(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  noteGroqHeaders(model, res.headers);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error?.message || message;
    } catch {}
    if (res.status === 429) {
      const b = groqBudget.get(model) || { tokens: 0, resetAt: 0 };
      const retry = Number(res.headers.get('retry-after'));
      b.blockedUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 20000);
      groqBudget.set(model, b);
    }
    throw new GroqError(res.status, message);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const evt = JSON.parse(data);
      if (evt.error) throw new GroqError(500, evt.error.message || 'Groq stream error');
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
    }
  }
  return text;
}

// Live request: chosen Groq model -> the other Groq models -> Gemini (if a key is set).
// Models known to be at their per-minute limit are skipped without waiting.
async function groqStreamLive(kind, req, settings, onDelta, registerAbort) {
  if (!settings.groqKey) throw new Error('Groq API key is missing. Add it in Settings or .env.');
  let cancelled = false;
  let cancelCurrent = null;
  if (registerAbort) {
    registerAbort(() => {
      cancelled = true;
      if (cancelCurrent) cancelCurrent();
    });
  }
  const hasImage = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
  const chosen = settings.model.slice(GROQ_PREFIX.length);
  let models = [...new Set([chosen, ...GROQ_FAST_MODELS])];
  if (hasImage) models = models.filter((m) => GROQ_VISION_MODELS.has(m));

  let lastErr = null;
  for (const model of models) {
    if (cancelled) break;
    const body = toGroqBody(req, model);
    if (!groqLooksAvailable(model, estimateTokens(body))) continue;
    const ctrl = new AbortController();
    cancelCurrent = () => ctrl.abort();
    let started = false;
    let stalled = false;
    const timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, GROQ_STALL_MS);
    try {
      return await groqStreamOnce(model, body, settings.groqKey, (t) => {
        if (!started) clearTimeout(timer);
        started = true;
        onDelta(t);
      }, ctrl.signal);
    } catch (err) {
      if (cancelled) throw err;
      if (started) throw err; // failed mid-answer: do not mix two answers
      lastErr = err;
      const fallThrough = stalled || (err instanceof GroqError && [429, 500, 502, 503].includes(err.status));
      if (!fallThrough) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (cancelled) throw new DOMException('The request was cancelled.', 'AbortError');
  if (settings.geminiKey) {
    const gemini = { ...settings, model: GEMINI_FALLBACK };
    return geminiStreamLive(req, gemini, onDelta, (fn) => (cancelCurrent = fn), GEMINI_RACE[kind] || {});
  }
  throw lastErr || new GroqError(429, 'All Groq models are at their per-minute limit.');
}

// Opens the HTTPS connection ahead of time so the first answer skips the TLS handshake.
function warmup(settings) {
  if (isGroq(settings) && settings.groqKey) {
    fetch(`${GROQ_URL}/models`, { headers: { Authorization: `Bearer ${settings.groqKey}` } }).catch(() => {});
  }
  if (settings.geminiKey && (isGemini(settings) || isGroq(settings))) {
    fetch(`${GEMINI_BASE}?pageSize=1`, { headers: { 'x-goog-api-key': settings.geminiKey } }).catch(() => {});
  }
}

function isAbortError(err) {
  return err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError';
}

// Streams text deltas through onDelta. Returns the final text.
// `registerAbort` receives a function that cancels the request.
async function streamText(kind, payload, settings, onDelta, registerAbort) {
  const req = buildRequest(kind, payload, settings);
  if (isGroq(settings)) {
    if (GROQ_KINDS.has(kind) || !settings.geminiKey) return groqStreamLive(kind, req, settings, onDelta, registerAbort);
    // Long, non-urgent work (post-call notes) goes to Gemini to keep Groq's per-minute quota free.
    return geminiStreamLive(req, { ...settings, model: GEMINI_FALLBACK }, onDelta, registerAbort, {});
  }
  if (isGemini(settings)) {
    return geminiStreamLive(req, settings, onDelta, registerAbort, GEMINI_RACE[kind] || {});
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
  // Groq models cannot read PDFs; use Gemini for this when a key is available.
  if (isGroq(settings)) {
    if (!settings.geminiKey) throw new Error('Reading PDFs needs a Gemini key (Groq models cannot read PDFs). Paste the text, or import a Word/TXT file.');
    settings = { ...settings, model: GEMINI_FALLBACK };
  }
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
  if (err instanceof GroqError) {
    if (err.status === 401) return 'Groq API key is invalid.';
    if (err.status === 429) return 'Groq free-tier limit reached for this minute — add a Gemini key as backup, or wait a moment.';
    if (err.status === 413) return 'This request is too large for Groq’s free tier — shorten the resume or instructions.';
    return `Groq API error ${err.status}: ${err.message}`;
  }
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

module.exports = { streamText, extractPdfText, describeError, isAbortError, isGemini, isGroq, warmup };
