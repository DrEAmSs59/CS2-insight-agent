<h1 align="center">
  <br>
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/"><img src="https://raw.githubusercontent.com/DrEAmSs59/CS2-insight-agent/main/frontend/public/cs2-insight-logo.png" alt="CS2-Insight-Agent" width="140"></a>
  <br>
  CS2-Insight-Agent
  <br>
</h1>

<p align="center">
  <a href="./README.md"><img src="./asset/icon-cn.svg" alt="" width="20" height="20" style="vertical-align: middle;"> 简体中文</a> | <img src="./asset/icon-en.svg" alt="" width="20" height="20" style="vertical-align: middle;"> English
</p>

<h3 align="center"><b>CS2 Insight Agent: All-in-one CS2 Creation Suite</b> </h3>
<h4 align="center">Demo Analysis · Custom Skins · OBS Auto-Recording · LiteCut · LLM Commentary<br>Zero Injection · Zero Hooks · Zero Game Reverse-Engineering · Low-Risk Local Replay</h4>

<p align="center">
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/releases">
    <img src="https://img.shields.io/github/v/release/DrEAmSs59/CS2-insight-agent"
         alt="release">
  </a>
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/stargazers">
    <img src="https://img.shields.io/github/stars/DrEAmSs59/CS2-insight-agent.svg"
         alt="Stars">
  </a>
    <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue"
         alt="License">
  </a>

</p>

<p align="center">
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/PLAYER_GUIDE_EN.md">User Guide</a> •
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/CONTRIBUTING_EN.md">Contributing</a> •
  <a href="https://www.bilibili.com/video/BV1PcVj69ExZ/">Video Tutorial</a> •
  <a href="#key-features">Key Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#support">Support</a> •
  <a href="#disclaimer">Disclaimer</a> •
  <a href="#license">License</a>
</p>


![screenshot](./asset/output-1080.gif)

<p align="center">
  <a href="https://www.bilibili.com/video/BV1PcVj69ExZ/">▶ Video Tutorial BV1PcVj69ExZ</a>
</p>

<h4 align="center">Sample Output</h4>

<p align="center">
  <a href="https://www.bilibili.com/video/BV1ZkGi6YENF/">▶ BV1ZkGi6YENF</a> ·
  <a href="https://www.bilibili.com/video/BV1TPGq67EFS/">▶ BV1TPGq67EFS</a>
</p>
<p align="center"><sub>Intro/outro BGM and team logos added by the creator; game clips auto-edited by this tool</sub></p>

<p align="center">
  <a href="https://www.bilibili.com/video/BV1KF5s6nEed/">▶ BV1KF5s6nEed</a> ·
  <a href="https://www.bilibili.com/video/BV1G198BkEHd/">▶ BV1G198BkEHd</a>
</p>
<p align="center"><sub>Both intro/outro BGM and game clips produced by this tool</sub></p>

---

## Key Features

### Demo Library Management

- **Local Library Records** — List and thumbnail view showing match source, scoreboard, tracked players, display names, notes, and other key info.
- **Auto Directory Monitoring** — Supports monitoring demo download directories from 5E, Perfect World, Official Matchmaking, FACEIT, etc., with one-click import.
- **Analysis Handoff** — Select one or more demos in the library and open Demo Analysis directly, or upload local demos from the analysis page.

### Demo Analysis

A unified match-analysis workspace: loading a demo auto-parses all players; switch the active demo from the top-right, then pick a player on the left to browse clips and data. Main views include:

