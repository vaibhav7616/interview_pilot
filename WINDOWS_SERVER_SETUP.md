# Interview Pilot — Windows Server Setup Guide

Step-by-step setup of Interview Pilot on **Windows Server 2022 / 2025**, including audio,
Remote Desktop, network and troubleshooting.

> **Key rule:** Interview Pilot must run **in the same Windows session as the call** (Zoom / Teams /
> Meet in the browser). It captures what that session plays (the interviewer) and that session's
> microphone (you). It cannot listen to a call running on a different PC.

---

## 1. Requirements

| Item | Requirement |
|---|---|
| OS | Windows Server 2022 (build 20348) or Windows Server 2025, 64-bit |
| Edition | **Desktop Experience** (with GUI). *Server Core is not supported.* |
| CPU / RAM | 2 vCPU, 4 GB RAM minimum (8 GB recommended if the call app also runs here) |
| Disk | 500 MB free |
| Network | Outbound HTTPS/WSS (port 443) to `api.anthropic.com` and `api.deepgram.com` |
| Accounts | Anthropic API key (console.anthropic.com) and Deepgram API key (console.deepgram.com) |
| Access | A local administrator account for steps 2–4 |

Check the build number (must be **20348 or higher**; needed for hide-from-screen-share):

```powershell
[System.Environment]::OSVersion.Version
```

---

## 2. Install required Windows features

Open **PowerShell as Administrator**:

```powershell
# Media Foundation (Chromium/Electron audio & video stack on Server)
Install-WindowsFeature Server-Media-Foundation

# Optional but recommended for a desktop-like experience over RDP
Install-WindowsFeature RDS-RD-Server -IncludeManagementTools   # only if several users will use it at once (needs RDS licensing)

Restart-Computer
```

> Single admin user over RDP? Skip `RDS-RD-Server` — the built-in 2 admin RDP sessions are enough.

---

## 3. Turn on audio

Windows Server ships with audio **disabled**. In PowerShell as Administrator:

```powershell
Set-Service -Name Audiosrv            -StartupType Automatic
Set-Service -Name AudioEndpointBuilder -StartupType Automatic
Start-Service AudioEndpointBuilder
Start-Service Audiosrv

Get-Service Audiosrv, AudioEndpointBuilder   # both must show "Running"
```

### Allow microphone access

1. **Settings → Privacy → Microphone** (Server 2022: *Settings → Privacy & security → Microphone*).
2. Turn on **Allow apps to access your microphone** and **Allow desktop apps to access your microphone**.

---

## 4. Audio over Remote Desktop (most common setup)

A server or VM usually has **no sound card**. When you connect with Remote Desktop, Windows creates a
virtual **"Remote Audio"** device in your session — Interview Pilot captures that.

### 4a. Server side: allow audio redirection (Group Policy)

1. Run `gpedit.msc`.
2. Go to **Computer Configuration → Administrative Templates → Windows Components → Remote Desktop
   Services → Remote Desktop Session Host → Device and Resource Redirection**.
3. Set to **Enabled**:
   - **Allow audio and video playback redirection**
   - **Allow audio recording redirection**
4. Apply immediately:

```powershell
gpupdate /force
```

### 4b. Client side: Remote Desktop Connection (mstsc) settings

On the PC you connect **from**:

1. Open **Remote Desktop Connection** → **Show Options** → **Local Resources** tab.
2. **Remote audio → Settings…**
   - Remote audio playback: **Play on this computer**
   - Remote audio recording: **Record from this computer**
3. **Keyboard → Apply Windows key combinations:** *On the remote computer* (so the
   `Ctrl+Shift+…` shortcuts reach the app).
4. **Save** the connection profile, then connect.

> Using an `.rdp` file? Make sure it contains `audiomode:i:0` and `audiocapturemode:i:1`.

### 4c. Verify inside the RDP session

- Taskbar speaker icon should show **Remote Audio**.
- **Settings → System → Sound**: Output = *Remote Audio*, Input = *Remote Audio* (your local mic).
- Play any YouTube video in Edge — you should hear it on your local PC.

### Not using RDP? (console / hypervisor window)

The VM has no audio device. Either:
- add a virtual sound card in the hypervisor (Hyper-V Enhanced Session, VMware "Sound card", etc.), or
- install a virtual audio driver such as **VB-CABLE** and set it as the default playback device.

Without an audio output device, Windows has nothing to capture and the 🔊 meter will stay empty.

---

## 5. Install a browser for the call

Windows Server 2022/2025 includes **Microsoft Edge**. Google Chrome also works. Install the call app
you need (Zoom / Teams desktop) or use the web version in the browser.

The first time you join a call, allow the browser to use the **microphone**.

---

## 6. Install Interview Pilot

### Option A — Portable zip (no build needed)

1. Copy `Interview Pilot-1.0.0-win.zip` to the server (RDP clipboard / drive redirection / download).
2. In PowerShell (admin):

```powershell
$zip = "$env:USERPROFILE\Downloads\Interview Pilot-1.0.0-win.zip"
Unblock-File $zip                                   # removes the "downloaded from internet" block
Expand-Archive $zip -DestinationPath "C:\Program Files\Interview Pilot" -Force

# Desktop shortcut for all users
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("C:\Users\Public\Desktop\Interview Pilot.lnk")
$s.TargetPath = "C:\Program Files\Interview Pilot\Interview Pilot.exe"
$s.Save()
```

### Option B — Build the installer on the server from GitHub

