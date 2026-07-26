# 2D 回放缺口补齐设计

> 日期：2026-07-25  
> 分支策略：从 `develop` 拉出 feature 分支一次性交付  
> 范围：只补齐相对已有实现的缺口，不重做已正确部分  
> 来源：`CS2_2D回放一次性完整修复方案.md`（用户确认方案 A）  
> 注：`docs/superpowers/` 被 gitignore；本文件为可提交的权威副本（路径 `docs/design/`）。

> 2026-07-26 更正：当时认为体素轴内核已正确的结论已被真实 journal
> 的 mask 数据推翻；当前协议为 XYZ、无镜像、12u、中心 15.5。详见
> `docs/replay-effects-validation/probe-output/smoke-geometry-r1r2-conclusion.md`。

---

## 1. 目标与非目标

### 目标（验收对齐原方案）

1. 烟雾：稳定 lifecycle + `stable_origin`；跨地图同一体素规则（已有，保持）
2. 烟火：density/fire mask + utility clip（柔化后再裁）；允许雷达衍生 mask 的误差
3. 地图：`content_rect` 统一 Fit；无地图名特殊 CSS 缩放
4. Camera：整场景滚轮/按钮缩放与平移
5. C4：dropped vs planted 视觉区分 + 时间轴下包标记
6. 播放：以绝对时间/`time_sec`（或 tick）为源；删除重复 frame-index 插值路径
7. 缓存：已有 `replayStore` / 磁盘缓存 / single-flight 保持；lifecycle 变更 bump cache version

### 非目标

- 不重做全局体素轴、density contour 主路径、CInferno 原始蔓延数据
- 不提高后端采样率（保持 8Hz）
- 不做 navmesh 级精确碰撞；utility mask 允许误差
- 不为单图加烟雾轴/偏移补丁

---

## 2. 现状（已落地，本轮不动逻辑内核）

| 能力 | 状态 |
|------|------|
| 全局体素坐标 / XYZ packing / Morton mask | 已于 2026-07-26 更正 |
| 烟雾 density + marching squares + sample crossfade | 完成 |
| `replayRadarTransform.js` | 完成（支持 content_*，元数据未填） |
| `replayStore` + frames/effects 磁盘缓存 + single-flight | 完成 |
| 60FPS scene / 8–15Hz HUD 分离 | 完成 |
| `computeBombState` 状态机 | 完成（视觉未区分） |
| `replayPlayback.js` 时钟与插值 | 完成（调用方仍有重复路径） |

---

## 3. 架构

```text
Demo 实体
  → smoke lifecycle id + stable_origin → effect_tracks
  → 前端 density / fire mask
  → utility clip mask（destination-in，柔化后再 clip）
  → canonical 1024 scene + content_rect Fit
  → Camera（fitScale × userZoom + pan）作用于 replay-scene
  → 60FPS 场景层 + 低频 React HUD
```

DOM：

```text
replay-viewport
  └── replay-scene    ← 唯一场景变换目标
  └── ReplayCameraControls
```

---

## 4. 烟雾 lifecycle 与 stable_origin

### 规则

- 每个 lifecycle 的第一份有效 `m_vSmokeDetonationPos` → `stable_origin`
- 该 lifecycle 内所有体素解码：`world = stable_origin + local_offset`
- 后续 origin 与 stable 距离 > 1 cell：仅 warning，不平移
- track id：`smoke:{round}:{entity_id}:{effect_start_tick}`（round 不可得时用 `0`）
- track 顶层携带 `stable_origin`；开发调试 UI 画该点，不画逐样本漂移 origin
- 禁止 `map_name` 分支改轴/符号/偏移
- bump `SMOKE_DECODER_VERSION` 或 effects cache version，使旧磁盘缓存失效

### 测试

- 同 entity 两段 lifecycle → 不同 id，各自 stable_origin
- 中段伪造漂移 origin → cells 仍锚定首份 origin
- Inferno / Anubis / Nuke 固定样本仍用同一全局轴配置通过

---

## 5. Utility clip 与火焰 mask

### Mask 资产

- 与 radar 同目录命名：`{map}_utility_mask.png` / `{map}_lower_utility_mask.png`
- 生成脚本：雷达 PNG 亮度阈值 → 白可显示 / 黑不可；最外圈强制黑
- 核心图入库：Inferno、Anubis、Nuke upper+lower、Mirage；其余缺文件时跳过 clip（不崩溃）
- 允许与真墙有误差；后续可替换资产而不改渲染 API

### 渲染

1. 烟雾：沿用 contour；可略收紧 dilate
2. 火焰：fire occupancy/density mask（废除大圆 bloom 作为最终几何；闪烁只改色/alpha）
3. 离屏绘制 → `globalCompositeOperation = "destination-in"` 叠 clip mask → 输出
4. 柔化/blur 后必须再 clip 一次

