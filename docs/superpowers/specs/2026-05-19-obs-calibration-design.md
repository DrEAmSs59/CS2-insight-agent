# OBS 一键校准功能设计文档

**日期**: 2026-05-19  
**状态**: 待实施  
**作者**: DrEAmSQ

---

## 背景与目标

### 问题

当前 OBS 预设功能目标是"让玩家能录到"，但实际存在以下未被解决的画面问题：

1. **画布分辨率错位** — OBS 视频设置中的基础（画布）分辨率与显示器不一致（如显示器 2560×1440，OBS 画布是 1920×960），导致 Game Capture 只显示在左上角一块
2. **Game Capture 未拉伸** — CS2 跑 4:3 分辨率时出现黑边，未填满画布
3. **场景未切到 CS2 Insight** — 场景不存在或未正确绑定，录制时降级为显示器采集，画面模糊

预设方案的盲区：写入 basic.ini 时不知道用户显示器分辨率，无法修正画布。

### 目标

- 用**一键校准**替代预设，通过运行时检测修正所有画面问题
- 仅操作 `CS2 Insight Recording` 场景，不影响用户其他场景
- 保留编码质量设置（码率/编码器/输出路径）和备份还原功能

---

## 移除范围

以下内容随预设功能一并移除：

| 移除内容 | 位置 |
|---------|------|
| "推荐录制预设" UI 区块 | `ObsConfigCenterPage.jsx` |
| `POST /api/obs-config/apply-recommended` 端点 | `main.py` |
| `POST /api/obs-config/import-preset` 端点 | `main.py` |
| `GET /api/obs-config/export-preset` 端点 | `main.py` |
| `POST /api/obs-config/import-native` 端点 | `main.py` |
| `apply_recommended()` 函数 | `obs_config_center.py` |
| `import_cs2obs_bytes()` 函数 | `obs_config_center.py` |
| `export_cs2obs_dict()` 函数 | `obs_config_center.py` |
| `import_native_files()` 函数 | `obs_config_center.py` |
| `_apply_scale_inner_transform()` 内部方法 | `obs_config_center.py` |
| `data/basic.ini` 预设模板文件 | `backend/app/data/` |
| 前端 `applyRecommendedObsPreset()` | `obsConfigCenter.js` |
| 前端 `importNativeObsConfig()` | `obsConfigCenter.js` |

保留：备份管理相关所有端点和函数、`diagnose()`、`get_status_payload()`。

---

## 新增功能：一键校准

### 触发方式

OBS Config Center 页面顶部新增"一键校准"按钮，替代原"一键应用推荐预设"按钮位置。点击后直接执行，无需确认弹窗（操作可逆，失败不损坏用户配置）。

**前提条件**：OBS WebSocket 必须已连接，否则按钮禁用并展示提示文案。

### 校准逻辑（顺序执行）

```
Step 1: 读取主显示器分辨率
    → ctypes.windll.user32.GetSystemMetrics(0/1)
    → 得到 monitor_w × monitor_h

Step 2: 读取 OBS 当前视频设置
    → obs_client.get_video_settings()
    → 得到 canvas_w × canvas_h, output_w × output_h

Step 3: 校准 OBS 视频设置
    IF canvas_w != monitor_w OR canvas_h != monitor_h:
        → obs_client.set_video_settings(
              base_width=monitor_w, base_height=monitor_h,
              output_width=monitor_w, output_height=monitor_h
           )
        → 记录变更："已将画布分辨率从 {旧} 修正为 {新}"

Step 4: 确保 CS2 Insight 场景存在
    scene_name = env CS2_INSIGHT_OBS_SCENE_NAME（默认 "CS2 Insight Recording"）
    IF scene_name NOT in get_scene_names():
        → obs_client.create_scene(scene_name)
        → 记录变更："已创建场景 CS2 Insight Recording"

Step 5: 确保场景内 Game Capture 源存在
    capture_name = env CS2_INSIGHT_OBS_GAME_CAPTURE_NAME
    IF NOT scene_has_source(scene_name, capture_name):
        → obs_client.ensure_game_capture_in_scene(
              scene_name, capture_name,
              input_settings={"capture_mode": "window", "window": "cs2.exe"}
           )
        → 记录变更："已创建 Game Capture 源"

Step 6: 设置 Game Capture 拉伸填满画布
    item_id = get_scene_item_id(scene_name, capture_name)
    → obs_client.set_scene_item_transform(scene_name, item_id, {
          "positionX": 0, "positionY": 0,
          "boundsType": "OBS_BOUNDS_STRETCH",
          "boundsWidth": monitor_w,
          "boundsHeight": monitor_h
      })
    （boundsType=OBS_BOUNDS_STRETCH 让 OBS 自动将源拉伸填满指定 bounds，
      无需手动计算 scaleX/scaleY）
    → 记录变更（若 transform 有变化）

Step 7: 校准 OBS 输出设置（Simple Output 模式）
    → obs_client.get_profile_parameter("SimpleOutput", "RecQuality")
    IF RecQuality == "Stream"（与串流一致）:
        → obs_client.set_profile_parameter("SimpleOutput", "RecQuality", "High")
        → 记录变更："录像质量已从「与串流一致」改为「高质量，中等文件大小」"

    → obs_client.get_profile_parameter("SimpleOutput", "RecFormat2")
    IF RecFormat2 != "hybrid_mp4":
        → obs_client.set_profile_parameter("SimpleOutput", "RecFormat2", "hybrid_mp4")
        → 记录变更："录像格式已改为「混合 MP4」"

    注意：SetProfileParameter 写入 profile INI 后，OBS 需要在下次录制时才会生效，
    无需重启 OBS，但如果 OBS 正在录制时调用则跳过此步骤并提示用户。

Step 8: 返回结果
    → { changed: [...变更列表], already_ok: [...无需修改的项], success: true }
```

