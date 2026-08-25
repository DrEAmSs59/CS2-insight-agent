# 分支说明：cs数据图（CS Data Radar / 战力雷达图专栏）

> 本文档面向 **CS2-insight-agent-main 项目作者**，说明本分支相对主干的全部改动，
> 供合并 / 移植 / 继续开发参考。本分支在主干基础上新增了一个完整的「cs数据图」
> 功能模块（后端渲染 + 前端工作台 + 合辑导出集成），并修复了若干合辑导出相关缺陷。
>
> 分支基调：**纯增量 + 局部修复**。未改动主干的数据库 schema、录制管线与 LiteCut；
> 新增功能全部挂在独立路由 / 独立存储目录下，主干代码仅做了兼容性小改（见下文）。

---

## 一、功能总览（相对主干的增量）

| 功能 | 说明 | 入口 |
| --- | --- | --- |
| 六维战力雷达图自动生成 | 对局解析后为**全部玩家**一键生成 2560×1440（16:9）雷达卡片 | Demo 分析页「自动录制全部玩家雷达图」 |
| 雷达图样式 | 参照 Rock-Radar-main 霓虹风格：蓝外圈=满分刻度 / 灰内圈=等级区间 / 主题色多边形=玩家数据 / 红色六边形=全场平均线 | — |
| 人物头像 | 前端上传头像，或一键套用 Steam 游戏内头像，自动重渲染 | cs数据图 专栏卡片 |
| 队伍队标 | 上传队标后**放大显示在头像后面**（圆形裁切+羽化+半透明） | cs数据图 专栏卡片 |
| 开场动画 | 每卡一键生成 4s 开场动画 MP4（**慢入→快出→定格**，24fps，渲染 2560×1440 → 输出 1920×1080） | 🎬 按钮 / 批量生成 |
| 多选批量生成 | 勾选多张卡片一键并发批量生成动画（帧渲染多进程并行） | 卡片勾选框 + 批量按钮 |
| 合辑集成 | 确认「在剪辑前加入 CS 雷达图」→ 选人 → 插入到指定片段前（有动画用视频段，否则静态图） | 合辑工作台 → 剪辑编排 → cs数据图 专栏 |

---

## 二、后端改动（按文件）

### 2.1 新增 `backend/app/features/cs_data_radar/`（独立功能包）

```
cs_data_radar/
├── __init__.py
├── radar_model.py        # 六维数据模型与派生统计
├── radar_renderer.py     # 静态卡片渲染（2560×1440，16:9 构图）
├── radar_animation.py    # 开场动画逐帧渲染 + ffmpeg 编码
├── store.py              # 卡片存储（JSON 索引 + PNG/头像/队标/动画文件）
└── api.py                # FastAPI 路由（/api/cs-data-radar/*）
```

#### radar_model.py
- `RADAR_DIMENSIONS`：六维定义与**满分基准**（用户指定值）——
  KPR `0.85`、生存率 `44%`、ADR `85`、KAST `78%`、多杀回合 `20%`、Rating `1.3`。
  注意 **Impact 已被「Multi-kill（多杀回合）」替换**为展示维度（Impact 仅内部参与 Rating 派生）。
- `derive_radar_stats(player)`：从对局解析行派生六维；
  `multi_kill = (two+three+four+five_kill_rounds) / rounds`。
- `normalize_radar_values(radar)`：数值 / 满分 归一化，`NORMALIZE_CEILING=1.6` 封顶——
  **允许超出满分溢出到蓝色外圈之外**（用户要求）。
- `compute_match_avg_radar(players)`：本场全部玩家六维派生值的平均 → **红色全场平均线**基准。
- `format_radar_value(key, value)` / `average_radar_value(values)`。

