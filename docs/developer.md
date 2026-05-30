## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + React Router + TailwindCSS 4 + Vite 6 + Zustand |
| Desktop | Electron 42（Windows 安装包 / `electron-updater` 程序内自动更新） |
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

### 源码安装

#### 1. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# 或
python -m uvicorn app.main:app --reload --port 8000
```

发行版内置的 Python 运行时为 `3.12`。

#### 2. Frontend

```bash
cd frontend
npm install

# 仅启动前端开发服务器（不含 Electron 壳）
npm run dev

# 启动 Electron 开发模式（内嵌前端 + 自动重载）
npm run electron:dev
```

前端跑在 `http://localhost:5173`，Vite 已配置代理把 `/api/*` 转发到后端 `http://localhost:8000`。

#### 3. 打包

```bash
# 仅打包前端静态资源
npm run build

# 打包 Electron 安装包（输出至 frontend/dist_electron/）
npm run electron:build
```

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