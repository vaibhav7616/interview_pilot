# Interview Pilot

Real-time AI copilot for Windows: listens to your interview or call, transcribes both sides live,
detects questions and shows a suggested answer in a small always-on-top overlay.

Same feature set as ParakeetAI's desktop assistant, built from scratch:

| Feature | How it works here |
|---|---|
| Live overlay | Dark floating toolbar centered at the top of the screen: mic/speaker indicators, timer, Answer, Screenshot, Chat, move, collapse, menu, End. Sized to its content so it never blocks clicks around it |
| Live transcript (both sides) | Computer audio (WASAPI loopback, via Electron) = interviewer, microphone = you, streamed as 2 channels to Deepgram Nova-3. Latest words as chips; full transcript on demand; Clear |
| Auto answer | Detects when the interviewer finishes a question, then streams an answer (Gemini or Claude). Toggle in the overlay |
| Manual answer | `Answer` button / `Ctrl+Shift+Enter` answers the latest question |
| Answer panel | One answer at a time; browse previous/next, copy, rate 👍/👎, Clear, expand to a larger view |
| Resume / JD / documents / instructions | Import PDF/DOCX/TXT or paste; extra reference documents; instructions up to 20,000 characters |
| Coding & screen questions | `Screenshot` / `Ctrl+Shift+S` captures the screen and solves what's on it (code, MCQ, design, errors) |
| Private chat | `Chat` / `Ctrl+Shift+K`: type any question to the AI during the call |
| Modes | Interview (uses resume), Regular call (no resume), Mock interview (AI interviewer speaks, listens, gives feedback) |
| Per-session choices | Call language (57 languages + auto-detect), AI model, answer format (Bullet points / Script + bullets / Full script); also changeable mid-call from the overlay menu |
| Leave for now | Back to the dashboard while the session keeps listening; *Return to session* reopens the overlay |
| AI notes | Summary, questions asked, key points and next steps after each call |
| History | All sessions saved locally; filter by mode, search by title/role/company; duration and answer count; save transcript as Markdown |
| Hidden from screen share | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`: Zoom/Teams/Meet/OBS see nothing (Windows 10 2004+ / Server 2022+). During a session the window is also removed from the taskbar and has no title |
| Other | Hide from taskbar, overlay opacity, click-through, move with drag or hotkeys |

Not included (web-service features of ParakeetAI, not part of the desktop assistant): resume maker, headshots,
credits/plans, mobile web app.

Works with any call app (Zoom, Teams, Meet, Webex, browser calls) because it listens to the PC's audio output. No bot joins the meeting.

## What you need

1. An AI key, either one:
   - **Gemini API key** (free tier): https://aistudio.google.com → Get API key. A Gemini app subscription (Google AI Pro) does not include API access; the API key is separate.
   - **Anthropic API key**: https://console.anthropic.com → API keys.
2. **Deepgram API key** for live transcription: https://console.deepgram.com (new accounts get free credit).
3. Windows 10 (2004 or newer) / Windows 11 / Windows Server 2022+, x64.
4. **Headphones** strongly recommended, so the mic does not pick up the interviewer too.

Enter the keys in **Settings** inside the app (stored encrypted with Windows DPAPI), **or** put them in a `.env` file
so you never have to type them: copy `.env.example` to `.env` and fill in `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`
(and optionally `ANTHROPIC_API_KEY`). The app looks for `.env` in the project folder, next to the `.exe`, then in
`%APPDATA%\Interview Pilot`. Keys from `.env` take priority over Settings and are not copied into the settings file.
`.env` is git-ignored; never commit it.

## Install

Run `dist/Interview Pilot Setup 1.0.0.exe` (installer) or `dist/Interview Pilot 1.0.0.exe` (portable, no install).
Windows SmartScreen will warn because the app is not code-signed: *More info → Run anyway*.

## Use

1. The app opens as a dashboard centered on the screen. **New session**: pick a mode, fill name/role/company,
   language, model and answer format, import your resume, paste the job description, add documents.
2. Press **Start session**: the window becomes the overlay at the top-center of the screen. Join your call as normal.
3. The interviewer's words scroll by in the transcript strip; answers appear automatically (toggle **Auto-answer**).
4. Press **End** → the session is saved and AI notes are generated (History).

### Shortcuts (work even when the window is not focused)

`Ctrl+Q` and `Ctrl+Shift+Space` work at any time. The rest are active only while the overlay is showing, so they never take
keys away from other apps otherwise. They avoid `Ctrl+Shift+Arrows`, which selects words in code editors.

| Keys | Action |
|---|---|
| `Ctrl+Q` (or `Ctrl+Shift+Space`) | Hide / show the window. While hidden the session keeps listening and answering |
| `Ctrl+Shift+Enter` | Answer now |
| `Ctrl+Shift+S` | Screenshot & solve |
| `Ctrl+Shift+K` | Chat (type a question) |
| `Ctrl+Alt+←` / `Ctrl+Alt+→` | Previous / next answer |
| `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | Scroll the answer slowly (hold to keep scrolling, about 220 px per second) |
| `Ctrl+Shift+Backspace` | Clear answers |
| `Ctrl+Shift+A` | Auto answer on/off |
| `Ctrl+Shift+X` | Click-through on/off |
| `Ctrl+<` / `Ctrl+>` (comma / full-stop key, with or without Shift) | Move the answer box between its 3 positions: left corner, middle, right corner |