#### radar_renderer.py（静态卡片）
- 16:9 常量：`CANVAS_W=2560`、`CANVAS_H=1440`、`RADAR_CENTER=(640,730)`、`MAX_R=400`、
  `LABEL_MARGIN=54`、`PORTRAIT_CENTER=(1890,600)`、`PORTRAIT_SIZE=640`、`GOLD=(255,201,92)`。
- 构图（左右分割式）：左半部 = 雷达数据面板（雷达居中 + 背后超大 **CNCS 水印**，`_font_latin(520)`）；
  右半部 = 人物大肖像（垂直中线偏右）；深灰偏黑底 + 金色节点射线「立体星空」几何网 + 四边发光牢笼；
  左右以暗金色 `_draw_connection_line` 连接。
- 雷达元素：`_draw_grid_and_axes`（**蓝色外圈 = 最高刻度**，仅发亮蓝描线无填充；灰色内圈 = 等级区间）、
  `_glow_polygon`（主题色多边形：青蓝 CT / 橙红 T，半透明填充 + 辉光 + 白芯描边）、
  `_draw_labels`（维度名 + 玩家数值 + **「满分 X」中文**，用 `_font_cjk` 避免豆腐块）、
  `_draw_match_avg_reference`（**红色六边形 = 全场平均线**：红描线 + 辉光，无红色填充）。
- `_draw_portrait(...)`：头像圆形裁切 + 金色光环；无头像时昵称首字占位。
- `_draw_team_logo_backdrop(canvas, logo_path, cx, cy)`：**队标放大显示在头像后面**——
  直径约为头像 1.8 倍，圆形裁切 + 径向羽化 + 高斯模糊 + 整体透明度 ~0.4，作为发光衬底。
- `render_radar_card(...)`：组合以上所有层，输出 2560×1440 PNG。

#### radar_animation.py（开场动画）
- 参数：`FPS=24`、`DURATION=4.0s`（96 帧）、渲染 2560×1440 → `encode_animation` 缩放输出 1920×1080。
- **动画节奏（用户最终确认版，取代早期三阶段/回弹方案）**：
  - 慢入（0→30%）：`_ease_in(p, 2.5)`，多边形 scale 0.30→0.55 缓速积蓄；金色网格呼吸、KPR/Rating 数据点冷白微光、头像金圈脉动、CNCS 水印金光微闪；
  - 快出（30%→60%）：`_ease_out_cubic`，scale 0.55→1.00 快速扩张到位，各维度数据闪电般射向边缘（放射闪光）；
  - 定格（60%→100%）：scale 恒为 1.0 **锁定在应有位置**——**无过冲、无回弹、单调递增 ≤1.0**（用户明确要求）。
- `_scale_at(tt)`：分段曲线 `P1_END=0.30`、`P2_END=0.60`，之后冻结在 1.0。
- **红色全场平均线 `_match_avg_alpha=1.0`，从第 1 帧起全程完全可见**（用户要求"要一直可见"）。
- 帧渲染：`render_animation_frames(..., workers)` 用 `ProcessPoolExecutor` 多进程分片渲染
  （帧之间完全独立），单卡约 2.9× 提速；`generate_radar_animation` 渲染后经 ffmpeg 编码并清理临时帧目录。

#### store.py（存储）
- 目录结构（`data/cs_data_radar/`）：
  `cards.json` 索引、`<card_id>.png` 成品图（平铺根目录）、`portraits/`、`team_logos/`、`animations/`。
- 卡片字段：`id / demo_id / demo_name / player_key / player_name / steam_id64 / team_key / team_label /
  kills / deaths / assists / stats / radar / match_avg / image_file / video_file / portrait_file / team_logo_file / created_at`。
- 关键函数：`create_cards_from_players`（全场平均线 + 批量渲染）、`set_card_portrait`、
  `set_card_team_logo` / `clear_card_team_logo`、`clear_card_video`、`generate_card_animation`、
  `delete_card`、`_card_public`（对外暴露 `image_url/portrait_url/team_logo_url/video_url/image_path/video_path` 绝对路径，供合辑导出直接使用）。

