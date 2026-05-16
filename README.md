# CS2 Insight Agent

[License](LICENSE)
[Version](https://github.com/DrEAmSs59/CS2-insight-agent/releases)
[Player Guide](PLAYER_GUIDE.md)

**CS2 洞察智能体** — 专为 CS2 玩家打造的桌面端智能电竞终端。

自动解析 Demo 录像，提取**高光 / 下饭 / 梗死亡**时刻，可调用 LLM 生成毒舌锐评与评分，并通过 OBS 全自动控制 CS2 回放录制成片，开箱即用。

---

## Tech Stack


| Layer    | Technology                                                                 |
| -------- | ---------------------------------------------------------------------------- |
| Frontend | React 19 + React Router + TailwindCSS 4 + Vite 6 + Zustand                   |
| Desktop  | Electron 42（Windows 安装包 / `electron-updater` 自动更新）                        |
| Backend  | Python 3.12 + FastAPI + uvicorn                                               |
| 解析引擎     | demoparser2 + pandas（子进程隔离，防 Rust panic 拖垮主进程）                            |
| AI 网关    | OpenAI 兼容 SDK（DeepSeek / Qwen / GLM / MiniMax / OpenAI / Ollama 等）           |
| 录制管线     | `RecordingRequestDTO` → `plan_builder` → `RecordingExecutor`；CS2 启停与批量队列由 `obs_director` 编排 |
| OBS 控制   | obs-websocket-py（分段 `StartRecord` / `PauseRecord` jump-cut；可选场景转场淡入淡出）      |
| 合辑导出     | FFmpeg（`montage_encoder` 自动探测 NVENC / QSV / AMF / libx264）                   |
| Demo 库   | aiosqlite + watchdog（目录监听 + SSE 推送）                                        |
| CS2 集成   | Game State Integration（录制就绪门控）+ `win_cs2_console` 控制台注入                     |


---

## Project Structure

```
CS2-insight-agent/
├── backend/
│   └── app/
│       ├── main.py                    # FastAPI 入口（解析 / Demo 库 / GSI / 合辑导出等）
│       ├── recording/                 # 录制 V3：Plan → Execute 管线
│       │   ├── api.py                 # /api/recording/*（挂载于 main.py）
│       │   ├── models.py              # RecordingRequestDTO / RecordingPlan / Segment
│       │   ├── plan_builder.py        # 计划编排入口（分发至各 planner）
│       │   ├── normalizer.py          # 请求规范化、参数校验
│       │   ├── planners/              # highlight / fail / timeline / compilation / round POV
│       │   ├── postprocess/           # 末回合保护、段禁用与 warnings 汇总
│       │   ├── executor/              # RecordingExecutor、OBS 控制、demo seek、GSI 观战校验
│       │   └── services/              # 单次录制结果落盘
│       ├── obs_director.py            # CS2 启停、GSI 门控、预热 cvar、批量队列 execute_plan_queue
│       ├── demo_parser.py             # 高光 / 下饭 / 梗死亡 / 合集判定引擎
│       ├── demo_parse_isolation.py    # 子进程隔离解析（parse_worker.py）
│       ├── ai_reviewer.py             # 毒舌 AI 锐评（OpenAI 兼容）
│       ├── montage_db.py              # 已录片段 & 合辑工程（SQLite recorded_clips / projects）
│       ├── montage_encoder.py         # FFmpeg H.264 编码器探测
│       ├── video_composer.py          # 合辑时间轴合成导出
│       ├── win_cs2_console.py         # Windows CS2 控制台注入（SendInput / WM_CHAR）
│       ├── gsi_ready.py               # GSI HTTP sink（录制就绪门控）
│       ├── cs2_config_backup.py       # 玩家 config 备份与回滚
│       ├── demo_db.py / demo_watcher.py / demo_library_hub.py
│       ├── obs_config_center.py       # OBS 场景 / 源管理 API
│       ├── pov_experimental.py        # 实验性 POV HUD（pov.vpk / gameinfo.gi）
│       ├── env_utils.py               # 配置管理 & CS2 路径探测
│       └── radar/                     # 雷达图渲染（POV HUD / 录制叠加）
├── frontend/
│   └── src/
│       ├── App.jsx                    # 路由壳、全局状态、录制队列提交 / 阻断弹窗
│       ├── main.jsx                   # React Router 入口
│       ├── api/api.js                 # axios 封装与 API 基址
│       ├── pages/                     # 各功能页（Demo 库 / 分析 / 录制队列 / 合辑 / 设置…）
│       ├── recording/                 # RecordingRequestDTO 构建、plan 预览 API
│       ├── stores/                    # recordingQueueStore / montageStore / themeStore
│       ├── components/
│       │   ├── recordingQueue/        # 队列工作区、检视器、控制坞
│       │   ├── montage/               # 合辑工作台（时间轴、导出、已录片段卡）
│       │   ├── demoLibrary/           # Demo 库表格、筛选、批量操作
│       │   ├── analysis/timeline/     # 回合时间轴与击杀 feed
│       │   ├── SidebarNav.jsx         # 侧栏导航
│       │   ├── ClipCard.jsx / ClipList.jsx / MemeDeathMontageCard.jsx
│       │   ├── RecordWarmupModal.jsx  # 录制前观战预热 & POV HUD 选项
│       │   └── RecordingBlockedDialog.jsx
│       └── utils/                     # recordingBatch、timelineQueue、warmupDefaults 等
├── frontend/electron-main.cjs         # Electron 主进程（内嵌 Python 后端）
└── README.md
```

### 录制数据流（V3）

```
前端队列项 → recording/buildDtoFromQueueItem → RecordingRequestDTO
    → POST /api/recording/queue
    → plan_builder（planners + postprocess）→ RecordingPlan[]
    → obs_director.execute_plan_queue（按 demo 分组启 CS2、注入预热 cvar）
    → RecordingExecutor（逐段 seek / spec / OBS 录停 / jump-cut）
    → 成片重命名 + montage_db 入库（合辑工作台可选用）
```

---

## Quick Start

### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000 or python -m uvicorn app.main:app --reload --port 8000
```

实际发放版本内置的 Python 运行时为 `3.12`。

### 2. Frontend

```bash
cd frontend
npm install
npm run dev or npm run electron:dev // start frontend dev server
```
前端打包：
```bash
npm run build
```
Electron 打包：
```bash
npm run electron:build
```
Electron打包位置：`frontend/dist_electron/`



前端跑在 `http://localhost:5173`，Vite 已配置代理把 `/api/*` 转发到后端 `http://localhost:8000`。

---

## Features

### 🎯 解析与片段挖掘

- **多场次 Demo 解析** — 支持单文件、多文件、目录监听三种入口；同一玩家在多场 Demo 中的高光会按场次组织展示。
- **目标玩家锁定** — 自动从 Demo 解析出 roster，可按 Steam ID / `user_id` / 昵称三档兜底定位，兼容 5E、完美世界、官匹的不同导出习惯。
- **关注玩家名单** — 在侧栏维护一份关注昵称，新增 Demo 入库时**自动**写好库展示名（A K/D · B K/D 多人并排），不耗深度解析资源。
- **子进程隔离解析** — Demo 解析放到独立进程，遇到 `demoparser2` 的 Rust panic 也不会拖垮 FastAPI 主进程。

### 🎬 片段类型（自动分类）

- **高光 (highlight)**
  - 单回合 ≥ 3 杀
  - 颗秒 / 跳杀 / 反杀 / Clutch / 1vN / 刀杀等带情景标签
- **下饭 (fail)**
  - 被电击枪击杀 / 被沙鹰爆头 / 被队友击杀
  - 三轨数据源驱动的「人肉吸铁石」「人体描边」「亲儿子喂饭」高级下饭场景
- **梗死亡 (meme_death)**
  - 全程 0/1/2 杀且高死亡的「研发」局：211 高材生、o 系列、i18 典中典、z 系列坐牢
  - 整局加一张「研发全集」大卡，可配 AI 总括点评
- **跨回合合集 (compilation)**
  - 🥩 亲儿子喂饭：本场对某敌人单方面输出
  - ☠️ 本命苦主：本场被某攻击者反复处刑
  - 🎬 全部击杀 / 💀 全部死亡：本场目标玩家所有击杀 / 死亡的串烧

### 🤖 AI 锐评（可选）

- **OpenAI 兼容多家厂商** — 内置 DeepSeek、通义 Qwen、智谱 GLM、MiniMax、OpenAI、OpenRouter；本地模型支持 Ollama、LM Studio。
- **毒舌人设 Prompt** — 高光吹爆、下饭嘲讽、梗死亡当段子；硬约束 100 字以内、单行 JSON 输出，不输出场外废话。
- **整局梗合集总评** — 211/o/i/z 系研发局会触发「整局综合评价」，独立于片段级评分。

### 📺 OBS 自动导播（V3 录制管线）

- **Plan → Execute 分离** — 前端提交 `RecordingRequestDTO`，后端 `plan_builder` 生成 tick 级 `RecordingPlan`（含 disabled 段与 warnings），再由 `RecordingExecutor` 驱动 OBS；`/api/recording/plan` 可单独预览计划。
- **GSI 启动就绪门控** — 用 CS2 Game State Integration 确认已进入游戏画面再注入控制台命令，超时（默认 120s）会**前端弹窗中止**，避免在读条页瞎打命令。
- **智能跳跃剪辑 (jump-cut)** — 多杀 / 击杀合集按击杀 tick 自动分段，段间 OBS `PauseRecord` / `ResumeRecord`（失败时回退 `StopRecord` + 控制台 `demo_pause`）。
- **可选 OBS 场景转场** — `OBSFadeController` 在段间用场景转场做淡入淡出，与 jump-cut 正交（不占用 PauseRecord 链路）。
- **POV 段** — 高光可追加受害者视角、下饭可追加击杀者视角；回合 POV / 时间轴回合走独立 `round_pov_planner`。
- **末回合保护** — `final_round_guard` 防止 seek 越过 demo 尾部或误触退出。
- **录制前观战预热** — 一键勾选 `cl_draw_only_deathnotices` / `hud_showtargetid 0` / `tv_nochat 1` / 隐藏投掷物轨迹 / 自定义 FOV 等观战 cvar，每个 demo 会话首段统一注入。
- **批量队列录制** — 跨场次 / 跨玩家加入队列；`obs_director.execute_plan_queue` 按 demo 分组启 CS2，顺序执行各 `RecordingPlan`，成片自动重命名并写入合辑库。
- **键位与配置保护** — 录制开始注入 `unbindall` + 默认绑定；玩家 `config.cfg` / `video.txt` / `user_convars_*.vcfg` 快照至 `.cs2_config_backup/`，`taskkill` CS2 后自动回滚。
- **CS2 占用 / 配置恢复检测** — CS2 已运行或上次异常退出未恢复配置时，接口返回 409，前端阻断弹窗提示。

### 🎞️ 合辑工作台（可选）

- 录制成功的片段自动入库 `recorded_clips`，可在合辑工作台拖拽排序、配 BGM / 转场主题，经 FFmpeg 导出 MP4。

### 📚 Demo 库

- **SQLite 本地库** — 解析过的 Demo 写入 `cs2-insight.db`，跨次会话保留地图、记分板、关注玩家展示名等元数据。
- **目录实时监听** — 在侧栏添加 5E / 完美 / 官匹 demo 目录，新增文件自动入库 + 轻量元数据解析。
- **SSE 实时推送** — 库内新增 / 改名 / 解析状态变化时通过 `/api/demos/stream` 推送，前端无需轮询。

### 🎨 UI / UX

- 暗黑磨砂黑底 + CS2 经典亮橙强调色，原生电竞风。
- 录制队列页支持跨场次跨玩家管理、计划预览与节奏微调（pre-roll / post-kill / jump-cut 阈值等，队列项可 per-clip 覆盖）。
- 阻断弹窗根据后端返回 detail 自动判断「CS2 占用 / GSI 未就绪 / 录制任务进行中」并切换副标题。

---

## API Endpoints（节选）


| Method | Path                        | Description          |
| ------ | --------------------------- | -------------------- |
| GET    | `/api/health`               | 健康检查                 |
| GET    | `/api/config`               | 获取配置                 |
| PUT    | `/api/config`               | 更新配置                 |
| POST   | `/api/config/detect-cs2`    | 自动探测 cs2.exe 路径      |
| POST   | `/api/obs/test`             | 测试 OBS WebSocket 连接  |
| POST   | `/api/demo/upload`          | 单文件上传                |
| POST   | `/api/demo/upload-multiple` | 多文件上传                |
| POST   | `/api/demo/parse`           | 单玩家解析                |
| POST   | `/api/demo/parse-multi`     | 同 Demo 多玩家解析         |
| POST   | `/api/demo/parse-batch`     | 跨 Demo 批量解析          |
| GET    | `/api/demos`                | Demo 库列表（分页）         |
| GET    | `/api/demos/stream`         | 库变更 SSE 流            |
| POST   | `/api/demos/scan`           | 手动扫描监听目录             |
| POST   | `/api/demos/{id}/parse`     | 重新解析                 |
| POST   | `/api/demos/{id}/analyze`   | 直接对库内 Demo 出片段       |
| GET    | `/api/demos/{id}/players`   | 库内 Demo 玩家名册         |
| POST   | `/api/recording/queue`      | 批量录制：`RecordingRequestDTO[]` → `plan_builder` → `execute_plan_queue` |
| POST   | `/api/recording/plan`       | 预览 `RecordingPlan`（active / disabled 段、warnings、末回合元数据） |
| POST   | `/api/recording/execute`    | 单条 DTO 即时执行（调试用，不经队列编排） |
| POST   | `/api/recording/abort`      | 中止当前进行中的批量录制队列 |
| GET    | `/api/recorded-clips`       | 已录片段列表（合辑工作台） |
| POST   | `/api/montage/projects`     | 保存合辑工程 |
| POST   | `/api/montage/export`       | FFmpeg 合辑导出 |
| POST   | `/api/gsi/cs2`              | CS2 GSI Sink（录制就绪门控） |
| GET    | `/api/gsi/status`           | 查看最近 GSI 状态          |


---

## Roadmap

- **V1.x.x** — 高光引擎 + AI 锐评 + OBS 全自动导播 ✅ *Current*
- **V2.x.x** — 编辑切片合成视频，开场动画，BGM，AI Agent 一句话自动录制视频，外网数据挂载（5E / 完美世界），作为 AI 上下文增强点评深度
- **V3.x.x** — 战术教练（投掷物轨迹分析 / 首杀热力图 / 路线复盘）

---

## License & Disclaimer

本项目采用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) 协议发布。