### Models

Settings or New session → AI model (Groq Qwen is the default):

- **Qwen 3.8 27B on Groq** (default, free key from console.groq.com, `GROQ_API_KEY`): fastest. Measured about
  0.2-0.5 s to the first word and a full answer in under 0.6 s, including code and screenshots.
  Groq's free tier allows about 8,000 tokens per minute per model (roughly 3-5 answers a minute with a resume),
  so live answers go chosen Groq model → GPT-OSS 20B → GPT-OSS 120B on Groq (each has its own quota) → Gemini
  Flash-Lite if a Gemini key is set. Post-call notes and PDF import use Gemini, since Groq models can't read PDFs.
- **GPT-OSS 120B / 20B on Groq**: also fast; 120B is a bit stronger and a bit slower.
- **Gemini Flash-Lite** (free tier): 0.5-7 s to the first word, depending on Google's free-tier load. The app
  sends 2 copies of each live question and uses whichever starts first.
- **Gemini Flash** (free tier): stronger, but often overloaded on the free tier. If it fails (503/429) or sends
  nothing for 20 s, the app retries the request on Flash-Lite automatically.
- **Claude Opus 5.5** (best quality), **Sonnet 5.5** (faster), **Haiku 5.5** (fastest/cheapest): need an Anthropic key.

Gemini Pro is not offered: the Gemini API free tier has no Pro quota.
On the free tier, Google may use prompts (including your resume and transcript) to improve its products.

"Response speed" controls how much the model thinks: *Fast* is best for live answers.

## Windows Server notes

**Full step-by-step guide: [WINDOWS_SERVER_SETUP.md](WINDOWS_SERVER_SETUP.md)**


- Turn on audio: `Set-Service Audiosrv -StartupType Automatic; Start-Service Audiosrv` (PowerShell as admin).
- Over Remote Desktop, enable *Remote audio → Play on this computer* on the client side, so call audio is sent
  through the RDP device the app captures. Test with the 🔊 meter on the Live tab.
- The app must run in the same Windows session as the call.

## Develop

```bash
npm install
npm start                 # run in dev (on Linux add: -- --no-sandbox)
npm run check             # syntax check
npm run dist:win          # build installer + portable exe into dist/
```

Building on Linux works without Wine because `signAndEditExecutable` is off (default Electron icon).
For a custom icon and exe metadata, build on Windows or install Wine, add `build/icon.ico`, and remove that flag.

### Layout

```
src/main.js            window, hotkeys, loopback capture, IPC, screenshots
src/stt.js             Deepgram streaming client (2-channel, reconnects)
src/ai.js              Claude prompts and streaming (answer, chat, screenshot, notes, mock, PDF text)
src/store.js           settings (DPAPI-encrypted keys) and session files in %APPDATA%\Interview Pilot
src/preload.js         safe IPC bridge
src/renderer/          UI (index.html, app.js, styles.css) and the PCM audio worklet
```

## Costs (approximate)

- Deepgram Nova-3 streaming is billed per audio minute **per channel**, and this app sends 2 channels (you + them). See https://deepgram.com/pricing for current rates.
- Claude: each answer is about 3-6K input tokens (resume cached) and 300 output tokens. Opus 5.5 costs about $0.01-0.02 per answer; Haiku 5.5 costs much less.
