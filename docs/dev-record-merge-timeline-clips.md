# 开发记录：回合时间线「按阈值合并击杀/死亡镜头」

- **日期**：2026-08-16
- **分支**：`develop`（建议工作分支 `feat/timeline-merge-clips`）
- **模块**：前端（Demo 分析「回合时间线」→ 录制队列）+ 后端（事件片段 planner）
- **涉及文件**
  - `frontend/src/stores/recordingQueueStore.js`（新增开关状态）
  - `frontend/src/utils/recordingBatch.js`（提交时合并逻辑）
  - `frontend/src/features/demo-analysis/workspaces/timeline/RoundTimelineView.jsx`（开关 UI）
  - `frontend/src/i18n/dict/locales/{zh,en}/analysis.js`（文案）
  - `frontend/src/utils/timelineQueue.test.js`（前端测试）
  - `backend/app/recording/planners/event_clip_planner.py`（timeline_kill/death 支持多事件）
  - `backend/tests/test_timeline_merge_planner.py`（后端测试，新增）

---

## 1. 背景与问题

Demo 解析后，用户在「3.回合时间线」页签选择击杀/死亡镜头加入录制队列时，**每个镜头单独录一段素材**。
当出现**连杀**或**击杀后迅速死亡**时，这些时间上紧邻的镜头录出的素材大部分是重复内容。

## 2. 需求（修订后）

在「回合时间线」标题右侧新增开关 **「按阈值合并击杀\死亡镜头」**：

- **任何入队方式**（「只录击杀」批量、「只录死亡」批量、**逐条点击**）都要在**录制时**判断是否合并；
- **回合列表内容不变**，合并发生在**录制提交时**（静默）；
- **队列中的镜头类型依然保持为「时间线」**（`timeline_kill`/`timeline_death`），**不是**「合集」（`kill_compilation`/`death_compilation`）；
- 合并阈值使用**击杀合集阈值**（设置界面可调整，默认 **12s**，即 `max_gap_sec` / `kill_jump_cut_threshold_sec`）。

## 3. 方案设计

### 3.1 合并时机

把合并放到**录制提交**的统一入口 `buildRecordingQueueRequestsFromQueue`（
`useRecordingSessionController` 提交队列时唯一调用）。这样无论镜头通过何种方式入队
（批量或逐条），提交时都会把「同一 demo + 目标玩家 + 地图、同一 round、tick 间隔 ≤ 阈值」
的相邻时间线请求合并为**单条时间线请求**。

- **回合列表不变**：不修改 `roundTimeline`；
- **静默合并**：队列抽屉里仍显示各自独立的「时间线」片段，仅在录制时合并；
- **镜头类型保持时间线**：合并后的请求仍是 `request_type: "timeline_kill"` / `"timeline_death"`。

### 3.2 状态存储

在 `recordingQueueStore`（zustand）中新增会话级开关：

```js
mergeTimelineClipsEnabled: false,   // 默认关闭
setMergeTimelineClips(enabled)      // 切换
```

`RoundTimelineView`（渲染开关）与 `recordingBatch.js`（提交时读 `getState()`）都从同一
store 读取，避免跨 App 传参耦合。开关默认关闭。

### 3.3 前端合并算法（`mergeTimelineRequestsForRecording`）

在 `recordingBatch.js` 中：

1. 从 requests 中挑出 `timeline_kill` / `timeline_death`，其余请求原样保留；
2. 按 `demo_filename + target_player + map_name` 归组，再按 `(round, tick)` 升序；
3. 相邻请求**同一 round** 且 tick 间隔 ≤ 阈值（默认 12s）时并入同一组；
4. 每组合成一条请求：
   - 组内含击杀 → 以 `timeline_kill` 为基座，聚合所有事件（含击杀后紧跟的死亡事件），
     后端把聚合 tick 聚为一段连续素材（击杀→迅速死亡连贯录制）；
   - 组内仅死亡 → 以 `timeline_death` 为基座聚合；
   - 事件的 `source_ref.queue_item_id` 保留组内首条的 id，`merged_timeline_event_ids`
     记录被合并的所有时间线事件 id。

### 3.4 后端 `_plan_timeline_kill` / `_plan_timeline_death`

原实现仅使用 `req.events[0]` 生成单段。本次改为：对 `req.events` 按
`kill_jump_cut_threshold_sec`（= max_gap_sec，默认 12s）聚簇，每簇生成**一段连续素材**
（`[first.tick - pre, last.tick + post]`，`anchor_ticks` 聚合簇内所有 tick）。单事件时行为不变。

### 3.5 UI 开关位置

`RoundTimelineView` 顶部始终渲染一行「回合时间线」标题 + 开关。由于 DemoAnalysisPage
对该视图传 `suppressSummaryHeader`，原先的标题被隐藏；本次让「回合时间线」标题与开关
**始终显示**（只有右侧计数仍受 `suppressSummaryHeader` 控制），满足「回合列表顶部
『回合时间线』标题右侧新增开关」。

## 4. 测试

- **前端** `frontend/src/utils/timelineQueue.test.js`（7 项）：空输入；单事件保持时间线类型；
  阈值内相邻击杀合并为单条 timeline_kill；超出阈值拆分；击杀→迅速死亡合并为一条
  timeline_kill（kill 主导，事件含 kill+death）；跨回合不合并；非时间线请求原样保留。
- **后端** `backend/tests/test_timeline_merge_planner.py`（5 项）：单事件单段；近击杀合并一段；
  远击杀拆分多段；击杀→迅速死亡合并一段；单死亡不变。

## 5. 验证与回归

- `pnpm run test` 通过（含 timelineQueue、recordingBatch、weaponKillCompilations 等）。
- `node scripts/check-i18n.mjs` 通过（新增 key 已同步 zh/en）。
- `npx vite build` 无编译错误。
- 后端 `pytest tests/test_demo_end_guard.py tests/test_pov_issue79.py tests/test_highlight_clutch_tags.py tests/test_timeline_merge_planner.py` 通过。

## 6. 范围说明 / 已知边界

- 合并作用于**录制提交**时，因此覆盖批量与逐条入队的所有路径；
- 合并后的**录制请求**是时间线类型；队列抽屉展示仍为各自独立的时间线片段（静默）；
- 合并请求的 `source_ref.queue_item_id` 指向组内首条，全部成功时整队列清空，不影响结果一致性；
- 开关默认关闭（功能为显式开启）。