- ✅ 允许个人学习、研究、爱好、评测及其他非商业用途使用。在遵守本协议的前提下，你可以阅读、修改、构建和分发本项目源码及其衍生版本。
- ⛔ 未经书面授权，禁止将本项目或其衍生版本用于任何商业用途，包括但不限于：商业软件、付费服务、商业代剪/代录服务、商业平台集成、对外销售、出租、转售或作为商业产品的一部分分发。
  - 商业授权咨询：`dreamss29_@outlook.com`
- 📦 如果你分发本项目的编译产物、安装包或修改版本，请同时保留本项目的许可证声明，并遵守 `THIRD_PARTY_LICENSES.md` 中列出的所有第三方开源组件许可证。

## 商标声明

Counter-Strike 2、CS2、Counter-Strike、Steam、Valve 等名称、商标和标识归其各自权利人所有。

本项目与 Valve Corporation、完美世界竞技平台、5E 对战平台、OBS Studio 及其他相关平台或软件的所有者不存在从属、合作、赞助、授权或背书关系。

### 安全使用提示

- **默认录制流程**调用 CS2 时使用 `-insecure` 仅用于本地 Demo 回放，不存在 DLL 注入或 Hook；不会对磁盘上的 `.dem` 做修改，不连接、不修改、不干预任何官方游戏服务器、匹配服务或反作弊系统，也不提供任何作弊、绕过检测或破坏公平竞技的功能，**不要在已登录匹配服务器的 CS2 客户端中并行使用**，以免触发反作弊系统的不必要警示。
- 若你在「常用参数管理 → 实验性功能」中**主动开启 POV**，程序会临时向 CS2 的 `game/csgo` 目录写入 `pov.vpk`，并**增量修改** `gameinfo.gi` 的 `SearchPaths` 以加载 POV HUD 资源；录制结束或异常收尾时会自动恢复。该模式同样**强制**使用 `-insecure` 启动 CS2，**不要用于连接 VAC 安全服务器**。
- 录制期间会临时修改若干 CS2 archive cvar 与按键绑定。本项目会在启动录制时在仓库根目录的 `.cs2_config_backup`中**自动备份**玩家原始的 `config.cfg` / `video.txt` / `user_convars_*.vcfg`，录制结束后会回滚；如遇异常退出或未知错误导致的设置被覆盖，可在该目录手动取回原始文件。

## 支持项目

如果这个项目帮你节省了剪辑时间，欢迎请我喝一杯咖啡 ☕  
你的支持会用于 Demo 解析、录制兼容性测试和后续功能维护。
<img src="asset/wx.jpg" alt="赞助方式1" style="zoom:33%;" />
<img src="asset/ali.jpg" alt="赞助方式2" style="zoom:33%;" />