```powershell
# 1. Install Node.js LTS and Git
Invoke-WebRequest https://nodejs.org/dist/v20.18.1/node-v20.18.1-x64.msi -OutFile $env:TEMP\node.msi
Start-Process msiexec.exe -ArgumentList "/i `"$env:TEMP\node.msi`" /qn" -Wait
Invoke-WebRequest https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe -OutFile $env:TEMP\git.exe
Start-Process $env:TEMP\git.exe -ArgumentList "/VERYSILENT /NORESTART" -Wait
# Close and reopen PowerShell so node, npm and git are on PATH

# 2. Get the code and build
cd C:\
git clone https://github.com/vaibhav7616/interview_pilot.git
cd interview_pilot
npm ci
npm run dist:win
```

The installer `dist\Interview Pilot Setup 1.0.0.exe` and portable `dist\Interview Pilot 1.0.0.exe` are created.
Run the installer.

> **SmartScreen warning** ("Windows protected your PC"): the app is not code-signed.
> Click **More info → Run anyway**.

---

## 7. Network / firewall

Interview Pilot only makes **outbound** connections on port 443:

| Host | Used for |
|---|---|
| `api.anthropic.com` | AI answers, notes, practice interviews |
| `api.deepgram.com` | Live transcription (secure WebSocket) |

Test from the server:

```powershell
Test-NetConnection api.anthropic.com -Port 443
Test-NetConnection api.deepgram.com  -Port 443
```

Both must show `TcpTestSucceeded : True`. If the server uses a proxy, set it in
**Settings → Network & Internet → Proxy** (Interview Pilot uses the system proxy).
No inbound ports need to be opened.

---

## 8. First run

1. Start **Interview Pilot** (Desktop shortcut or Start menu).
2. **Settings** tab:
   - Paste the **Anthropic API key** and **Deepgram API key** (saved automatically, encrypted per user).
   - Model: *Claude Opus 5.5* (best) / *Sonnet 5.5* (faster) / *Haiku 5.5* (cheapest).
   - Call language: pick the language spoken on the call.
   - **Hide from screen sharing**: leave **On**.
3. **Session** tab: choose *Interview*, fill your name, position, company, import your resume (PDF/Word),
   paste the job description.

---

## 9. Test before a real interview (5 minutes)

1. Open a YouTube interview video in Edge **inside the RDP session**.
2. In Interview Pilot press **Start session**.
3. Check the Live tab:
   - **Interviewer** level bar moves with the video audio.
   - **You** level bar moves when you speak into your local mic.
   - Status pill shows **Listening** (green).
   - Transcript lines appear for both sides; answers appear after questions.
4. **Screen-share test:** start a Teams/Zoom meeting, share the **entire screen**, and look at the share
   preview (or join from your phone). The Interview Pilot window must **not** be visible.
5. Press **End session** → History shows the session with AI notes.

---

## 10. Daily use

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Show / hide window |
| `Ctrl+Shift+Enter` | Answer now |
| `Ctrl+Shift+S` | Capture screen and solve |
| `Ctrl+Shift+A` | Auto-answer on/off |
| `Ctrl+Shift+X` | Click-through on/off |
| `Ctrl+Shift+Arrows` | Move window |

- Use **headphones** on your local PC so your mic doesn't pick up the interviewer.
- Keep the RDP window **open** (not minimised) during a call — minimising RDP can pause audio
  redirection.

---

## 11. Multiple users on one server

- Each Windows user has separate settings, API keys and history in
  `C:\Users\<user>\AppData\Roaming\Interview Pilot\`.
- Every user needs their own RDP session with audio redirection (step 4b).
- More than 2 simultaneous users requires the **RDS-RD-Server** role and RDS CALs.

---

## 12. Updating

- **Zip install:** close the app, extract the new zip over `C:\Program Files\Interview Pilot`.
- **Built from GitHub:**

```powershell
cd C:\interview_pilot
git pull
npm ci
npm run dist:win
```

  then run the new installer. Settings and history are kept.

---

## 13. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| **Interviewer** bar never moves | No playback device. Check step 3 (services running) and step 4b (*Play on this computer*). Sound settings must show *Remote Audio* as output. |
| **You** bar never moves | Mic not redirected: step 4a (*Allow audio recording redirection*) + step 4b (*Record from this computer*) + microphone privacy (step 3). Reconnect RDP after changing. |
| "Computer audio is not available on this system" | No audio endpoint in the session — see step 4 / "Not using RDP?". |
| "Deepgram API key is invalid" | Re-paste the key in Settings; check it has streaming access in the Deepgram console. |
| "Anthropic API key is invalid" / "no access to the selected model" | Re-paste the key; check billing is active in console.anthropic.com, or pick another model. |
| "Cannot reach the Anthropic API" / status stuck on *Connecting* | Firewall or proxy — run the `Test-NetConnection` checks in step 7. |
| Interviewer's words appear as "You" too | Speaker echo — use headphones on your local PC. |
| Window visible in screen share | OS build below 20348, or *Hide from screen sharing* is off in Settings. |
| Shortcuts don't work | RDP keyboard setting (step 4b-3), or another app already uses the same shortcut. |
| App doesn't start / blank window | Install Media Foundation (step 2) and reboot; run `Unblock-File` on the zip before extracting. |
| Audio stops when RDP is minimised | Keep the RDP window open or in windowed mode during calls. |

Logs: start the app from PowerShell to see errors:

```powershell
& "C:\Program Files\Interview Pilot\Interview Pilot.exe" --enable-logging
```

---

## 14. Uninstall

- Installer version: **Settings → Apps → Interview Pilot → Uninstall**.
- Zip version: delete `C:\Program Files\Interview Pilot` and the desktop shortcut.
- Remove saved settings/history (optional): delete `%APPDATA%\Interview Pilot`.