#### api.py（路由）
- `POST /api/cs-data-radar/cards` — 为整场玩家生成卡片（自动录制）
- `GET  /api/cs-data-radar/cards` / `DELETE /api/cs-data-radar/cards/{id}`
- `POST /api/cs-data-radar/cards/{id}/portrait` — 上传头像；**若该卡已有动画 → 自动用新头像重新生成**
- `POST /api/cs-data-radar/cards/{id}/team-logo` / `DELETE .../team-logo` — 上传/清除队标（同样联动动画重生成）
- `POST /api/cs-data-radar/cards/{id}/animation` — 按需生成开场动画
- `POST /api/cs-data-radar/cards/batch-animation` — 并发批量生成（`workers = max(1, cpu//len)` 自动降载）
- `PUT  /api/cs-data-radar/cards/{id}/image` — 前端 Canvas PNG 替换成品
- `GET  /api/cs-data-radar/images/{file}` / `videos/{file}` — 图片/视频服务（兼容根目录、images/、portraits/、team_logos/）
- `RadarPlayerStats` 使用 `ConfigDict(extra="allow")`，保留 `two_kill_rounds` 等派生字段。
- **外观变化联动动画**（关键设计）：头像/队标上传后旧动画里的内容是烘焙的旧图，
  `_regenerate_or_clear_video()` 统一处理——有 FFmpeg 则用新图重新生成动画；无 FFmpeg 则删除旧动画回退静态图。
  动画文件名为确定性 `animations/<card_id>.mp4`，合辑时间轴段自动指向新视频，无需改时间轴。

### 2.2 修改 `backend/app/main.py`
- 注册 `cs_data_radar` 路由（`app.include_router(cs_data_radar.router)`）。

### 2.3 修改 `backend/app/video_composer.py`（合辑导出集成 + 修复）
- `compose_montage` / `_compose_montage_impl` / `_compose_montage_once` 增加 `radar_segments` 参数：
  雷达段在**指定片段序号之前**插入（`before_clip_index` 由 `before_clip_id → clip_ids 下标` 映射）。
- `seg_to_clip_ordinal`：名牌等只在真实剪辑片段上烧录，雷达段不参与。
- **转场硬切边界**：雷达段插入点两侧强制硬切（`i in _radar_by_clip`），避免 xfade 组跨越雷达段。
- **xfade 组文件只追加一次**（`first_row_of_group`）：此前同一转场组文件按片段重复拼接，
  导致导出时长放大 10 倍（17.5 分钟 / 4.9GB）——已修复。
- **concat 顺序**：`concat_paths` 按「片头 + 真实片段 + 雷达段 + 片尾」的段顺序重建，此前雷达段被整段丢弃。
- `_normalize_output_acl(path)`：Windows 下导出后 `icacls /inheritance:e`，
  修复导出文件 ACL 仅 SYSTEM/Admin 导致用户无法打开的问题。

### 2.4 修改 `backend/app/api/montage.py`
- 新增 `RadarSegment` 模型（`before_clip_id / image_path / duration=4.0`）；
  `MontageProjectBody / MontageExportBody` 增加 `radar_segments`（前后端快照/导出打通）。

### 2.5 新增测试 `backend/tests/test_cs_data_radar_{model,store,api}.py`
- 26 个用例：六维派生与多杀回合、满分归一化（含溢出 1.6 封顶）、全场平均线、
  卡片增删查、头像/队标上传与清除（含旧文件清理）、**头像/队标重传后动画自动重新生成或清除**、
  动画端点无 FFmpeg 回退、**缓动曲线单调性（无过冲、≤1.0、P2 后冻结）**。

---

## 三、前端改动（按文件）

