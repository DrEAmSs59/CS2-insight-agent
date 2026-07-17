# LiteCut 合集工作台设计文档

> 分支：`refactor/lite-cut-tool-for-CS2`
> 状态：Phase 1 已完成；Phase 2 进行中（资产上传、预设库 UI、V2–V5 叠层导出首版）
> 最后更新：2026-06-12（含风格预设库）
> **开发顺序**：[lite-cut-schedule.md](./lite-cut-schedule.md)（按阶段先做什么后做什么）

---

## 1. 背景与目标

### 1.1 现状问题

现有「合集工作台」（`/montage`）本质是 **片段编排器**：竖向列表排序 + 转场 + BGM/片头片尾 + FFmpeg 导出。缺少：

- 可视化多轨时间轴与比例尺
- 整片连续预览
- 通用剪辑能力（多轨、文字、调色、叠加素材）
- 专业剪辑器式属性面板与轨道旁编辑工具

### 1.2 产品定位

**LiteCut = CS2 录制素材媒体库 + LITE 通用多轨剪辑器 + 本地 FFmpeg 导出**

| 是什么 | 不是什么 |
|--------|----------|
| 嵌入 CS2 Insight 的轻量 NLE | Premiere / 完整 OpenCut 克隆 |
| OBS 录完 → 剪辑 → 导出成片 | 在剪辑器内录 demo / 控 OBS |
| 预览近似、导出权威（FFmpeg） | 浏览器内完整重渲染 / 云端协作 |

### 1.3 与现有系统关系（并行开发 → 验证后切换）

**策略：先独立做新菜单 + 新后端，旧合集工作台不动；测试通过后再一次性替换入口，不做长期双轨产品。**

#### 阶段 A — 并行开发（当前）

```
                    ┌── 录制队列 → recorded_clips（共用）
                    │
Demo 解析 ──────────┤
                    │
                    ├── 【旧】合集工作台  /montage
                    │      └─ MontageWorkbenchDrawer + /api/montage/*
                    │
                    └── 【新】LiteCut      /lite-cut/*
                           └─ 新前端 + /api/lite-cut/*（独立项目/预设/导出 v2）
                                    ↓
                           可复用：recorded_clips 读、FFmpeg 门控
                           新建：lite_cut_projects、lite_cut_presets、composer v2 入口
```

| 维度 | 旧合集工作台 | LiteCut（新） |
|------|--------------|---------------|
| 侧边栏菜单 | 「合集工作台」→ `/montage` | **「LiteCut」** → `/lite-cut`（与旧菜单并存） |
| 后端路由 | `/api/montage/*` 不动 | **`/api/lite-cut/*` 新一套** |
| 项目存储 | `montage_projects.body_json` v1 | **`lite_cut_projects`**（schema v2，新表或新 kind） |
| 导出 | `video_composer.compose_montage` v1 | **composer v2**（新函数或新入口，不破坏 v1） |
| 用户可见 | 生产默认路径 | **内测 / 开发验证路径** |

**原则：**

- 开发期 **不删、不改** 旧菜单与旧 API 行为；避免半成品影响现有用户。
- 新功能只进 LiteCut 链路；旧链路仅作对照与回归基准。
- `recorded_clips`、Demo 库、录制队列 **共用**，不重复造录制入库。

#### 阶段 B — 验证完成后的切换（Cutover）