### 技术实现

#### 新增后端代码

**`backend/app/recording/obs_client.py`** — 还需新增两个方法（除 `set_video_settings` 外）：

```python
def get_profile_parameter(self, category: str, parameter_name: str) -> str:
    """调用 obs_requests.GetProfileParameter()，返回参数值字符串"""

def set_profile_parameter(self, category: str, parameter_name: str, parameter_value: str):
    """调用 obs_requests.SetProfileParameter()，写入 profile INI"""
```

**`backend/app/obs_config_center.py`** — 新增函数：

```python
async def calibrate(obs_cfg) -> dict:
    """
    运行时校准：读显示器分辨率 → 修正 OBS 画布 → 建场景 → 建 Game Capture → 设拉伸。
    只操作 CS2 Insight 专用场景，不动用户其他场景。
    返回 {"success": bool, "changed": [...], "already_ok": [...], "error": str|None}
    """
```

**`backend/app/recording/obs_client.py`** — 新增方法：

```python
def set_video_settings(self, base_width, base_height, output_width, output_height, fps_num=60, fps_den=1):
    """调用 obs_requests.SetVideoSettings()"""
```

**`backend/app/env_utils.py`** — 新增工具函数：

```python
def get_primary_monitor_resolution() -> tuple[int, int]:
    """
    Windows: ctypes.windll.user32.GetSystemMetrics(0/1)
    非 Windows: 返回 (1920, 1080) 作为 fallback（非 Windows 不支持录制，仅开发用）
    """
```

#### 新增 API 端点

```
POST /api/obs-config/calibrate
```

请求体：无（读取现有 obs 配置）  
响应：
```json
{
  "success": true,
  "changed": ["已将画布分辨率从 1920×960 修正为 2560×1440", "已创建场景 CS2 Insight Recording"],
  "already_ok": ["Game Capture 源已存在且配置正确"]
}
```

错误情况：
- OBS 未连接 → 400 + "请先连接 OBS WebSocket"
- OBS 正在录制 → 400 + "录制进行中，无法修改视频设置"
- Windows API 失败 → 500 + 详细错误

#### 前端变更

**`ObsConfigCenterPage.jsx`** — 页面重组为三个区块：

1. **OBS WebSocket 连接**（保留现有 UI）
2. **一键校准**（新）
   - 按钮：「校准 OBS 配置」，OBS 未连接时禁用
   - 结果展示：变更列表（绿色）+ 已正常项（灰色），成功/失败 toast
3. **备份管理**（保留现有 UI，移到底部）

移除：推荐预设区块、导入/导出区块

**`obsConfigCenter.js`** — 新增：
```js
export const calibrateObs = () => apiClient.post('/obs-config/calibrate')
```

---

## 错误处理

| 情况 | 处理方式 |
|------|---------|
| OBS 断连 | 按钮禁用，hover 提示"请先连接 OBS" |
| OBS 录制中 | 返回 400，前端展示"录制进行中，校准后需重新录制" |
| Step 中途失败 | 返回已完成的变更 + 失败原因，已完成步骤不回滚（操作幂等） |
| 非 Windows | `get_primary_monitor_resolution()` 返回 fallback，正常走后续流程 |

---

## 不在本次范围内

- 编码质量设置（码率/输出格式）— 现有设置页已覆盖，不动
- OBS 音频配置
- 多显示器支持（始终取主显示器）
- 自动校准（录制前静默校准）— 可作为后续优化

---

## 受影响文件清单

| 文件 | 操作 |
|------|------|
| `backend/app/obs_config_center.py` | 删除预设函数，新增 `calibrate()` |
| `backend/app/recording/obs_client.py` | 新增 `set_video_settings()` |
| `backend/app/env_utils.py` | 新增 `get_primary_monitor_resolution()` |
| `backend/app/main.py` | 删除预设端点，新增 `/api/obs-config/calibrate` |
| `frontend/src/pages/ObsConfigCenterPage.jsx` | 重组页面，替换预设 UI 为校准 UI |
| `frontend/src/api/obsConfigCenter.js` | 删除预设 API 函数，新增 `calibrateObs()` |
| `backend/app/data/basic.ini` | 删除 |
