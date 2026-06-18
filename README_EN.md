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

<h3 align="center"><b>CS2 Insight Agent: Desktop Intelligent Esports Terminal for CS2 Players</b> </h3>
<h4 align="center">Demo Management, Highlight Extraction, Auto-Editing, LLM Commentary</h4>

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
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/PLAYER_GUIDE.md">User Guide</a> •
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

### Highlight Parsing & Clip Discovery

- **Batch Demo Parsing** — Parse highlights from multiple demos simultaneously; highlights from the same player across different matches are organized by match.
- **Target Player Lock** — Automatically identify all players in a match and locate targets by Steam ID, platform ID, or nickname; compatible with different demo export conventions from 5E, Perfect World, and Official Matchmaking.
- **Fine-grained Highlight Analysis** — Automatically categorizes **Highlights** (multi-kills, one-taps, clutches, knife kills, jump shots, defuses), **Fails** (taser, Deagle, team kills, "human magnet", "human tracing", "shoulder-to-shoulder" moments), **Cross-round Compilations** (favorite victim, nemesis, kill/death montage, continuous round recording), and **Meme Rounds** (211/o/i/z series with AI round commentary). See [Clip Types & Tags](./docs/highlight_tags.md) for tag descriptions.
- **Round Timeline** — Beyond auto-extracted clip cards, browse kill/death timelines by round to add specific shots, deaths, or entire rounds to the recording queue.
- **Continuous Round Recording** — Record from round start to death or round end; select multiple rounds to combine into a longer clip.

### Auto Recording

- **Batch Recording Queue** — Queue multiple matches and clips; the program sequentially launches CS2 replay and drives OBS to produce videos; preview the entire plan before recording, with per-clip timing adjustments in the queue.
- **Pre-recording Spectator Settings** — One-click spectator HUD configuration (death notices only, hide IDs/chat/demo bars), FOV and viewmodel, flash brightness, voice, resolution and aspect ratio, OBS transitions between clips; experimental POV first-person HUD can be enabled per-match.
- **Diverse Output Styles**:
  - Observer view or POV first-person HUD (toggle radar, adjust top player count display)
  - Clean spectator view, custom FOV, hide grenade trajectories
  - **Victim POV** — After highlight or multi-kill compilations, automatically append victim perspective clips
  - **Keyboard Overlay** — Display WASD, crouch/jump keys in OBS, with manual sync adjustment if needed
  - Fade in/out transitions between clips
- **Safe Recording Solution**:
  - Controls recording via OBS and game state coordination, no injection or game hooking
  - Automatically backs up and restores your keybinds and graphics settings after recording


### Compilation Workbench

- Successfully recorded clips are automatically stored in the library; use the Compilation Workbench to drag-and-drop reorder, add BGM/transition themes, and export MP4; filter by highlight/fail/compilation/timeline types, with intro/outro arrangement.
- **Player Info Card** — Enable bottom-left corner watermark when exporting: briefly displays player nickname, clip type (highlight/fail/compilation), round and scenario tags (e.g., multi-kill, one-tap) at the start of each clip; upload custom avatars for each player appearing in the timeline, or display first letter of nickname if no avatar. Perfect for Bilibili-style highlight intros without manual PR editing.
- **FFmpeg Configuration Required**: Download Windows builds from [FFmpeg Official](https://ffmpeg.org/download.html) or [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), extract and set the full path to `ffmpeg.exe` in the settings page. Export prioritizes GPU hardware encoding (NVENC/QSV/AMF), falling back to software encoding if unavailable.


### AI Commentary (Optional)

- **OpenAI-Compatible Multi-Provider** — Built-in support for DeepSeek, Tongyi Qwen, Zhipu GLM, MiniMax, OpenAI, OpenRouter; local models via Ollama, LM Studio.
- **Sarcastic Persona Prompt** — Hype for highlights, roast for fails, meme deaths as jokes; hard constraint under 100 characters, single-line JSON output, no off-topic chatter.
- **Round Meme Compilation Review** — 211/o/i/z meme rounds trigger "Round Comprehensive Review", independent from clip-level scoring.

---

## Installation

Download the latest `CS2-Insight-Agent-Setup-x.x.x.exe` from the [Releases page](https://github.com/DrEAmSs59/CS2-insight-agent/releases), run the installer and follow the prompts.

After installation, launch from desktop or start menu. **No browser needed, no manual backend start** — the Electron main process automatically launches the Python backend service internally.

The app includes **online update** functionality: automatically checks for new versions on startup, with notifications in the top-right corner; click to download and install within the app, no manual re-download needed.

> **Recommended: Installation path without Chinese characters.** e.g., `D:\CS2-Insight-Agent\` ✅, `D:\游戏工具\CS2-Insight-Agent\` ❌

---

## Roadmap

- **V1**
   - [X] Highlight Parsing
   - [X] AI Commentary
   - [X] Auto Director
- **V2**
   - [X] Electron Desktop, In-app Online Updates
   - [X] Compilation Workbench (FFmpeg Export)
   - [X] POV HUD Experimental Feature
   - [X] Round Timeline Browse & Queue Recording
   - [X] Pre-recording Spectator Warm-up / Victim POV / Virtual Keyboard OBS Overlay
- **V3**
   - [ ] Demo Heatmap Analysis
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
