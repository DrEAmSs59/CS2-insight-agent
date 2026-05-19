# OBS 配置中心 — 诊断优先 UX 设计文档

**日期**: 2026-05-19  
**状态**: 待实施  
**关联**: 2026-05-19-obs-calibration-design.md（本文档是其 UX 迭代）

---

## 背景与目标

### 问题

当前"一键校准"按钮对老用户不友好：用户不知道自己有没有问题，"点还是不点"存在困惑。

### 目标

连上 OBS 后**先展示关键参数的当前值和健康状态**，有问题的标红，按钮改为"一键修复"且仅在有问题时高亮，全部正常时显示"配置正常"并禁用按钮。

---

## 诊断项定义（共 6 项）

| # | 检查项 | 数据来源 | ✅ 条件 | ⚠️ 提示文案 |
|---|--------|---------|---------|------------|
| 1 | 画布分辨率 | `video.base_width/height` vs `monitor.width/height` | 相等 | `应为 {monitor.width}×{monitor.height}（主显示器）` |
| 2 | CS2 Insight 场景 | `scene.dedicated_scene_exists` | true | `场景不存在，将自动创建` |
| 3 | Game Capture 源 | `scene.capture_source_exists` | true | `Game Capture 源不存在，将自动创建` |
| 4 | 画面拉伸 | `scene.source_fit_to_canvas` | true | `未填满画布，可能有黑边` |
| 5 | 录像格式 | `recording.format` | `"hybrid_mp4"` | `当前：{format}，应为混合 MP4` |
| 6 | 录像质量 | `recording.rec_quality` | `!= "Stream"` | `当前：与串流一致，录制质量可能降低` |

注：检查项 3 和 4 仅在场景存在时有意义；场景不存在时显示"—"（修复后会一并创建）。

---

## 变更范围

### 后端：`backend/app/obs_config_center.py` — `get_status_payload()`

**新增 `monitor` 顶层字段**（在 `base` 初始化时加入，始终返回）：

```python
from .env_utils import get_primary_monitor_resolution

monitor_w, monitor_h = get_primary_monitor_resolution()
base["monitor"] = {"width": monitor_w, "height": monitor_h}
```

**新增 `recording.rec_quality` 字段**（在读取 `simple` INI 之后）：

```python
base["recording"]["rec_quality"] = (simple.get("RecQuality") or "").strip()
```

`recording.format` 已通过 `simple.get("RecFormat2")` 返回，无需修改。

### 前端：`frontend/src/pages/ObsConfigCenterPage.jsx` — 校准区块

**一键校准 section 完整替换逻辑**：

```
OBS 未连接时：
  → 仅显示描述文案，按钮禁用 + title "请先连接 OBS WebSocket"

OBS 已连接时：
  → 渲染 6 行诊断列表（每行：检查项名称 + 当前值 + ✅/⚠️ 图标 + 说明）
  → 有任何 ⚠️：按钮显示"一键修复"，cs2-accent 高亮样式，可点击
  → 全部 ✅：按钮显示"配置正常，无需修复"，禁用样式（opacity-40）
```

**按钮禁用条件**：`batchRecording || calibrating || !status?.obs_connected || !hasIssues`

**`hasIssues` 计算**（在 JSX 渲染前）：

```js
const hasIssues = status?.obs_connected && (
  status.video.base_width !== status.monitor?.width ||
  status.video.base_height !== status.monitor?.height ||
  !status.scene.dedicated_scene_exists ||
  !status.scene.capture_source_exists ||
  !status.scene.source_fit_to_canvas ||
  status.recording.format !== "hybrid_mp4" ||
  status.recording.rec_quality === "Stream"
);
```

---

## API 响应变更

`GET /api/obs-config/status` 响应新增字段（已连接时完整，未连接时 monitor 始终有值，其余为默认零值）：

```json
{
  "monitor": { "width": 2560, "height": 1440 },
  "recording": {
    "use_stream_encoder": false,
    "encoder": "obs_nvenc_h264",
    "format": "hybrid_mp4",
    "output_path": "C:/Users/...",
    "rec_quality": "High"
  }
}
```

---

## 受影响文件

| 文件 | 操作 |
|------|------|
| `backend/app/obs_config_center.py` | `get_status_payload()` 新增 `monitor` 和 `recording.rec_quality` |
| `frontend/src/pages/ObsConfigCenterPage.jsx` | 校准区块替换为诊断列表 + 条件按钮 |
