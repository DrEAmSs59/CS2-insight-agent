# 🎮 CS2 Insight Agent — Player Guide

> **CS2 Insight Agent** is your personal CS2 highlight director and video-production tool.
>
> It parses CS2 demo files, finds highlights and funny fails, optionally adds AI scores and commentary, controls CS2 Replay and OBS to record clips automatically, and lets you arrange clips with BGM, intros, outros, and player cards into a finished compilation.

<p align="center">
  <a href="./PLAYER_GUIDE.md">简体中文</a> | English
</p>

---

## ⚠️ Before You Start

> [!CAUTION]
> - **Free and open source.** This project is fully open source, free to use, and has no paywall for core features.
> - **Read the guide first.** Please read this guide and the notes in each feature screen before recording.
> - **Troubleshoot before reporting an issue.** Check the [FAQ](#10-faq) and the relevant section first. If the issue remains, report it to the developer with the details of your setup.
> - **Support is maintained in spare time.** Replies may not be immediate, but reports are read when possible.
> - **Optional support.** If the app saves you editing time, you can [buy the developer a coffee](#support-the-project). It is entirely optional.

---

## 📺 Video Tutorial

Prefer a walkthrough? Watch the community video tutorial first:

- [▶ BV1PcVj69ExZ — CS2 Insight Agent tutorial](https://www.bilibili.com/video/BV1PcVj69ExZ/)

> [!TIP]
> For a first setup, watch the video once, then use this guide to configure OBS and FFmpeg step by step.

---

## 🎬 Example Output

### Automatically edited game clips

- [▶ BV1ZkGi6YENF](https://www.bilibili.com/video/BV1ZkGi6YENF/)
- [▶ BV1TPGq67EFS](https://www.bilibili.com/video/BV1TPGq67EFS/)

> [!NOTE]
> In these examples, the creator added the intro/outro BGM and team logo; the in-game clips were automatically edited by CS2 Insight Agent.

### End-to-end edited compilations

- [▶ BV1KF5s6nEed](https://www.bilibili.com/video/BV1KF5s6nEed/)
- [▶ BV1G198BkEHd](https://www.bilibili.com/video/BV1G198BkEHd/)

> [!NOTE]
> In these examples, both the intro/outro BGM and the game clips were produced with CS2 Insight Agent.

---

## Contents

1. [What You Need](#1-what-you-need)
2. [Download and Install](#2-download-and-install)
3. [First Launch and Updates](#3-first-launch-and-updates)
4. [Configure OBS (Required for Recording)](#4-configure-obs-required-for-recording)
5. [Configure AI Mode (Optional)](#5-configure-ai-mode-optional)
6. [Core Workflow: Parse a Demo](#6-core-workflow-parse-a-demo)
7. [One-Click Automatic Recording](#7-one-click-automatic-recording)
8. [Compilation Workbench (Optional)](#8-compilation-workbench-optional)
9. [Demo Library](#9-demo-library)
10. [FAQ](#10-faq)

---

## 1. What You Need

| Item | Required? | Purpose |
| --- | --- | --- |
| Windows 10 or 11 PC | ✅ Yes | The app currently supports Windows only. |
| CS2 installed through Steam | ✅ Yes | Needed for local demo playback and recording. |
| OBS Studio | 🎬 For recording | Records clips under the app's control. |
| FFmpeg | 🎬 For compilation export | Renders an MP4 from the Compilation Workbench. |
| LLM API key | 💡 Optional | Enables AI scores and commentary. |

---

## 2. Download and Install

### Step 1: Download the installer

Open the project's [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases) and download the latest **`CS2-Insight-Agent-Setup-x.x.x.exe`** installer.

### Step 2: Run the installer

Double-click the downloaded `.exe` and follow the installer prompts.

> [!IMPORTANT]
> Use an installation path without non-ASCII characters when possible. For example:
>
> - ✅ `D:\CS2-Insight-Agent\`
> - ✅ `C:\Program Files\CS2-Insight-Agent\`
> - ⚠️ A path containing Chinese or other non-ASCII characters may cause compatibility problems.

> [!NOTE]
> Windows SmartScreen may show a “Windows protected your PC” prompt for a newly distributed installer. This is a reputation warning, not an indication of malware. Select **More info** → **Run anyway** only after confirming that you downloaded the installer from the official Releases page.

### Step 3: Launch it

After installation, **CS2 Insight Agent** shortcuts are available from the desktop and Start menu.

---

## 3. First Launch and Updates

Double-click the desktop shortcut. The app opens as a desktop application: you do not need to open a browser or start a backend service manually.

The app checks for updates when it starts. When a new release is available, use the prompt in the upper-right corner to download and install it. Your settings and demo-library data are retained.

You can also install a newer installer from the [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases) over the existing version.

---

## 4. Configure OBS (Required for Recording)

Skip this section if you only want to parse demos and browse clip cards. OBS is required to record video clips.

### Step 1: Install OBS Studio

Download [OBS Studio](https://obsproject.com/download), choose **Windows**, and install it with the default options. OBS 28.0 or later is recommended because it includes WebSocket support.

### Step 2: Enable OBS WebSocket

CS2 Insight uses OBS WebSocket to control recording.

1. Open **OBS Studio**.
2. Choose **Tools** → **WebSocket Server Settings**.
3. Enable **WebSocket server**.
4. Keep the default port, `4455`, unless you need a different one. Set or generate a password and save it.

> [!TIP]
> You can disable authentication and leave the password blank in CS2 Insight, but keeping authentication enabled is safer.

### Step 3: Connect OBS in CS2 Insight

Go to **Settings** → **Video Settings**.

1. Under launch settings, choose **Auto-detect OBS**. If it is not found, enter the full `obs64.exe` path, for example:

   ```text
   C:\Program Files\obs-studio\bin\64bit\obs64.exe
   ```

2. Under connection settings, enter the same details as in OBS:
   - Host: `localhost`
   - Port: `4455`
   - Password: the WebSocket password you set in OBS
3. Select **Configuration Check**. The app can launch OBS when needed and verifies both the executable path and WebSocket connection.
4. After it connects, use **One-click Calibration** to inspect the recording setup. If necessary, use **One-click Repair**. It only manages the dedicated `CS2 Insight Recording` scene and can create its Game Capture source and correct common canvas/output resolution, stretch, recording-format, and recording-quality problems.

> [!TIP]
> If calibration says the recording encoder changed, restart OBS before recording.

> [!IMPORTANT]
> Configuration Check can launch OBS, but do not close OBS once recording starts. The app uses WebSocket to start and stop its recording.

If the check fails, confirm that WebSocket is enabled, the OBS path/port/password are correct, and OBS is version 28.0 or later. Older OBS versions require the separate obs-websocket plugin.

---

## 5. Configure AI Mode (Optional)

AI mode adds a **0–100 score** and a short, sharp commentary line for each highlight or fail. All other features work without it.

### Supported providers

| Provider | Example model | Notes |
| --- | --- | --- |
| **DeepSeek** | `deepseek-chat` | Recommended low-cost option. |
| Qwen | `qwen-plus` | OpenAI-compatible API. |
| Zhipu GLM | `glm-4-flash` | Availability and pricing vary. |
| OpenAI | Any compatible model | Use your OpenAI-compatible endpoint. |
| OpenRouter and other compatible APIs | Provider-specific | Enter the provider's endpoint and model. |
| Ollama / LM Studio | Local model | Uses local compute. |

### Configure a provider

1. Obtain an API key from your chosen provider. For DeepSeek, use the [DeepSeek platform](https://platform.deepseek.com/).
2. Open **Settings** → **Parsing Settings** and select **AI Insight** as the analysis mode.
3. In the LLM card, enter:
   - **API URL (OpenAI-compatible):** for example, `https://api.deepseek.com`
   - **Model name:** for example, `deepseek-chat`
   - **API key:** your provider key
4. Select **Save Settings**. Saved keys are not displayed in plain text again.

Switch back to **Fast Local** mode to parse with local rules only, without sending requests to an AI provider.

---

## 6. Core Workflow: Parse a Demo

### What is a demo file?

A demo is a CS2 match replay in `.dem` format. You can obtain one from:

- **Steam match history:** CS2 main menu → Your Matches → choose a match → **Download**.
- **5E client:** Match History → choose a match → Download Demo.
- **Perfect World Arena:** Match History → download the replay.
- **HLTV or other match sites:** useful for professional matches.

### Option A: Drag and drop

1. Drag a `.dem` file into the app's upload area.
2. Wait for the initial scan to show its map and player list.
3. Select the player to analyze—usually yourself.
4. Select **Start Parsing**.
5. After the parse finishes, browse the clip cards.

### Option B: Use the Demo Library

For a long-term collection of demos:

1. Go to **Settings** → **Parsing Settings** and add your demo folder under **Demo Watch Paths**.
2. The app watches newly added `.dem` files. For files already in the folder, select **Scan Local Demo Library**.
3. Select a demo from the library, choose the target player, and parse it.

### Understand the results

Each detected moment appears as a card:

- **🔥 Highlight:** three or more kills in a round, or a special situation such as a one-tap, clutch, knife kill, or jump shot.
- **💀 Fail:** amusing or unfortunate moments such as a Zeus kill, Deagle headshot, or team kill.
- **🪦 Meme Death:** special community meme deaths, including the 211 / `o`-series tags.
- **🎬 Compilation:** cross-round sequences such as favourite victim, nemesis, or all-kills/all-deaths montages.

With AI mode enabled, cards also include an AI score and commentary.

---

## 7. One-Click Automatic Recording

This workflow automatically drives CS2 demo playback and OBS recording.

### Prerequisites

- OBS is configured and connected successfully; see [Configure OBS](#4-configure-obs-required-for-recording).
- CS2 is installed and **CS2 Path** in Settings points to `cs2.exe`. The app normally detects the Steam installation automatically. A typical path is:

  ```text
  D:\steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe
  ```

- Keep OBS open.

### Record clips

1. Parse a demo and open its clip list.
2. Select the clips to record, then add them to the recording queue.
3. In the queue, select **Start Recording**.
4. The app will launch CS2, load the demo, seek to every clip, start and stop OBS, move to the next clip, and close CS2 after the queue is complete.

> [!WARNING]
> **Do not use the computer while recording.** The app sends keyboard commands to the CS2 window. Switching windows, typing, or manually entering console commands can interrupt recording and may overwrite game settings. Let the recording run unattended.

### Spectator warm-up (optional)

Before recording, the **Spectator Warm-up** dialog can apply replay settings for the demo session, including:

- `cl_draw_only_deathnotices` — show death notices only.
- `hud_showtargetid 0` — hide target IDs.
- `tv_nochat 1` — hide chat.
- Hide grenade trajectories, adjust FOV, and other spectator options.

The app applies these settings at the start of each demo session and restores them after recording.

### Preview the plan

In the recording queue, select **Preview Plan** before starting to see each clip's start/end time, enabled state, and any warnings. Adjust the queue if needed.

### Find recorded files

Videos are saved to OBS's recording directory. In OBS, choose **File** → **Show Recordings**, or inspect **Settings** → **Output** → **Recording**. Files are named automatically in a `player_map_round_kills` pattern.

---

## 8. Compilation Workbench (Optional)

> [!IMPORTANT]
> FFmpeg must be configured to export compilations. You can still record individual clips without it.

### Configure FFmpeg

1. Download a Windows build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (the `ffmpeg-release-essentials.zip` package is sufficient) or [FFmpeg's download page](https://ffmpeg.org/download.html).
2. Extract it to a path without non-ASCII characters, such as `D:\ffmpeg\`.
3. In **Settings** → **Video Settings**, set **FFmpeg Executable** to the full path, for example:

   ```text
   D:\ffmpeg\bin\ffmpeg.exe
   ```

4. Save the settings or use **Auto-detect FFmpeg**. If left blank, the app also tries `ffmpeg` from the system PATH.

The app detects supported hardware encoders (NVENC, QSV, and AMF) and falls back to CPU encoding (`libx264`) when needed. If you need a hardware encoder that is not detected, install an FFmpeg full build with support for it.

### Use the workbench

Successfully recorded clips appear in the **Compilation Workbench**. There you can:

- Drag to reorder clips.
- Add BGM.
- Select a transition theme.
- Arrange intros/outros and player info cards.
- Export the final MP4 through FFmpeg.

The workbench is optional and does not affect standalone recording.

---

## 9. Demo Library

### Watch folders

Set **Demo Watch Paths** under **Settings** → **Parsing Settings** to import newly added demos automatically. Select **Scan Local Demo Library** to add demos that were already in those folders.

> [!TIP]
> You can add multiple folders—such as the Steam replay folder and your 5E download folder—to keep demos from different platforms in one library.

### Followed players

Add yourself and friends under **Settings** → **Followed Players** (up to 50 names). This helps with nickname matching and display filtering in the demo library; it does not automatically parse demos or generate clips.

---

## 10. FAQ

**The app does not open, or I do not see a shortcut after installing.**

- Confirm the installer reached completion rather than being closed early.
- Look for CS2 Insight Agent in the Windows Start menu.
- Run the installer again if necessary.

**Windows SmartScreen appears when I start the app.**

Confirm the installer came from the official Releases page, then use **More info** → **Run anyway** to continue. SmartScreen warnings may appear while an application is building reputation.

**How do I update?**

Use the in-app update prompt when it appears at startup, or install the newest package from the [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases). Existing settings and data are retained.

**OBS Configuration Check fails.**

- In **Settings** → **Video Settings**, verify the `obs64.exe` path or use auto-detect.
- Ensure OBS can open and that **Tools** → **WebSocket Server Settings** has WebSocket enabled.
- Verify the port (normally `4455`) and password match in both apps.
- Use OBS 28.0 or newer; older versions need obs-websocket installed separately.
- As a diagnostic step, you may disable OBS authentication and leave the password blank in CS2 Insight.

**CS2 was not detected.**

Set the full executable path manually under **CS2 Path**, for example:

```text
C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe
```

> [!CAUTION]
> Once recording begins, do not interact with the keyboard, mouse, CS2 console, or recording windows. Manual interference can disrupt playback and may overwrite the local game configuration.

**The app asks me to restore player configuration before recording.**

In the prompt, select **Go to Player Configuration**. This opens **Settings** → **General Settings** → **Player Game Configuration**. Close CS2 first, then choose **One-click Restore Player Configuration**. The same screen can open the backup folder for manual recovery.

**What is the experimental POV HUD feature?**

POV HUD makes local demo footage look closer to a player's in-game view. Enable **POV** under **Settings** → **Recording Presets** → **Experimental Features**. During local demo recording, the app temporarily installs `pov.vpk` and adjusts the `SearchPaths` in CS2's `game/csgo/gameinfo.gi`; it restores the changes after recording.

- Some HUD/radar warm-up options are hidden or fixed while POV is enabled.
- Never use this mode to connect to VAC-secured or official matchmaking servers.
- If a crash prevents restoration, close CS2 and choose **Restore POV Changes** on the same settings page.

**OBS records a black screen, or CS2 is not visible.**

- Run OBS calibration again in **Settings** → **Video Settings**, then **restart OBS**.
- Run OBS and CS2 Insight at the same privilege level; if needed, run OBS as administrator too.
- Check the Game Capture source in the `CS2 Insight Recording` scene.
- With multiple displays, ensure the capture targets the display used by CS2.

**There is no sound in the recording.**

- Check OBS audio sources. Keep either Desktop Audio Capture or Application Audio Capture, not both.
- Check that only the intended audio track is enabled.

**The exported file cannot be opened, moved, or sent.**

- Avoid running CS2 Insight as administrator unless necessary; differing permissions can affect output files.
- Close CS2 Insight and OBS before moving the file.
- Try moving the file to another folder, then open it again.

**The video has black bars or the game image is cropped.**

- This can happen with a 4:3 CS2 display mode.
- In OBS Game Capture, right-click the source → **Transform** → **Stretch to Screen**.
- For cropped footage, ensure CS2 uses true fullscreen—not fullscreen windowed—and that the selected recording resolution exists for the display. If only fullscreen windowed supports it, remove `-fullscreen` from **Recording Presets** → **Additional Launch Options** and use fullscreen windowed. Alternatively, add a suitable custom display resolution through your GPU control panel.

**The recording misses the end, or records the console.**

- Re-run OBS calibration and **restart OBS** afterward.
- In OBS **Settings** → **Output** → **Recording**, do not use “Same as stream.” Set a dedicated recording quality.
- If OBS uses Advanced output mode, switch temporarily to Simple mode, calibrate through the app, and restart OBS. In Advanced mode, do not choose “Use stream encoder” as the recording video encoder.

**CS2 stays on the main menu when recording starts.**

Current CS2 builds may only play demos recorded after the April 21, 2026 AG2 movement-system update. To record older demos, roll CS2 back to version `1.41.4.1`.

**The clip is in third-person view.**

The app normally switches to the target player's first-person view. In the parse results, ensure the selected target player's name exactly matches the name stored in the demo.

**Parsing is slow.**

- The first parse can be slower; the demo library caches later work.
- Avoid parsing multiple very large demos at the same time.
- AI mode adds network time for the provider response.

**AI mode returns an error.**

- Check the API key, endpoint, model name, and available provider balance.
- For DeepSeek, use `https://api.deepseek.com` as the base URL.
- Disabling AI mode does not affect the other features.

**Where are demos from 5E or Perfect World Arena?**

Download them from each platform's Match History page. The downloaded `.dem` file can be dragged directly into CS2 Insight.

**Can I record clips from multiple demos in one queue?**

Yes. Add clips from different demos to the queue. The app groups them by demo, starts CS2 for each group, and records them sequentially.

---

## 🎬 Quick Start Checklist

```text
1. Download and install CS2 Insight Agent.
2. Start it from the desktop shortcut.
3. In Settings, set the CS2 path under General Settings; configure and calibrate OBS under Video Settings.
4. Drag in a demo, select a player, and start parsing.
5. Select clips, add them to the queue, start recording, and wait for it to finish.
6. Collect the videos from OBS's recording folder, or export a compilation from the workbench.
```

Have fun—and may your highlights outnumber your fails. 🔥💀

---

## Support the Project

If CS2 Insight Agent saves you editing time, you are welcome to buy the developer a coffee. Support helps cover demo parsing, recording compatibility testing, and ongoing maintenance.

<img src="asset/wx.jpg" alt="Support QR code 1" style="zoom:33%;" />
<img src="asset/ali.jpg" alt="Support QR code 2" style="zoom:33%;" />

> **CS2 Insight Agent** · Made with ❤️ for CS2 Players
