# OBS 转场设置持久化到全局配置 Design

## Goal

让 `RecordWarmupModal`（录制前预热弹窗）里的 OBS 转场设置，初始值来自全局配置（`AppConfig` / `CommonParamsModal`），而非硬编码常量。用户在「常用参数」里设置好的默认值，会反映到每次打开录制弹窗时的初始状态。

## Current Problem

`RecordWarmupModal` 有一个独立的 "OBS Transition" 区块，每次打开时强制从 `RECORD_WARMUP_DEFAULT_OBS_TRANSITION = { enabled: true, name: "Fade", durationMs: 200 }` 初始化，完全忽略用户在 `CommonParamsModal` 里保存的全局配置。

## Architecture

无后端变更。纯前端 2 文件修改。

### 数据流（修改后）

```
AppConfig JSON (obs_transition_enabled/name/duration_ms)
  → 启动时 load_config()
    → App.jsx state: obsTransitionEnabled / obsTransitionName / obsTransitionDurationMs
      ├── CommonParamsModal（读写，现有逻辑不变）
      └── RecordWarmupModal props: initObsTransEnabled / initObsTransName / initObsTransDurationMs  ← 新增
            → 用户可在 Modal 内临时调整（不写回 JSON）
              → onConfirm(warmup) → handleWarmupConfirm
                → dto.options.obs_transition_* → POST /api/recording/queue
                  → _resolve_fade_config（现有逻辑，用 options 覆盖 AppConfig）
```

### 默认值行为

- `AppConfig.obs_transition_enabled` 默认 `False`（现有，不变）
- 全新用户：RecordWarmupModal 打开 → checkbox 未选中（默认关闭）
- 用户在 CommonParamsModal 启用后：RecordWarmupModal 打开 → checkbox 已勾选
- 用户在 RecordWarmupModal 临时调整：仅影响本次录制，不写回 JSON

## File Changes

### `frontend/src/components/RecordWarmupModal.jsx`

1. 新增 3 个 props（带默认值）：
   ```javascript
   initObsTransEnabled = false,
   initObsTransName = "Fade",
   initObsTransDurationMs = 200,
   ```

2. 删除 `RECORD_WARMUP_DEFAULT_OBS_TRANSITION` 常量（或保留但不使用）。

3. `useEffect`（`open` 变化时）里，将：
   ```javascript
   setObsTransEnabled(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.enabled);
   setObsTransName(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.name);
   setObsTransDurationMs(RECORD_WARMUP_DEFAULT_OBS_TRANSITION.durationMs);
   ```
   改为：
   ```javascript
   setObsTransEnabled(!!initObsTransEnabled);
   setObsTransName(initObsTransName || "Fade");
   setObsTransDurationMs(Number(initObsTransDurationMs) || 200);
   ```

### `frontend/src/App.jsx`

给 `<RecordWarmupModal>` 添加 3 个 props：
```jsx
initObsTransEnabled={obsTransitionEnabled}
initObsTransName={obsTransitionName}
initObsTransDurationMs={obsTransitionDurationMs}
```

这 3 个值已存在于 App.jsx state（从 AppConfig 加载），直接传入即可。

## What Does NOT Change

- 后端 `_resolve_fade_config` — 不变
- `CommonParamsModal` OBS 转场区块 — 不变
- `buildDtoFromQueueItem.js` — 不变
- `AppConfig` 字段和默认值 — 不变
- RecordWarmupModal 的 UI 结构 — 不变（仍显示 checkbox + 样式选择 + 时长）

## Testing

1. 全新配置（未在 CommonParamsModal 设置过）：打开 RecordWarmupModal → OBS 转场 checkbox 未选中
2. 在 CommonParamsModal 启用转场并设置 Swipe 500ms → 关闭 → 重新打开 RecordWarmupModal → checkbox 已选中，样式为 Swipe，时长 500
3. 在 RecordWarmupModal 临时改为 Fade 200ms → 确认录制 → 再次打开 RecordWarmupModal → 恢复为 Swipe 500ms（全局值，未写回）
4. 后端接收到的 `obs_transition_*` 与 RecordWarmupModal 内的设置一致
