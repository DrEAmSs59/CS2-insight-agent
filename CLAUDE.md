# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

CS2 Insight Agent — Windows 桌面端 CS2 电竞终端。自动解析 `.dem` 录像提取高光/下饭/梗死亡片段，可选 LLM 锐评，通过 OBS WebSocket 全自动控制 CS2 回放并录制成片。

- **目标平台**: Windows（录制 / CS2 控制仅 Windows 可用）
- **开发平台**: macOS / Linux 可启动后端和前端，解析、AI、Demo 库等功能均可正常开发调试
- **Backend**: Python 3.10+ / FastAPI / uvicorn
- **Frontend**: React 19 / TailwindCSS 4 / Vite 6 / Zustand
- **解析引擎**: `demoparser2`（Rust 实现，可能 panic）
- **AI 网关**: litellm（单片段）+ openai SDK（批量评审），OpenAI 兼容协议
- **OBS 控制**: `obs-websocket-py`
- **Demo 库**: `aiosqlite` + `watchdog` 目录监听
- **CS2 集成**: Game State Integration（GSI HTTP sink，录制就绪门控）

## Commands

```bash
# 开发环境（macOS / Linux）
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -r backend/requirements.txt

# Backend
cd backend
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev          # Vite dev server → http://localhost:5173
npm run build        # Production build → frontend/dist/

# Production launcher (Windows only — SelectorEventLoop 补丁)
python -m app.run_server
```

前端 Vite 已配置 `/api/*` 代理到 `localhost:8000`。生产模式由 FastAPI 直接 serve `frontend/dist/` 静态文件。

### 跨平台开发

`winreg` 已做条件导入（[env_utils.py](backend/app/env_utils.py#L11-L15)），`win_cs2_console.py` 提供非 Windows 空实现。macOS / Linux 上可正常使用：

- 解析 Demo、AI 锐评、Demo 库、GSI HTTP sink
- 完整前端 UI
- 录制功能（CS2 启动 / OBS 控制 / 控制台注入）仅 Windows 可用，调用时返回错误提示

## Architecture

### 核心数据流

```
.dem 文件 → demo_parse_isolation.py (子进程隔离) → demo_parser.py (解析引擎)
    → clips[] → ai_reviewer.py / insight_agent.py (可选 LLM 锐评)
    → 前端展示 → obs_director.py (OBS + CS2 回放录制)
```

### 子进程隔离解析

`demoparser2` 是 Rust 实现，遇到坏 demo 可能触发 `PanicException`（不是 `Exception` 子类），会直接拖垮进程。因此所有解析都通过 [demo_parse_isolation.py](backend/app/demo_parse_isolation.py) 启动独立子进程（[parse_worker.py](backend/app/parse_worker.py)）执行，超时默认 240s（环境变量 `CS2_INSIGHT_PARSE_WORKER_TIMEOUT_SEC`）。

### Windows 事件循环补丁

[run_server.py](backend/app/run_server.py) 在生产启动时强制使用 `SelectorEventLoop`，因为 Windows `ProactorEventLoop` 在录制流程 `subprocess.Popen` 启动 CS2 时，IOCP accept 会收到 `WinError 64` 并导致 8000 端口停止监听。补丁方式：`set_event_loop_policy` + monkey-patch `uvicorn.loops.asyncio.asyncio_loop_factory`。

### API 路由（[main.py](backend/app/main.py)）

所有路由在单文件 `main.py` 中定义（~51KB）。关键端点：
- `POST /api/demo/parse` — 单玩家解析
- `POST /api/demo/parse-batch` — 跨 demo 批量解析
- `POST /api/record/start` — 单 demo 录制
- `POST /api/record/batch` — 跨 demo 批量录制
- `POST /api/gsi/cs2` — CS2 GSI HTTP sink（录制就绪门控）
- `GET /api/demos/stream` — Demo 库 SSE 实时推送

### 录制流程（[obs_director.py](backend/app/obs_director.py)）

1. 检查 CS2 是否已运行 → 阻断弹窗
2. 启动 CS2（`-insecure` + demo 参数）
3. 等待 GSI 就绪（`gsi_ready.py`，默认 120s 超时）→ 确认已进入游戏画面
4. 注入观战预热 cvar（`cl_draw_only_deathnotices` 等）→ 通过 [win_cs2_console.py](backend/app/win_cs2_console.py) 的 `SendInput`/`WM_CHAR` 注入控制台
5. 逐片段 seek tick + OBS `StartRecord` / `StopRecord`
6. 录制结束 `taskkill` CS2，回滚玩家 config 备份

### AI 锐评（两条路径）

- [insight_agent.py](backend/app/insight_agent.py) — litellm 单片段点评（`ai_score` + `ai_commentary`）
- [ai_reviewer.py](backend/app/ai_reviewer.py) — openai SDK 批量片段点评 + 「研发全集」整局总评（`ai_score` + `ai_comment`，字段名不同）

两者输出字段不统一：`insight_agent.py` 用 `ai_commentary`，`ai_reviewer.py` 用 `ai_comment`。前端 [ClipCard.jsx](frontend/src/components/ClipCard.jsx) 需要同时兼容。

### 前端结构

[App.jsx](frontend/src/components/../App.jsx) (~73KB) 是单文件状态中心，通过 `axios` 直接调用 `/api/*`。Zustand store [recordingQueueStore.js](frontend/src/stores/recordingQueueStore.js) 管理跨组件录制队列状态。其余组件在 `components/` 下，最大的三个：`RecordingQueueDrawer`（35KB）、`CommonParamsModal`（25KB）、`Sidebar`（23KB）。

### 配置管理（[env_utils.py](backend/app/env_utils.py)）

单文件 JSON 配置（Pydantic 模型 `AppConfig`），默认路径为仓库根目录 `cs2-insight.config.json`。可通过环境变量 `CS2_INSIGHT_CONFIG` 覆写路径。`cs2_path` 支持自动探测（注册表 + Steam libraryfolders.vdf + 常见盘符遍历）。旧版 `backend/config.json` 首次加载时自动迁移。

### Demo 库（[demo_db.py](backend/app/demo_db.py) + [demo_watcher.py](backend/app/demo_watcher.py)）

SQLite（`cs2-insight.db`），两张主表 `demo_files`（文件元数据 + 解析状态）和 `match_results`（解析结果 JSON）。`watchdog` 监听用户配置的目录，新文件自动入库，通过 [demo_library_hub.py](backend/app/demo_library_hub.py) 的 SSE pub/sub（~0.55s 防抖）推送给前端。并发入库使用 64 条 striped lock 防止重复写库。

### 解析引擎（[demo_parser.py](backend/app/demo_parser.py)）

项目最大文件（229KB）。基于 `demoparser2` 的 tick 级事件数据（`player_death`、`weapon_fire`、`player_hurt`、`item_equip` 等），通过三轨数据源检测高级下饭场景。片段分类：highlight（≥3 杀）、fail（被电击枪/沙鹰/队友击杀等）、meme_death（o/i/z/211 系列）、compilation（跨回合合集如亲儿子喂饭/本命苦主）。
