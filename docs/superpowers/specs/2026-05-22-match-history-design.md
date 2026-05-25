# 官匹战绩功能设计文档

**日期**：2026-05-22  
**状态**：已批准，待实施

---

## 功能概述

在 CS2 Insight Agent 桌面客户端新增「官匹战绩」页面。用户输入 Steam Web API Key 和 SteamID64，即可拉取官方匹配（优先排位 / 竞技）战绩，并直接在后端下载 Valve 官方 Demo、解压入库，送入现有 Demo 库解析流程。

---

## 架构决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| Steam 凭据存储 | 并入现有 `AppConfig` JSON | 结构统一，复用 `PUT /api/config` |
| Steam API 调用 | 后端代理 | 规避 CORS，凭据不暴露到前端 |
| Demo 下载 | 后端直接下载 .bz2 + 解压 | 端到端自动入库，用户无需手动操作 |

---

## 后端设计

### AppConfig 新增字段（env_utils.py）

```python
steam_api_key: str = ""       # Steam Web API Key（32 位字符串）
steam_id64: str = ""          # SteamID64（17 位数字，以 7656119 开头）
match_mode: str = "premier"       # premier（优先排位）/ competitive（竞技）
match_count: int = 20         # 20 / 50 / 100
```

### 新模块：`backend/app/steam_match_history.py`

职责：
- `fetch_match_history(api_key, steam_id64, mode, count)` → 调 `ICSGOServers_730/GetMatchHistory/v001`，返回原始 match 列表
- `fetch_player_summary(api_key, steam_id64)` → 调 `ISteamUser/GetPlayerSummaries/v002`，返回头像、昵称
- `test_connection(api_key, steam_id64)` → 验证凭据有效性，返回玩家基础信息
- `download_demo(demo_url, dest_dir)` → 异步下载 .bz2，bz2 解压到 `dest_dir`，返回最终文件路径
- 保留期判断：`match_timestamp + 8天 < now` → 标记 `expired: true`

### 新路由（main.py 中 include_router 或直接挂载）

| Method | Path | 功能 |
|--------|------|------|
| `GET` | `/api/match-history/matches` | 代理调 Steam API，返回加工后的战绩 JSON |
| `POST` | `/api/match-history/test-connection` | 验证凭据，返回玩家昵称/头像 |
| `POST` | `/api/match-history/download` | body: `{demo_url, match_id}` → 下载解压到 demo_watch_paths[0]，触发入库 |

#### GET /api/match-history/matches 响应结构（简化）

```json
{
  "player": {
    "name": "...", "avatar": "...", "steam_id64": "...",
    "cs_rating": 18432, "cs_rating_delta": 124
  },
  "stats_summary": {
    "wins": 13, "losses": 7,
    "avg_kd": 1.18, "headshot_pct": 48, "avg_adr": 82.4, "rating": 1.21
  },
  "matches": [
    {
      "match_id": "...",
      "map": "de_mirage",
      "mode": "premier",             // premier / competitive
      "result": "win",           // win / loss / tie
      "score_own": 13, "score_opp": 9,
      "duration_sec": 2280,
      "played_at": "2026-05-20T13:42:00Z",
      "rounds": [true, false, ...],  // true=赢, false=输, null=未打
      "kills": 24, "deaths": 16, "assists": 5,
      "headshot_kills": 12,
      "damage": 1443,
      "mvp_count": 4,
      "ace_count": 0, "quad_count": 1,
      "demo_url": "http://...",    // Steam CDN URL
      "demo_size_bytes": 134217728,
      "demo_expired": false,
      "demo_in_library": false,    // 后端检查 demo_db 是否已入库
      "demo_expires_at": "2026-05-28T13:42:00Z"
    }
  ],
  "total": 47,
  "page": 1,
  "page_size": 20
}
```

---

## 前端设计

### 路由 & 导航