### 测试

- fixture mask 下墙外/图外像素为 0
- 火焰边界不再由 `INFERNO_CELL_RADIUS_WORLD` 大圆决定

---

## 6. content_rect 与地图 Fit

- `map-data.json` / API transform 增加 `content_x|y|width|height` 与 `transform_version`
- 缺省回退整图 1024×1024
- Fit：`min(viewport/content)`，content 中心对齐视口；目标有效内容约占 85%–90%
- 上下层共用同一 Camera / Fit
- 禁止地图名特殊 CSS scale
- 叠加层统一 `replayRadarTransform`；删除无语义的重复 `worldToPercent` 包装

---

## 7. Camera

```js
{
  fitScale: number,
  userZoom: number, // 0.6–3.0
  offsetX: number,
  offsetY: number
}
// finalScale = fitScale * userZoom → CSS transform on replay-scene
```

- 控件：左上角 `−` / 百分比 / `+` / `适应`；按钮步进 ×1.15
- 滚轮：指针中心缩放（缩放前后保持光标下 scene 点）
- 平移：中键，或 Space+左键（仅 `userZoom > 1`）；限制不完全拖出视口
- 双击或「适应」→ 重置 Fit
- 同图切回合 / 上下层：保留 camera；换地图：重置；可按 map key 存入 `replayStore`

---

## 8. C4 与时间轴

| 状态 | 表现 |
|------|------|
| carried | 现有持有逻辑（不在地图画包，或保持现状） |
| dropped | 较小静态暗金图标，无呼吸 |
| planted | 橙红图标 + 双环外扩（周期 ~1.2s，错开 600ms） |
| defused / exploded | 立即移除 planted 动画 |

- 时间轴 `eventMarkers` 增加 `plant`（可选 defuse/explode）
- 橙红标记；tooltip：玩家、包点、时间；点击 seek 到该 tick
- 图例增加「下包」

---

## 9. 播放时钟收尾

- 唯一插值入口：`frontend/src/utils/replayPlayback.js`
- 删除 `Demo2DReplayPreview` / `ReplaySceneCanvas` 内重复的 frame-index 插值实现
- Scrubber 可显示帧索引，但 seek 语义为秒或 tick，再映射 UI
- 禁止 per-segment smoothstep；位置线性、yaw 最短角
- 烟火保持相邻样本交叉淡入
- 不提高后端 Hz；不在每个 rAF 全量重渲染 React HUD

---

## 10. 主要改动文件

**后端**

- `backend/app/parser/replay_effects.py` — stable_origin、lifecycle id
- `backend/app/parser/smoke_voxel_decode.py` — 仅在需要时暴露/确认 decoder version bump
- `backend/app/parser/replay_effects_cache.py` — version bump
- `backend/assets/bundled_radar_maps/map-data.json` — content_* / transform_version
- `backend/assets/bundled_radar_maps/*_utility_mask.png` — 衍生 mask
- `backend/scripts/generate_utility_masks.py` — 新脚本

**前端**

- `frontend/src/components/analysis/ReplayAreaEffectsCanvas.jsx` — fire mask + clip
- `frontend/src/components/analysis/ReplaySceneCanvas.jsx` — scene 根、C4 视觉、去重插值
- `frontend/src/components/analysis/Demo2DReplayPreview.jsx` — camera 挂载、plant 标记、时钟统一
- `frontend/src/components/analysis/ReplayCameraControls.jsx` — 新
- `frontend/src/components/analysis/ReplayBombMarker.jsx` — 新（或内联组件）
- `frontend/src/utils/replayRadarTransform.js` — Fit helpers（若需要）
- `frontend/src/stores/replayStore.js` — 按 map 存 camera（可选但推荐）

**测试**

- 后端：lifecycle / stable_origin
- 前端：clip、camera 数学、C4/plant、playback 去重路径、content_rect Fit

---

## 11. 交付与验收

一次性 PR，对照原方案 §14，重点验证：

- 烟雾中心稳定、无地图名补丁
- 烟火不越墙/不出图（允许 mask 近似误差）
- 各图默认占比接近；Nuke 无特殊缩放
- Camera 整场景缩放可用
- C4 dropped/planted 可辨；下包可跳转
- 8Hz 数据 60FPS 平滑；切 Tab 不重复解析（已有能力回归）

禁止项同原方案 §15。

---

## 12. 明确决策记录

| 决策 | 选择 |
|------|------|
| 范围 | 只补缺口（用户选 A） |
| utility mask | 雷达亮度衍生 + 允许误差 |
| 精确 navmesh | 不做 |
| 交付方式 | 同一 feature 分支一次合并，不分阶段发版 |
| 已完成模块 | 不重写，仅回归 |