- **Highlights & Recording** — Batch-parse highlight moments; lock targets by Steam ID / platform ID / nickname; auto-categorize **Highlights** (multi-kills, one-taps, clutches, knife kills, jump shots, defuses), **Fails** (taser, Deagle, team kills, "human magnet", "human tracing", "shoulder-to-shoulder" moments), **Cross-round Compilations** (favorite victim, nemesis, kill/death montage, continuous round recording), and **Meme Rounds** (211/o/i/z series with optional AI round commentary), then queue them for recording. See [Clip Types & Tags](./docs/highlight_tags.md).
- **Round Timeline / Weapon Kills** — Browse kill/death timelines by round and add a shot, a death, or an entire round to the queue; continuous round recording from round start to death or round end, with multi-round stitching.
- **2D Replay** — High-speed local 2D replay for movement, fights, and round flow — no need to launch CS2 first.
- **Heatmaps** — Full-match movement density, combat hotspots, kill/death hotspots; filter by player, side, and map floor to study defaults, rotates, and failing positions.
- **Overview / Players / Rounds / Economy** — Match overview, roster and personal stats, round-by-round flow, and economy context to grasp the match structure quickly.
- **Cosmetics & Custom Skins** — On the Cosmetics tab, inspect weapons, knives, gloves, agents, and more that actually appeared in the demo; support 3D / in-game inspect. Enter Customize skins to pick replacements (wear, seed, etc.) and save a custom skin plan for later replay and recording.  
  > The skin-rewriting core is closed-source; see [License](#license).

### Auto Recording

- **Batch Recording Queue** — Queue multiple matches and clips; sequentially launch CS2 replay and drive OBS to produce videos; preview the plan before recording, with per-clip timing tweaks in the queue.
- **Pre-recording Spectator Settings** — One-click spectator HUD (death notices only, hide IDs/chat/demo bars), FOV and viewmodel, flash brightness, voice, resolution and aspect ratio, OBS transitions between clips; experimental POV first-person HUD can be enabled per match.
- **Diverse Output Styles**:
  - Observer view or POV first-person HUD (toggle radar, adjust top player count display)
  - Clean spectator view, custom FOV, hide grenade trajectories
  - **Victim POV** — After highlight or multi-kill compilations, automatically append victim perspective clips
  - **Keyboard Overlay** — Display WASD, crouch/jump keys in OBS, with manual sync adjustment if needed
  - **Kill FX Overlay** — OBS auto-composites transparent, audio-synced FX clips for one-taps, revenge, wallbangs, blind snipes, collaterals, multi-kills, and clutches
  - Fade in/out transitions between clips
- **Safe Recording Solution**:
  - Controls recording via OBS and game state coordination, no injection or game hooking
  - Automatically backs up and restores your keybinds and graphics settings after recording

### Compilation Workbench

- Successfully recorded clips land in the library; drag-and-drop reorder, add BGM/transition themes, export MP4; filter by highlight/fail/compilation/timeline, with intro/outro arrangement.
- **Player Info Card** — Optional bottom-left nameplate at each clip start: nickname, clip type, round and scenario tags (e.g. multi-kill, one-tap); upload avatars per player, or fall back to the nickname initial.
- Best for a lightweight “record → reorder → export” montage flow.
- **FFmpeg Required**: Download a Windows build from [FFmpeg Official](https://ffmpeg.org/download.html) or [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), then set the full path to `ffmpeg.exe` in Settings. Export prefers GPU encoders (NVENC/QSV/AMF) and falls back to software encoding. Both the Compilation Workbench and LiteCut depend on this setup.

### LiteCut (Multi-track Editor)

Built-in lightweight NLE for multi-track finishing on top of Insight recordings, or with local media (requires FFmpeg as above).

- **Project Management** — Create / open / duplicate projects with custom canvas size and frame rate; templates, portable project JSON import/export, and crash recovery.
- **Media Bin** — Use **Insight recordings** (filter by highlight/fail/compilation/timeline) or drop in local video, audio, images, and fonts; preview proxies, asset relinking, and mic voiceover.
- **Multi-track Timeline** — Video, audio, and text/overlay tracks; split, trim, ripple delete, slip, group, A/V link/unlink; markers and snapping; undo/redo and shortcuts.
- **Packaging & Color** — Titles/text styles, filters/color grade (esports, cool/warm, night, etc.), fixed speed and speed ramps, transform/volume keyframes, in/out transitions (fade, flash, wipe, glitch, and more); save and reuse style presets.
- **Kill Axis** — Kill timestamps embedded in recorded clips follow trim/move/speed changes for rhythm spotting (read-only; not baked into export).
- **Export** — Export by project settings and in/out range, preferring hardware encoding.

### AI Commentary (Optional)

- **OpenAI-Compatible Multi-Provider** — Built-in support for DeepSeek, Tongyi Qwen, Zhipu GLM, MiniMax, OpenAI, OpenRouter; local models via Ollama, LM Studio.
- **Sarcastic Persona Prompt** — Hype for highlights, roast for fails, meme deaths as jokes; hard constraint under 100 characters, single-line JSON output, no off-topic chatter.
- **Round Meme Compilation Review** — 211/o/i/z meme rounds trigger "Round Comprehensive Review", independent from clip-level scoring.

---

## Installation

Download the latest `CS2-Insight-Agent-Setup-x.x.x.exe` from the [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases), run the installer and follow the prompts.

After installation, launch from desktop or start menu. **No browser or manual backend start is required.** The lightweight Tauri shell starts the bundled Python backend and renders the UI with the Windows system WebView2 runtime.

The app does not run a background updater. Download new versions directly from the [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases).

> **Recommended: Installation path without Chinese characters.** e.g., `D:\CS2-Insight-Agent\` ✅, `D:\游戏工具\CS2-Insight-Agent\` ❌

---

## Roadmap

- **V1**
   - [X] Highlight Parsing
   - [X] AI Commentary
   - [X] Auto Director
- **V2**
   - [X] Lightweight Tauri Desktop
   - [X] Compilation Workbench (FFmpeg Export)
   - [X] POV HUD Experimental Feature
   - [X] Round Timeline Browse & Queue Recording
   - [X] Pre-recording Spectator Warm-up / Victim POV / Virtual Keyboard OBS Overlay
   - [X] Demo Map Analysis (2D Replay / Heatmaps, etc.)
- **V3**
   - [ ] Tactical Coach (Grenade Trajectory Analysis / Route Review)


### Top contributors:

<a href="https://github.com/DrEAmSs59/CS2-insight-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=DrEAmSs59/CS2-insight-agent" alt="contrib.rocks image" />
</a>


---

## License

This project is released under the [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) license.

- Personal learning, research, hobby, review, and other non-commercial uses are permitted. Under this license, you may read, modify, build, and distribute this project's source code and derivatives.
- Without written authorization, commercial use is prohibited, including but not limited to: commercial software, paid services, commercial editing/recording services, commercial platform integration, sales, rental, resale, or distribution as part of commercial products.
  - Commercial licensing inquiries: `dreamss29_@outlook.com`
- 📦 If you distribute compiled products, installers, or modified versions of this project, please retain this project's license statement and comply with all third-party open source component licenses listed in `THIRD_PARTY_LICENSES.md`.
- 🔒 **The custom skin (skin rewriting) feature under Demo Analysis → Cosmetics is a closed-source proprietary component** and is **not** covered by the open-source license above:
  - Scope: Includes, without limitation, the “Customize skins / custom skin plan” UI capabilities, skin replacement and write-back logic, and the underlying closed-source components (such as the `skin-core` binary and related implementations). The open-source repository provides call sites only and **does not** include the skin-rewriting algorithms or core implementation source code.
  - Rights: All intellectual property in this feature and its closed-source implementations belongs to the rights holder. It is not released as open source, no reverse-engineering permission is granted, and openness of other project parts does not imply any license over this component.
  - Prohibited acts: Without prior written authorization from the rights holder, no person or organization may reverse engineer, decompile, disassemble, debug/trace, crack, bypass integrity or authorization checks, tamper with, extract algorithms/protocols/keys from, copy, re-package, redistribute, or otherwise obtain, disclose, or exploit the internal implementation of this closed-source component.
  - Legal consequences: Upon discovery of any such activity, the rights holder reserves the right to pursue all available civil, administrative, and criminal remedies, including but not limited to injunctive relief and damages. Commercial licensing inquiries: `dreamss29_@outlook.com`.

## Disclaimer

Counter-Strike 2, CS2, Counter-Strike, Steam, Valve and related names, trademarks, and logos belong to their respective owners.

This project is not affiliated with, partnered with, sponsored by, authorized by, or endorsed by Valve Corporation, Perfect World Arena, 5E Arena, OBS Studio, or other related platforms or software owners.

### Safe Usage Tips

- **Default Recording Process** launches CS2 with `-insecure` for local demo playback only; no DLL injection or hooking; does not modify `.dem` files on disk, does not connect to, modify, or interfere with any official game servers, matchmaking services, or anti-cheat systems, nor does it provide any cheating, detection bypass, or fair-play disruption features. **Do not use in parallel with a CS2 client logged into matchmaking servers** to avoid triggering unnecessary anti-cheat warnings.
- If you **actively enable POV** in "Common Parameters → Experimental Features", the program temporarily writes `pov.vpk` to CS2's `game/csgo` directory and **incrementally modifies** `gameinfo.gi`'s `SearchPaths` to load POV HUD resources; automatically restored after recording or abnormal termination. This mode also **forces** `-insecure` when launching CS2. **Do not use to connect to VAC-secured servers**.
- Recording temporarily modifies several CS2 archive cvars and keybinds. This project automatically backs up your original `config.cfg` / `video.txt` / `user_convars_*.vcfg` to the program data directory's `.cs2_config_backup` when starting recording, and restores them afterward; if settings were overwritten due to abnormal exit, manually retrieve original files from that directory.

---

## Support

If this project saved you editing time, consider buying me a coffee ☕
Your support goes toward demo parsing, recording compatibility testing, and future feature maintenance.

<div style="display: flex; justify-content: center; align-items: center; gap: 20px;">
  <img src="asset/wx.jpg" alt="Support Method 1" style="height: 200px;" />
  <img src="asset/ali.jpg" alt="Support Method 2" style="height: 200px;" />
</div>