满足 [§11 验收标准](#11-验收标准v1-整体验收) 且内测无阻塞问题后：

1. 侧边栏 **「合集工作台」** 指向 LiteCut（路由可仍为 `/montage` 或统一 `/lite-cut`，二选一）
2. 旧 `MontageWorkbenchDrawer` / 旧 `/api/montage/projects|export` **下线或 410**（保留只读导出历史一段时间可选）
3. 数据：可选提供 **v1 项目 → v2 只读迁移**；不强制自动迁旧草稿
4. 文档与引导更新为 LiteCut 单一入口

**切换前不做的：** 在旧页面上叠 LiteCut 组件、旧 API 上硬扩 schema v2、让用户在两套菜单间来回切生产流。

#### 共用 vs 新建（汇总）

| 共用（只读或稳定契约） | 新建（LiteCut 专用） |
|------------------------|----------------------|
| `recorded_clips` 表与入库 | `lite_cut_projects` |
| `GET /api/recorded-clips` | `POST/GET /api/lite-cut/projects` |
| FFmpeg 门控、`ffmpeg_path` 配置 | `GET /api/recorded-clips/{id}/stream` |
| CS2 `clip_meta` 字段语义 | `/api/lite-cut/presets`、`/api/lite-cut/assets` |
| — | `compose_lite_cut_montage()`（v2 合成） |
| — | 前端 `frontend/src/pages/liteCut/`、`stores/liteCut/` |

---

## 2. v1 功能边界（已拍板）

### 2.1 Must — v1 必做

#### CS2 集成

- OBS 录制素材自动入库（`recorded_clips` + `clip_meta`）
- 媒体库：搜索、CS2 筛选（高光/下饭/合集/时间线等）
- 元数据在检查器展示（demo、玩家、回合、AI 点评等）
- 拖入时间轴 / 批量加入
- CS2 名牌作为 overlay 预设的一种
- 项目草稿保存与恢复、导出历史
- **风格预设库（历史配置复用）**：保存/应用文字、调色、转场节奏、包装方案等，跨天用于新素材
- 智能排序快捷（排完后可手调）

#### 多轨与时间轴

- **5 条视频轨**（V1–V5），上层遮下层
- **Overlay 轨**：文字、贴纸、透明 WebM、名牌
- **2 条音频轨**：A1 BGM、A2 音效/旁白
- 可视化时间轴：比例尺、缩放、播放头
- 片段：拖入、移动、trim、分割、删除、复制
- 转场：硬切、淡、闪白、黑场、缩放 + 扩展内置（擦除、滑动、模糊、故障、旋转等）
- 撤销 / 重做
- 轨道：显示/隐藏、锁定、静音

#### 预览

- **整片连续播放**（跨轨、跨片段）
- 多轨叠层预览（近似）
- 播放头与预览、时间轴联动
- 明确提示：「预览为近似合成，成片以 FFmpeg 导出为准」

#### 文字 / 贴纸

- 自由拖拽 + 字体选择 + 入场/出场动画（预设）
- 花字预设库 + 可改字
- **支持上传字体**（TTF/OTF/WOFF2）
- PNG/WebP 贴纸、缩放旋转

#### 调色 / 特效（LITE）

- 亮度 / 对比度 / 饱和度滑条（必须）
- 预设滤镜包（8+ 一键预设，可叠加滑条微调）
- 片段级：暗角、模糊等少量特效

#### 音频

- BGM：选文件、音量、起始偏移、淡入淡出
- 片段原声：音量、静音
- 预览听感近似，导出 FFmpeg 混音

#### 导出

- 本地 MP4，用户指定路径
- FFmpeg 真实合成（多轨、转场、overlay、调色、BGM）
- 导出进度与可取消

#### 自定义资产（v1 产品承诺）

- **叠加素材 Tab**：拖放透明 WebM、PNG、GIF 等到 V2–V5
- **自定义转场**：上传 WebM/MP4/PNG 序列（导出侧映射）
- **自定义字体**：上传并用于导出（drawtext 或预渲染）

### 2.2 Won't — v1 明确不做

- 无限轨道、关键帧曲线编辑器、节点调色
- 自动字幕 / AI 剪片 / 插件市场
- Fork 或嵌入 OpenCut 源码
- 导入 `.prproj` / `.mogrt`
- 预览与导出像素级一致
- 3D 文字、粒子、专业混音台（VST/bus）
- Ripple / roll / slip / slide 全套 NLE 工具

### 2.3 预览 vs 导出契约

| 维度 | 预览（客户端） | 导出（FFmpeg） |
|------|----------------|----------------|
| 多轨叠加 | DOM/Video/Canvas 叠层 | overlay / concat / xfade |
| 转场 | CSS/Canvas 近似 | xfade 等 |
| 调色 | CSS filter 近似 | eq / colorbalance 等 |
| 文字 | 浏览器渲染 | drawtext 或 PNG bake |
| 透明 WebM | `<video>` 叠层 | overlay（alpha） |
| 字体 | @font-face | 数据目录字体 + drawtext |
| BGM | Web Audio 混播 | amix / volume |

---

## 3. 信息架构与界面设计

> 样稿路由：`/lite-cut/*`（**阶段 A** 独立入口；**阶段 B** 验证通过后替换侧边栏「合集工作台」）

### 3.1 整体布局（Clipchamp 式）

```
┌─────────────────────────────────────────────────────────────┐
│ 顶栏：项目名 · 保存 · Export                                  │
├──────────┬──────────────────────────────┬─────────┬────────┤
│ 媒体库   │         预览画布              │ 属性面板 │ 图标轨 │
│ (左)     │    (居中，letterbox)          │ (宽)    │ (窄)   │
│          ├──────────────────────────────┤         │ 片段   │
│          │ 播放控制（贴预览下方）         │         │ 文字   │
│          ├──────────────────────────────┴─────────┤ 调色   │
│          │ 时间轴工具栏：撤销/分割/复制/删除/吸附    │ 音频   │
│          │ V1–V5 + Overlay(T) + A1/A2              │ 速度   │
│          │ 胶片条缩略图 + 播放头                     │ 导出   │
└──────────┴───────────────────────────────────────────────┘
```

**设计决策记录：**

| 决策 | 结论 | 原因 |
|------|------|------|
| 编辑按钮位置 | **时间轴上方**，非顶栏 | 贴近操作对象，符合 PR/Clipchamp |
| 播放控制 | **预览下方**，非顶栏 | 视觉焦点在画布 |
| 属性 Tab | **右侧竖向图标轨 + 左侧宽面板** | 对齐 Clipchamp，避免顶部横向 Tab 表单感 |
| 点「文字」时左侧 | **保持媒体库不变** | 文字样式只在右侧编辑；左栏切换曾造成困惑 |
| 样稿横幅 | **已移除** | 正式 UI 不展示「样稿」字样 |

### 3.2 媒体库（左栏）

**Tab：录制素材 | 叠加素材**

| Tab | 内容 |
|-----|------|
| 录制素材 | OBS `recorded_clips`；筛选、搜索、拖入 V1 等 |
| 叠加素材 | 透明 WebM、PNG、GIF；拖放上传；拖到 V2–V5 或预览区 |

### 3.3 属性面板（右栏）

| 图标 | 面板内容 |
|------|----------|
| 片段 | 缩略图、CS2 元数据、内置转场网格（12+）、自定义转场上传、淡化、音量 |
| 文字 | 花字预设卡片、字体上传、字号、编辑区、动画 |
| 调色 | 滤镜缩略图网格、Brightness/Contrast/Saturation、Reset、特效 |
| 音频 | BGM、原声、A2 音效导入、波形示意、主音量 |
| 速度 | 快捷档位、自定义%、保持音调、时长变化、倒放 |
| 导出 | 文件名、目录、分辨率预设、FFmpeg 导出 |

### 3.4 时间轴

- V1 主轨：CS2 录制片段（胶片条纹理）
- V2–V5：画中画、贴纸、透明 WebM 等
- T：文字块（色块标识）
- A1/A2：BGM 与音效
- 同轨内 v1 **禁止片段重叠**（实现时二选一：禁止或自动推开，默认禁止）

### 3.5 样稿页面清单

| 路由 | 用途 |
|------|------|
| `/lite-cut` | 入口 hub |
| `/lite-cut/editor` | 主剪辑界面 |
| `/lite-cut/text` | 默认打开文字面板 |
| `/lite-cut/color` | 默认打开调色面板 |
| `/lite-cut/export` | 导出流程 mock（含进度/完成弹层） |

样稿代码位置：`frontend/src/components/liteCut/mock/`

---

## 4. 数据模型（目标 schema）

> 当前 `montage_projects.body_json` 为 v1 编排格式。LiteCut 使用 **schema v2** 存于 `lite_cut_projects`；Cutover 前可选提供 v1→v2 只读迁移，不共用同一张项目表。

### 4.1 项目 Project

```typescript
interface LiteCutProject {
  id: number | null;
  name: string;
  schema_version: 2;
  output: { dir: string; filename: string; width: number; height: number; fps: number };
  tracks: Track[];
  overlays: OverlayLayer[];
  audio: { bgm?: BgmConfig; master_volume: number };
  template_id?: string;          // 若从模板创建
  created_from_template?: boolean;
}
```

### 4.2 轨道与片段

```typescript
interface Track {
  id: string;
  type: "video" | "overlay" | "audio";
  label: string;
  locked: boolean;
  hidden: boolean;
  muted: boolean;
  clips: TimelineClip[];
}

interface TimelineClip {
  id: string;
  source_type: "recorded_clip" | "file" | "text" | "template_asset";
  source_id?: number;            // recorded_clips.id
  file_path?: string;            // 本地导入 / 叠加 webm
  timeline_start: number;        // 秒
  trim_in: number;
  trim_out: number | null;
  transition_out?: Transition;
  color?: { brightness: number; contrast: number; saturation: number; filter_preset?: string };
  speed?: number;                // 1.0 = 100%
  volume?: number;
  meta?: Record<string, unknown>; // CS2 clip_meta 快照
}
```

### 4.3 文字 / Overlay

```typescript
interface OverlayLayer {
  id: string;
  type: "text" | "sticker" | "webm" | "name_card";
  timeline_start: number;
  duration: number;
  transform: { x: number; y: number; scale: number; rotation: number };
  text?: {
    content: string;
    font_family: string;
    font_file?: string;          // 上传字体路径
    font_size: number;
    preset_id?: string;
    anim_in?: string;
    anim_out?: string;
  };
  asset_path?: string;           // webm / png
}
```

### 4.4 与现有 API 映射

> **阶段 A**：LiteCut 走 **`/api/lite-cut/*`**，不修改 `/api/montage/*` 契约。Cutover 后旧 export 下线。

| 旧合集 (v1) | LiteCut (v2) |
|-------------|--------------|
| `recorded_clip_ids[]` + `transitions{}` | `tracks[].clips[]` 全量描述 |
| `MontageProjectBody` | `LiteCutProjectBody`（新 schema） |
| `POST /api/montage/projects` | `POST /api/lite-cut/projects` |
| `POST /api/montage/export` | `POST /api/lite-cut/export` → `compose_lite_cut_montage()` |

---

## 5. 模板系统（PR 式，后续 M2）

PR 模板 ≈ **预置时间轴 + 可替换槽位 + 锁定样式**。不导入 `.prproj`，用 **manifest + assets** 实现。

### 5.1 模板包结构

```
templates/esports_beat_60/
├── manifest.json
├── preview.jpg
└── assets/
    ├── intro.webm
    ├── lower_third.webm
    ├── bgm.mp3
    └── fonts/
```

### 5.2 manifest 要点

- `slots[]`：轨道、时长预算、填充规则（`category: highlight`, `min_ai_score`, `sort: rhythm`）
- `overlays[]`：锁定花字/WebM，占位符 `{{player_name}}`
- `transition_between_slots`：默认转场
- `locked` / `editable`：控制 UI 暴露项

### 5.3 用户流程

```
模板画廊 → 使用模板 → 实例化项目（空槽/自动填槽）→ 编辑 → 导出
```

### 5.4 分期

| 阶段 | 内容 |
|------|------|
| M1 | 模板 = 转场+滤镜+BGM+排序预设（升级现有 esports/film 等） |
| M2 | 槽位模板 + 画廊 + 自动填槽 |
| M3 | 用户另存为模板 + zip 导入 |

### 5.5 与「风格预设库」的区别

| | 项目草稿 | PR 模板 | **风格预设库** |
|---|----------|---------|----------------|
| 绑定具体片段 ID | ✅ 是 | ❌ 槽位占位 | ❌ **只存样式/规则** |
| 含时间轴结构 | ✅ 完整 | ✅ 槽位结构 | ⚠️ 可选（包装方案含 overlay 节奏） |
| 典型用途 | 继续编昨天的片 | 从空白结构开新片 | **昨天那套字/调色/转场，套到今天新录制上** |
| 素材换了还能用 | ❌ 片段路径/ID 失效 | ✅ 自动填新素材 | ✅ **专门为此设计** |

---

## 6. 风格预设库（历史配置复用）

> 用户诉求：「昨天调好的那批文字、调色、转场节奏，今天换了新录制素材，还想一键套用。」

### 6.1 概念

**风格预设（Style Preset）** = 从当前编辑器状态中抽出的、**不依赖具体 `recorded_clip_id`** 的可复用配置快照。

- 保存的是：**参数 + 资产引用 + 相对时间规则 + 占位符**
- 不保存：昨天那些 clip 的 ID、具体 demo 路径、成片时间轴绝对位置（除非用户显式存「包装方案」）

### 6.2 预设类型（v1 至少支持）

| 类型 `kind` | 保存内容 | 应用到新素材时 |
|-------------|----------|----------------|
| `text_style` | 花字预设 id、字体、字号、颜色、动画、相对位置 | 在选中片段/整片创建 overlay，文字可含 `{{player_name}}` |
| `color_grade` | 滤镜 preset、亮度/对比度/饱和度 | 写入选中视频 clip 或全局默认 |
| `transition_rhythm` | 片段间转场类型 + 默认时长 + 可选「每 N 段闪白」规则 | 按当前时间轴顺序重算 `transition_out` |
| `audio_mix` | BGM 路径、音量、起止偏移、淡入淡出 | 写入 A1（路径缺失则提示重新选文件） |
| `overlay_recipe` | 多条 overlay：类型、样式、**相对锚点**（见下） | 按新时间轴重新铺 overlay |
| `packaging_bundle` | 上述多项 + 片头片尾 + 名牌样式 | **一键包装**：新片先排序，再套全套 |

**相对锚点（重要）**：overlay 不存「绝对 26.0s」，而存：

- `anchor: "timeline_start" | "clip_start" | "clip_end" | "each_clip_start"`
- `offset_sec: number`
- `duration_sec: number | "clip_length"`

这样同一套「每个高光开头弹 ACE 字」可以套在不同数量的片段上。

### 6.3 用户流程

**保存（昨天）：**

```
调好文字/调色/转场 → 检查器或顶栏「保存为我的配置」
  → 命名（如「Dream 电竞包装 v3」）→ 选类型（单项或组合 bundle）
  → 写入 lite_cut_presets
```

**应用（今天）：**

```
新媒体库选片 → 拖入时间轴（或智能排序）
  → 打开「我的配置」→ 选「Dream 电竞包装 v3」→ 应用范围：
       · 整个项目
       · 仅选中片段
       · 仅文字/仅调色/…（组合预设可勾选子项）
  → 预览确认 → 可再微调 → 导出
```

**从旧项目提取：**

```
打开昨天项目草稿 → 「将本项目样式保存为预设」（不包含视频片段，只抽样式）
```

### 6.4 数据模型

```typescript
interface LiteCutPreset {
  id: number;
  name: string;
  kind: "text_style" | "color_grade" | "transition_rhythm" | "audio_mix" | "overlay_recipe" | "packaging_bundle";
  tags?: string[];               // 如 "电竞", "Dream"
  thumbnail_path?: string;       // 可选预览图
  body_json: PresetBody;         // 见下
  source_project_id?: number;    // 溯源：从哪个项目另存
  last_applied_at?: string;
  created_at: string;
  updated_at: string;
}

// 组合预设
interface PackagingBundleBody {
  text_styles?: TextStylePresetBody[];
  color_grade?: ColorGradePresetBody;
  transition_rhythm?: TransitionRhythmPresetBody;
  audio_mix?: AudioMixPresetBody;
  overlay_recipe?: OverlayRecipePresetBody;
  name_card?: NameCardPresetBody;
  intro_outro?: { intro_path?: string; outro_path?: string; intro_duration?: number; outro_duration?: number };
}

interface OverlayRecipePresetBody {
  layers: Array<{
    type: "text" | "webm" | "sticker" | "name_card";
    anchor: "timeline_start" | "clip_start" | "clip_end" | "each_clip_start";
    offset_sec: number;
    duration_sec: number | "clip_length";
    text_style_ref?: TextStylePresetBody;  // 嵌套或引用 preset id
    asset_path?: string;
    placeholders?: string[];               // ["player_name", "map"]
  }>;
}
```

**资产路径策略：**

- 预设内 `font_file`、`bgm_path`、`webm_path` 存**绝对路径**；应用时若文件不存在 → UI 标黄「需重新指定」，不静默失败。
- 用户上传字体/WebM 若已在 `lite_cut_assets` 表，预设存 `asset_id` 更稳（见 API）。

### 6.5 UI 入口（样稿后续补）

| 入口 | 行为 |
|------|------|
| 各检查器底部 | 「保存当前文字/调色/… 为预设」 |
| 顶栏或媒体库 Tab | **「我的配置」** 列表：搜索、标签、最近使用、收藏 |
| 时间轴右键 | 「将选中片段样式存为预设」 |
| 新建项目向导 | 「从预设开始」与「从模板开始」并列 |

### 6.6 API（新增）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/lite-cut/presets?kind=&tag=` | 列表 |
| POST | `/api/lite-cut/presets` | 从 body 创建 |
| POST | `/api/lite-cut/presets/from-project` | 从 `project_id` 抽取样式 |
| GET | `/api/lite-cut/presets/{id}` | 详情 |
| PATCH | `/api/lite-cut/presets/{id}` | 重命名/标签 |
| DELETE | `/api/lite-cut/presets/{id}` | 删除 |
| POST | `/api/lite-cut/presets/{id}/apply` | `{ project_id?, clip_ids?, scope: "project"|"selection", include?: string[] }` |

**apply 逻辑（后端或共享 TS 库）：**

1. 读取目标项目时间轴（或临时新建空项目 + 传入 clip 列表）
2. 按 preset kind 合并 `body_json` 到 project tracks/overlays/audio
3. `each_clip_start` 类 overlay 对每个主轨 clip 实例化一层
4. 占位符从 clip `meta.player_name` / `map` 替换
5. 返回更新后 project body（前端写入 store）

### 6.7 存储

SQLite 表 `lite_cut_presets`（可放在 `montage_db.py` 同库）：

```sql
CREATE TABLE lite_cut_presets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  tags_json    TEXT,
  body_json    TEXT NOT NULL,
  thumb_path   TEXT,
  source_project_id INTEGER,
  last_applied_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### 6.8 v1 范围

- **Must**：保存/列表/删除；`text_style`、`color_grade`、`transition_rhythm`、`packaging_bundle` 四类；apply 到整个项目或选中 clip
- **Should**：从旧项目抽取；`overlay_recipe` + `each_clip_start`；最近使用排序
- **v1.1**：预设导入导出（json zip）；预设内资产一并打包

### 6.9 验收补充

7. 保存「电竞文字+调色+转场」组合预设后，新建项目仅拖入新 recorded_clips，一键应用后 overlay/转场/调色与保存时一致（文字占位符随新 clip 玩家名变化）。
8. BGM 路径失效时应用预设，UI 明确提示重新选择文件。

---

## 7. 后端与 API 规划

### 7.1 已有可复用（只读 / 稳定层）

- `GET/POST /api/recorded-clips` — 媒体库共用
- `GET /api/config/ffmpeg-check` — 导出门控
- `video_composer.py` 内名牌、BGM 混音、xfade 等 **实现片段**（v2 新函数复用，不直接改 v1 入口）
- **阶段 A 仍运行、不改动**：`POST /api/montage/projects`、`POST /api/montage/export` → `compose_montage`

### 7.2 需新增（LiteCut 专用 `/api/lite-cut/*`）

| API | 用途 |
|-----|------|
| `GET/POST/PATCH/DELETE /api/lite-cut/projects` | v2 项目 CRUD |
| `POST /api/lite-cut/export` | 多轨 timeline JSON → filter_complex（`compose_lite_cut_montage`） |
| `GET /api/recorded-clips/{id}/stream` | Range 请求，预览 `<video>` seek |
| `POST /api/lite-cut/assets/upload` | 字体、WebM、贴纸、自定义转场 |
| `GET/POST/PATCH/DELETE /api/lite-cut/presets` | **风格预设库 CRUD** |
| `POST /api/lite-cut/presets/from-project` | 从项目抽取样式 |
| `POST /api/lite-cut/presets/{id}/apply` | **应用到项目/选中项** |
| `GET /api/lite-cut/templates` | 模板列表 |
| `POST /api/lite-cut/projects/from-template` | 实例化 |
| 导出 SSE/WebSocket 进度 | 长任务进度与取消 |

### 7.3 FFmpeg 合成扩展

- 每 clip：`trim`（`-ss/-t`）、`setpts`（变速）、`eq`（调色）
- 多轨：`overlay` 链（含 alpha WebM）
- 文字：drawtext（字体路径）或预渲染 PNG 序列
- 转场：xfade；自定义转场需映射表或遮罩视频
- 音频：`amix`、atempo（变速保调）

### 7.4 前端状态（目标）

```
stores/liteCut/
  projectStore.ts      // 草稿、导出设置
  timelineStore.ts     // tracks, clips, selection, playhead
  playbackStore.ts     // 播放状态
  assetsStore.ts       // 媒体库、叠加素材
  presetStore.ts       // 风格预设库、最近使用、apply
  historyStore.ts      // undo/redo
```

样稿阶段尚未拆分 store，逻辑在 `LiteCutEditorShell.jsx` 本地 state。

---

## 8. 实施路线图

### Phase 0 — 地基

- [x] `liteCutEditorStore` 从 shell 迁出
- [x] `GET /recorded-clips/{id}/stream`
- [x] Project schema v2 + `empty_project()` 工厂
- [x] `lite_cut_presets` 表 + preset apply 纯函数（单测 `test_lite_cut_preset_apply.py`）
- [x] 新后端路由挂载 `/api/lite-cut/*`（与 `/api/montage/*` 并存）
- [x] **不删除** 旧 `MontageWorkbenchDrawer` / `/montage`（切换前保留）

### Phase 1 — LiteCut MVP（仍走 `/lite-cut` 入口）

- [ ] 真实数据驱动时间轴（5 轨 + overlay + 音频）
- [ ] trim / 分割 / 撤销重做
- [ ] 整片预览（stream + 近似合成）
- [ ] 属性面板接 store
- [ ] 导出 v2 body + composer 扩展
- [ ] **预设：保存/应用 text + color + transition（最小闭环）**

### Phase 2 — 资产与模板

- [ ] 叠加素材上传 API + 拖放落轨
- [ ] 字体上传与导出一致
- [ ] 模板 M1/M2
- [ ] **packaging_bundle + overlay_recipe + 从项目抽取预设**
- [ ] 导出进度

### Phase 3 — Polish

- [ ] 缩略图条、BGM 波形
- [ ] 键盘快捷键
- [ ] CS2 tick 刻度 overlay
- [ ] 用户另存为模板
- [ ] 预设导入导出 zip

### Phase 4 — Cutover（验证通过后）

- [ ] 完成 §11 验收 + 内测清单
- [ ] 侧边栏「合集工作台」改指向 LiteCut；移除或隐藏独立「LiteCut」试验菜单
- [ ] 旧 `/montage` 重定向或 410；旧 API Deprecation 说明
- [ ] 清理 `MontageWorkbenchDrawer` 等遗留 UI（可选保留导出历史只读页）
- [ ] 更新 README / 引导文案

---

## 9. 样稿实现清单（当前已完成）

| 模块 | 文件 | 状态 |
|------|------|------|
| 编辑器壳 | `LiteCutEditorShell.jsx` | Mock |
| 顶栏 | `LiteCutToolbar.jsx` | Mock |
| 媒体库双 Tab | `LiteCutMediaBin.jsx` | Mock |
| 预览 + 播放条 | `LiteCutPreviewPanel.jsx` | Mock |
| 属性面板 | `LiteCutPropertyPanel.jsx` | Mock |
| 时间轴 + 轨道工具 | `LiteCutTimelinePanel.jsx` | Mock |
| 上传拖放区 | `UploadDropZone.jsx` | Mock（仅 UI） |
| 演示数据 | `mockData.js` | Static |
| 路由 | `App.jsx` `/lite-cut/*` | 已挂载 |
| 侧边栏入口 | `SidebarNav.jsx` LiteCut | 已挂载 |

**未接后端：** 预览无真实视频流、导出无 API、上传无持久化、时间轴变更不保存。

---

## 10. 风险与约束

1. **5 轨 + 整片预览性能**：1080p60 多路解码压力大；预览允许降质/单路解码策略。
2. **文字动画导出**：预览可 rich，导出 v1 需定义「可导出动画子集」并 bake。
3. **字体一致**：预览 @font-face 与 FFmpeg drawtext 字体需同源。
4. **透明 WebM**：预览靠浏览器 alpha；导出需 VP9/yuva420p 或转 PNG 序列。
5. **Windows 主场景**：FFmpeg 导出以 Windows 为主；macOS 可 dev 预览与 UI。

---

## 11. 验收标准（v1 整体验收）

1. 从媒体库拖 3 段录制到 V1–V3，V5 加透明 WebM，Overlay 加带动画标题，可整片连续预览。
2. 片段调色 + 滤镜，预览有变化，导出真实生效。
3. 5 视频轨独立叠层正确。
4. 上传字体 / WebM 可进项目并出现在导出（允许与预览细节略有差异）。
5. 项目保存再打开，轨道/文字/效果完整恢复。
6. 导出 MP4 至指定目录；历史可查阅。
7. 保存组合预设后，对新 recorded_clips 一键应用，文字/转场/调色一致，玩家名等占位符随新素材更新。
8. 预设中 BGM/字体文件缺失时，应用后 UI 明确提示重新指定路径。

---

## 12. 参考

- 交互参考：Clipchamp（布局、属性轨、文字样式卡片、滤镜网格）
- 不采用：OpenCut 源码 fork（域不同；OpenCut 正 Rust 重写）
- 项目内现有：`video_composer.py`（v1 保留至 Cutover）、`montage_db.py`、`MontageWorkbenchDrawer.jsx`（阶段 A 保留，Phase 4 下线）

---

*本文档随样稿迭代更新；实现阶段以 schema v2 与 API 契约为准。*
