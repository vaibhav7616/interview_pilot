# Interview Pilot

Real-time AI copilot for Windows: listens to your interview or call, transcribes both sides live,
detects questions and shows a suggested answer in a small always-on-top overlay.

Same feature set as ParakeetAI's desktop assistant, built from scratch:

| Feature | How it works here |
|---|---|
| Live transcript (both sides) | Computer audio (WASAPI loopback, via Electron) = interviewer, microphone = you, streamed as 2 channels to Deepgram Nova-3 |
| Auto answer | Detects when the interviewer finishes a question, then streams an answer from Claude |
| Manual answer | `Answer` button / `Ctrl+Shift+Enter` answers the latest question |
| Resume / JD / instructions | Import PDF/DOCX/TXT or paste; instructions up to 20,000 characters; cached with prompt caching |
| Coding & screen questions | `Screenshot` / `Ctrl+Shift+S` captures the screen and solves what's on it (code, MCQ, design, errors) |
| Private chat | Type any question to the AI during the call |
| Modes | Interview, Meeting / call, Mock interview (AI interviewer speaks questions, listens, scores you) |
| AI notes | Summary, questions asked, key points and next steps after each call |
| History | All sessions saved locally, export as Markdown |
| Hidden from screen share | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`: Zoom/Teams/Meet/OBS see nothing (Windows 10 2004+ / Server 2022+) |
| Other | Hide from taskbar, opacity, click-through, move with hotkeys, 12 call languages + auto/multilingual |

Works with any call app (Zoom, Teams, Meet, Webex, browser calls) because it listens to the PC's audio output. No bot joins the meeting.

## What you need

1. **Anthropic API key**: https://console.anthropic.com → API keys.
2. **Deepgram API key** for live transcription: https://console.deepgram.com (new accounts get free credit).
3. Windows 10 (2004 or newer) / Windows 11 / Windows Server 2022+, x64.
4. **Headphones** strongly recommended, so the mic does not pick up the interviewer too.

Enter both keys in **Settings** inside the app. They are stored encrypted with Windows DPAPI.

## Install

Run `dist/Interview Pilot Setup 1.0.0.exe` (installer) or `dist/Interview Pilot 1.0.0.exe` (portable, no install).
Windows SmartScreen will warn because the app is not code-signed: *More info → Run anyway*.

## Use

1. **Setup** tab: pick a mode, fill name/role/company, import your resume, paste the job description.
2. Press **Start session**. Join your call as normal.
3. Questions from the interviewer appear in the transcript; answers appear automatically (toggle **Auto answer**).
4. Press **End** → the session is saved and AI notes are generated (History tab).

### Shortcuts (work even when the window is not focused)

| Keys | Action |
|---|---|
| `Ctrl+Shift+Space` | Show / hide window |
| `Ctrl+Shift+Enter` | Answer now |
| `Ctrl+Shift+S` | Screenshot & solve |
| `Ctrl+Shift+A` | Auto answer on/off |
| `Ctrl+Shift+X` | Click-through on/off |
| `Ctrl+Shift+Arrows` | Move window |

### Models

Settings → Model: Claude Opus 5.5 (best quality, default), Sonnet 5.5 (faster), Haiku 5.5 (fastest/cheapest).
"Depth" controls how much the model thinks: *Fast* is best for live answers.

## Windows Server notes

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