- 路由：`/match-history`（在 `App.jsx` Routes 中新增）
- Sidebar `SidebarNav.jsx`「工具」分组末尾新增一项：
  - 图标：`Trophy`（lucide-react）
  - 文字：`官匹战绩`
  - 角标：`新`（localStorage 记录首次访问后隐藏）

### 文件结构

```
frontend/src/
  pages/
    MatchHistoryPage.jsx         # 主页面（状态中心）
  components/matchHistory/
    CredentialPanel.jsx          # 凭据两态面板（表单 / 已配置条）
    PlayerOverviewPanel.jsx      # 玩家卡 + 统计概览
    MatchHistoryFilterBar.jsx    # 筛选栏（前端过滤）
    MatchHistoryRow.jsx          # 单条战绩行（7 列 grid）
    RoundsStrip.jsx              # 逐回合走势条带
    DemoDownloadCell.jsx         # Demo 下载按钮（三态）
  api/
    matchHistoryApi.js           # 封装 3 个后端接口
```

### 页面状态机（MatchHistoryPage）

```
初始化
  ├─ 无凭据 → 展示表单
  └─ 有凭据 → 折叠状态条 → 自动 fetchMatches()
fetchMatches()
  ├─ loading: true
  ├─ 成功 → 渲染列表
  └─ 失败 → 错误提示
downloadDemo(match_id, demo_url)
  ├─ 按钮 loading
  ├─ POST /api/match-history/download
  ├─ 成功 → 该条 demo_in_library = true → 按钮变「已入库」
  └─ 失败 → toast 错误
batchDownload(selected_ids)
  → 逐个串行调 downloadDemo
filterMatches(filters)
  → 纯前端过滤，不重新请求
exportCsv()
  → 前端 Blob 导出已加载数据
```

### 关键 UI 还原点（对照高保真原型）

- **CS Rating 色阶**：灰/蓝/紫/粉/红/金，按分数区间着色
- **逐回合走势**：24 格 grid，赢=`#2eb86a`，输=`#e0556a`，未打=`#25252c`
- **结果色条**（左侧 4px）：胜绿 / 负红 / 平琥珀
- **综合评分**（HLTV 2.0 近似）：≥1.20 绿，<0.95 红
- **Demo 按钮三态**：可下载（普通）/ 已入库（绿色+勾）/ 已过期（灰色禁用）
- **保留期提示**：距过期剩余时间实时计算展示（`剩 7d 14h`）

---

## 数据流

```
用户输入凭据
  → PUT /api/config {steam_api_key, steam_id64, match_mode, match_count}
  → GET /api/match-history/matches
      → 后端调 Steam GetMatchHistory API
      → 后端调 Steam GetPlayerSummaries API
      → 后端检查每个 match 的 demo_url 是否已在 demo_db
      → 返回加工后 JSON
  → 前端渲染列表

用户点击「下载 Demo」
  → POST /api/match-history/download {demo_url, match_id}
      → 后端下载 .bz2 到 temp
      → bz2 解压到 demo_watch_paths[0]
      → 触发 demo_library_hub 入库
      → 返回 {path: "...", demo_id: "..."}
  → 前端将该条标记 demo_in_library=true
  → 「已入库」按钮，点击跳转 /library
```

---

## 错误处理

| 场景 | 处理 |
|------|------|
| Steam API 返回 403 | 提示「API Key 无效，请检查凭据」 |
| Steam API 返回 429 | 提示「请求过于频繁，请稍后再试」 |
| demo_watch_paths 为空 | 提示「请先在 Demo 库设置监听目录」，禁用下载按钮 |
| 下载超时（默认 120s） | 提示「下载超时」，按钮恢复可点击 |
| 解压失败 | 提示「文件损坏或格式不支持」 |
| Demo 已过期 | 灰色禁用按钮，不发请求 |

---

## 不在本次范围内

- 批量勾选 UI（复选框）：原型中未完整定义，首版以「全选」代替
- 「逐回合走势」超过 24 轮的加时赛显示
- Demo 下载进度条（WebSocket 推送）
- 历史 CS Rating 趋势图