### 3.1 新增 `frontend/src/features/cs-data-radar/`
- `csDataRadarApi.js`：全部 API 封装（生成/列表/删除/头像/队标/动画/批量/图片视频 URL 构造）。
- `radarDimensions.js`：前端六维定义（与后端一致）、`deriveRadarStats`、归一化封顶 1.6、与全场均值比较。
- `radarCanvas.js`：客户端 Canvas 镜像（当前**未被任何组件引用**，仅为一致性保留，可按需启用）。
- `CsDataRadarPanel.jsx`：cs数据图 专栏主体——
  - 确认开关「在剪辑前加入 CS 雷达图」；
  - 卡片网格：预览（有动画则 `<video>` 循环播放）、**勾选框（多选）**、头像/队标徽章、高于/低于全场均值徽章；
  - 操作：插入到剪辑前（无动画自动先生成）、🎬 单卡动画、上传头像、Steam 头像、**上传/清除队标**、删除；
  - **批量生成**：勾选 N 张 →「批量生成动画（N）」只生成选中卡（未勾选则保持"全部未生成动画"的旧行为）；
  - 已插入雷达段管理（时长、插入位置、移除）。

### 3.2 修改 `frontend/src/components/MontageWorkbenchDrawer.jsx`
- 打开工作台时 `loadRadarCards`；`insertRadarSegment` 优先使用 `video_path`（`isVideo` 标记）；
- 时间轴/快照序列化 `radarSegmentsPayload`（`{before_clip_id, image_path, duration}`），导出恢复支持 mp4 检测。

### 3.3 修改 `frontend/src/components/montage/MontageStyleConsole.jsx`
- 新增「cs数据图」tab（`tabItems` 含 `radar`）。

### 3.4 修改 `frontend/src/components/montage/MontageWorkbenchPanels.jsx`
- 时间轴雷达芯片（▶ 徽章表示视频段）。

### 3.5 修改 `frontend/src/features/demo-analysis/DemoAnalysisPage.jsx`
- 「自动录制全部玩家雷达图」按钮（同时修复了缺失的 `useCallback` 导入——该导入缺失曾导致 /analysis 白屏）。

### 3.6 i18n
- 新增 `frontend/src/i18n/dict/locales/{zh,en}/radar.js`（60+ 键，中英各一份），并在 `zh.js / en.js` 注册；
- `analysis.js` 增加雷达相关键。

### 3.7 修改 `frontend/index.html`
- Google Fonts 改为非阻塞预加载（`rel="preload" as="style"`），避免字体请求阻塞首屏。

---

## 四、动画规格（设计决策记录）

用户需求演化过程中确定并冻结的规格，**合入时请勿擅自改回**：

1. **满分基准（外圈最高刻度）**：KPR 0.85 / 生存率 44% / ADR 85 / KAST 78% / 多杀 20% / Rating 1.3；
   蓝色外圈仅发亮蓝描线 + 辉光，**无填充**。
2. **红色全场平均线**：红色六边形（描线 + 辉光，**无浅红填充**），动画中 **alpha=1.0 从第 1 帧起一直可见**。
3. **动画节奏 = 慢入 → 快出 → 定格**：个人数据多边形先缓速积蓄（30% 前），随后快速扩张到位（30%–60%），
   之后**锁定在应有位置**；**不要**"超出后反弹/回弹"（用户明确否定了 Overshoot + 阻尼回弹方案）。
4. **16:9 构图**：2560×1440；左半部雷达 + 右侧大肖像（垂直中线偏右）；深灰偏黑底 +
   金色节点射线立体星空网（四边发光牢笼）；左右金色连接线；雷达背后超大半透明 **CNCS** 水印。
5. **队标**：放大显示在头像后面（1.8×、羽化、半透明、模糊），不抢头像主体。
6. **多杀替换 Impact** 作为展示维度。

---

## 五、性能与并发

