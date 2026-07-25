> English quick start: [Development Setup](dev-setup.md)

## 分支与贡献

日常开发基于 **`develop`**，稳定发布在 **`main`**。工作分支从 `develop` 拉出，PR 目标为 `develop`。

完整流程（发布、hotfix、分支命名）见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

```bash
git fetch origin && git checkout develop && git pull
git checkout -b feat/my-change
```

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + React Router + TailwindCSS 4 + Vite 6 + Zustand |
| Desktop | Tauri 2 + 系统 WebView2（Windows NSIS 安装包） |
| Backend | Python 3.12 + FastAPI + uvicorn |
| 解析引擎 | demoparser2 + pandas（子进程隔离，防 Rust panic 拖垮主进程） |
| AI 网关 | OpenAI 兼容 SDK（DeepSeek / Qwen / GLM / MiniMax / OpenAI / Ollama 等） |
| 录制管线 | `RecordingRequestDTO` → `plan_builder` → `RecordingExecutor`；CS2 启停与批量队列由 `obs_director` 编排 |
| OBS 控制 | obs-websocket-py（分段 `StartRecord` / `PauseRecord` jump-cut；可选场景转场淡入淡出） |
| 合辑导出 | FFmpeg（`montage_encoder` 自动探测 NVENC / QSV / AMF / libx264） |
| Demo 库 | aiosqlite + watchdog（目录监听 + SSE 推送） |
| CS2 集成 | Game State Integration（录制就绪门控）+ `win_cs2_console` 控制台注入 |

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
│   ├── src-tauri/                     # Tauri 桌面壳（Python 生命周期 / NSIS resources）
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

### 源码安装

#### 1. Backend

```powershell
# 先安装 uv 0.11.x，再在仓库根目录执行。
# 默认依据 uv.lock 创建 .venv，并安装哈希锁定的 Windows CPython 3.12 wheel。
.\packaging\demoparser-lean\setup-backend-dev.ps1

.\.venv\Scripts\python.exe -m uvicorn app.main:app `
  --app-dir backend --reload --port 8000
```

发行版内置的 Python 运行时为 `3.12`。2D 回放依赖项目固定的
`demoparser2 0.41.4+cs2insight5` PyO3/Rust 扩展，不能用 PyPI 原版替代。
如果需要重建 wheel，已安装 Rust 工具链的开发者可以执行：

```powershell
.\packaging\demoparser-lean\setup-backend-dev.ps1 -BuildFromSource
```

后端启动时会校验 wheel 版本以及 `write_replay_parquet`、
`read_replay_parquet_round`、`read_replay_parquet_round_binary` 三个 Rust
接口。运行时不匹配会直接终止启动，不会静默退回 JSON 回放。

#### 2. Frontend

```bash
cd frontend
pnpm install --frozen-lockfile

# 仅启动浏览器前端开发服务器
pnpm run dev

# 启动 Tauri 桌面开发模式（自动启动 Python 后端）
pnpm run desktop:dev
```

前端跑在 `http://localhost:5173`，Vite 已配置代理把 `/api/*` 转发到后端 `http://localhost:8000`。

#### 3. 打包

```bash
# 仅打包前端静态资源
pnpm run build

# 打包 Tauri NSIS 安装包
pnpm run desktop:build
```

安装包输出至 `frontend/src-tauri/target/release/bundle/nsis/`。正式发布版不启用应用内自动更新，用户从 Releases 页面下载新版。

---


---

## API Endpoints（节选）

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 获取配置 |
| PUT | `/api/config` | 更新配置 |
| POST | `/api/config/detect-cs2` | 自动探测 cs2.exe 路径 |
| POST | `/api/obs/test` | 测试 OBS WebSocket 连接 |
| POST | `/api/demo/upload` | 单文件上传 |
| POST | `/api/demo/upload-multiple` | 多文件上传 |
| POST | `/api/demo/parse` | 单玩家解析 |
| POST | `/api/demo/parse-multi` | 同 Demo 多玩家解析 |
| POST | `/api/demo/parse-batch` | 跨 Demo 批量解析 |
| GET | `/api/demos` | Demo 库列表（分页） |
| GET | `/api/demos/stream` | 库变更 SSE 流 |
| POST | `/api/demos/scan` | 手动扫描监听目录 |
| POST | `/api/demos/{id}/parse` | 重新解析 |
| POST | `/api/demos/{id}/analyze` | 直接对库内 Demo 出片段 |
| GET | `/api/demos/{id}/players` | 库内 Demo 玩家名册 |
| POST | `/api/recording/queue` | 批量录制：`RecordingRequestDTO[]` → `plan_builder` → `execute_plan_queue` |
| POST | `/api/recording/plan` | 预览 `RecordingPlan`（active / disabled 段、warnings、末回合元数据） |
| POST | `/api/recording/execute` | 单条 DTO 即时执行（调试用，不经队列编排） |
| POST | `/api/recording/abort` | 中止当前进行中的批量录制队列 |
| GET | `/api/recorded-clips` | 已录片段列表（合辑工作台） |
| POST | `/api/montage/projects` | 保存合辑工程 |
| POST | `/api/montage/export` | FFmpeg 合辑导出 |
| POST | `/api/gsi/cs2` | CS2 GSI Sink（录制就绪门控） |
| GET | `/api/gsi/status` | 查看最近 GSI 状态 |

---
