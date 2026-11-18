// All Claude calls: live answers, chat, screenshot solving, post-call notes,
// mock-interviewer turns and resume text extraction.
const Anthropic = require('@anthropic-ai/sdk');

// Models that support server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const STYLE_GUIDE = {
  spoken:
    'Write it as natural first-person speech the candidate can say out loud. Start with a one-sentence direct answer in **bold**, then 3-5 short bullet points with the supporting points or a concrete example (STAR format for behavioural questions). Keep it under 150 words.',
  bullets:
    'Give only short keyword bullet points (max 6 bullets, max 12 words each) the candidate can glance at while speaking. No full sentences.',
  detailed:
    'Give a thorough answer: a bold one-line summary, then a structured explanation with examples. Use headings only if it helps. Keep it under 350 words.',
};

function clientFor(settings) {
  if (!settings.anthropicKey) throw new Error('Anthropic API key is missing. Add it in Settings.');
  return new Anthropic({ apiKey: settings.anthropicKey, maxRetries: 2 });
}

function profileBlock(p) {
  const parts = [];
  if (p.name) parts.push(`Candidate name: ${p.name}`);
  if (p.role) parts.push(`Role being interviewed for: ${p.role}`);
  if (p.company) parts.push(`Company: ${p.company}`);
  if (p.resume) parts.push(`<resume>\n${p.resume}\n</resume>`);
  if (p.jobDescription) parts.push(`<job_description>\n${p.jobDescription}\n</job_description>`);
  if (p.instructions) parts.push(`<candidate_instructions>\n${p.instructions}\n</candidate_instructions>`);
  return parts.length ? parts.join('\n\n') : 'No profile provided.';
}

function copilotSystem(settings, mode) {
  const meeting = mode === 'meeting';
  const intro = meeting
    ? 'You are a real-time meeting copilot for the user. You see a live transcript of a call. "Them" is the other people on the call, "Me" is the user.'
    : 'You are a real-time interview copilot for the candidate. You see a live transcript of a job interview. "Interviewer" is the other side of the call, "Me" is the candidate.';
  const rules = [
    intro,
    'Your job is to give the user the best possible reply to the latest question, fast. Use the profile below (resume, job description, instructions) so answers are specific to the user — use real details from the resume, never invent employers, degrees or numbers that are not in it.',
    'For coding questions: state the approach in 1-2 lines, then give clean code in a fenced block, then time/space complexity.',
    'For system design questions: give the key components, data flow, scaling and trade-offs as bullets, then a simple mermaid-free ASCII flow like "Client -> API -> Queue -> Worker -> DB".',
    'If the transcript is unclear or garbled, answer the most likely question and do not comment on transcription quality.',
    'Never mention that you are an AI, and never add disclaimers.',
    `Answer in the language the question was asked in.`,
  ];
  return [
    { type: 'text', text: rules.join('\n') },
    {
      type: 'text',
      text: `<profile>\n${profileBlock(settings.profile)}\n</profile>`,
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
  const transcript = formatTranscript(payload.transcript || [], mode);

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

// Streams text deltas through onDelta. Returns the final text.
// `registerAbort` receives a function that cancels the request.
async function streamText(kind, payload, settings, onDelta, registerAbort) {
  const client = clientFor(settings);
  const req = buildRequest(kind, payload, settings);
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
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API key is invalid.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key has no access to the selected model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic — wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Cannot reach the Anthropic API — check the internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}

module.exports = { streamText, extractPdfText, describeError };