- 动画帧渲染 `ProcessPoolExecutor` 多进程分片（workers 参数），单卡 ~2.9× 提速；
- 批量端点按卡片数自动降载 `workers = max(1, cpu_count // len(card_ids))`，`asyncio.gather` 并发；
- 静态卡片各层（氛围层/星空网/括号）一次性构建复用，不逐帧重复。

---

## 六、Bug 修复记录（本分支内）

| 问题 | 根因 | 修复 |
| --- | --- | --- |
| 动画里看不见个人数据多边形 | 重构帧循环删除残影时误删 `_draw_animated_polygon` 调用 | 恢复调用（网格后、闪光前） |
| 重传正确头像后动画视频仍是旧头像 | `set_card_portrait` 只重渲染静态 PNG，`video_file` 仍指向旧 MP4 | 头像/队标变化时若有动画 → 自动重新生成；无 FFmpeg → 清旧动画回退静态图 |
| 合辑导出丢雷达段 | `concat_paths` 只含片头+片段+片尾 | 按段顺序重建 concat 列表 |
| 合辑导出时长放大 10× / 4.9GB | xfade 转场组文件被逐片段重复追加 | `first_row_of_group` 只追加一次 + 雷达插入点强制硬切 |
| 导出文件打不开 | Windows ACL 仅 SYSTEM/Admin | `_normalize_output_acl`（icacls /inheritance:e） |
| 「满分」显示豆腐块 | Rajdhani 无中文字形 | 中文一律 `_font_cjk`（Noto Sans SC Medium） |
| Pydantic 丢弃 two_kill_rounds | 严格模式未知字段被丢 | `ConfigDict(extra="allow")` |
| /analysis 白屏 | `useCallback` 未导入 | 补 import |
| 字体阻塞首屏 | fonts.googleapis.com 被墙时阻塞 | index.html 非阻塞预加载 |

---

## 七、运行与验证

```bash
# 后端（需 .venv，Python 3.12）
.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000

# 前端（Vite dev，访问 http://localhost:5173）
cd frontend && pnpm install && pnpm run dev

# 测试（backend 目录下）
.venv\Scripts\python.exe -m pytest tests/test_cs_data_radar_model.py \
    tests/test_cs_data_radar_store.py tests/test_cs_data_radar_api.py -q
```

验证路径：
1. Demo 分析页 → 解析一场对局 → 「自动录制全部玩家雷达图」→ 全部玩家卡片出现；
2. 上传头像 / Steam 头像 / 上传队标 → 静态卡即时重渲染；
3. 勾选多张卡 → 「批量生成动画（N）」→ 视频生成（需在设置页配置 FFmpeg 路径）；
4. 合辑工作台 → 剪辑编排 → 确认「在剪辑前加入 CS 雷达图」→ 选人插入 → 导出验证段顺序与时长。

---

## 八、合并 / 移植建议

- 本分支为**独立功能包 + 兼容性小改**，冲突面小。合入主干时重点检查：
  `video_composer.py`（radar_segments 参数与 concat/xfade 修复）、`api/montage.py`（RadarSegment 模型）、
  `main.py`（路由注册）、`MontageWorkbenchDrawer.jsx`（时间轴段渲染与快照序列化）。
- 若主干后续改了合辑导出管线，请保留：段顺序 concat、xfade 组单次追加、雷达插入点硬切、导出 ACL 归一化。
- 数据目录 `data/cs_data_radar/` 与主库（SQLite）完全独立，删除不影响对局数据。

---

## 九、已知限制 / 注意点

- 动画是**烘焙 MP4**：缓动/背景/字体/头像/队标任何变化都需要重新生成（前端已联动自动重生成）；
  已导出的合辑成片不会随卡片变化而更新，需重新导出。
- 客户端 `radarCanvas.js` 为未启用镜像，若要在浏览器端同步渲染需按 `radar_renderer.py` 的 16:9 常量同步。
- 队标/头像上传需配置 FFmpeg 才会联动重生成动画；未配置时自动降级为静态图段（不报错）。
