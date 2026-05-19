# OBS 一键校准 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一键校准替代 OBS 预设功能，运行时自动修正画布分辨率、Game Capture 场景和输出格式，彻底解决"画面只在左上角一坨"和"4:3 黑边"问题。

**Architecture:** 在 `obs_config_center.py` 新增 `calibrate()` 函数，沿用该文件现有的 `_ws_connect` + 原始 `obs_requests` 调用模式（不修改 OBSClient）。新增 `POST /api/obs-config/calibrate` 端点。删除全部预设相关函数和端点。前端 `ObsConfigCenterPage.jsx` 移除预设 UI，新增校准结果展示。

**Tech Stack:** Python / FastAPI / obswebsocket (obs_requests) / ctypes (Windows monitor API) / React 19 / TailwindCSS 4

---

## 文件清单

| 文件 | 操作 |
|------|------|
| `backend/app/env_utils.py` | 新增 `get_primary_monitor_resolution()` |
| `backend/app/obs_config_center.py` | 新增 `calibrate()`；删除 `apply_recommended`, `import_cs2obs_bytes`, `export_cs2obs_dict`, `import_native_files`, `_apply_scale_inner_transform` |
| `backend/app/main.py` | 删除 4 个预设端点；新增 `POST /api/obs-config/calibrate` |
| `frontend/src/api/obsConfigCenter.js` | 删除 `applyRecommendedObsPreset`, `importNativeObsConfig`；新增 `calibrateObs` |
| `frontend/src/pages/ObsConfigCenterPage.jsx` | 移除预设 UI 区块；新增校准按钮 + 结果列表 |
| `backend/app/data/basic.ini` | 删除（若存在） |

---

## Task 1: 新增 `get_primary_monitor_resolution()` 到 env_utils.py

**Files:**
- Modify: `backend/app/env_utils.py`

- [ ] **Step 1: 在 env_utils.py 末尾追加函数**

在文件末尾（`winreg` 条件导入已在文件顶部，用同样模式处理 ctypes）追加：

```python
def get_primary_monitor_resolution() -> tuple[int, int]:
    """返回主显示器分辨率 (width, height)。非 Windows 返回 (1920, 1080) 作为 fallback。"""
    try:
        import ctypes
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    except Exception:
        return 1920, 1080
```

- [ ] **Step 2: 验证可以 import**

```bash
cd backend
python -c "from app.env_utils import get_primary_monitor_resolution; print(get_primary_monitor_resolution())"
```

Windows 上预期输出形如 `(2560, 1440)`，非 Windows 输出 `(1920, 1080)`。

- [ ] **Step 3: Commit**

```bash
git add backend/app/env_utils.py
git commit -m "feat: add get_primary_monitor_resolution() to env_utils"
```

---

## Task 2: 新增 `calibrate()` 到 obs_config_center.py

**Files:**
- Modify: `backend/app/obs_config_center.py`

- [ ] **Step 1: 确认现有 import 已包含所需项**

在 `obs_config_center.py` 顶部找到如下 import（已存在，无需新增）：

```python
from obswebsocket import obsws, requests as obs_requests
```

确认 `_ws_connect`、`_ws_disconnect`、`_obs_is_recording`、`_dedicated_scene_name`、`_dedicated_capture_name`、`_parse_ws_video` 均已在文件中定义（行号约 300-340）。

- [ ] **Step 2: 新增 `calibrate()` 函数**

在 `obs_config_center.py` 中，在 `apply_recommended` 函数定义之前（约第 989 行前）插入以下函数：

```python
def calibrate(obs_cfg) -> dict[str, Any]:
    """运行时校准：读显示器分辨率 → 修正 OBS 画布 → 建场景 → 建 Game Capture → 设拉伸 → 修输出格式。
    仅操作 CS2 Insight 专用场景，不动用户其他场景。
    """
    from .env_utils import get_primary_monitor_resolution

    ws = None
    try:
        ws = _ws_connect(obs_cfg)
    except Exception as exc:
        raise ValueError(f"OBS WebSocket 未连接，请先在设置中测试连接：{exc}") from exc

    try:
        if _obs_is_recording(ws):
            raise ValueError("录制进行中，无法修改视频设置，请录制结束后再校准")

        changed: list[str] = []
        already_ok: list[str] = []

        # Step 1+2: 读显示器分辨率 & OBS 画布
        monitor_w, monitor_h = get_primary_monitor_resolution()

        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        canvas_w = vd.get("base_width", 0)
        canvas_h = vd.get("base_height", 0)

        # Step 3: 修正画布分辨率
        if canvas_w != monitor_w or canvas_h != monitor_h:
            ws.call(obs_requests.SetVideoSettings(
                baseWidth=monitor_w,
                baseHeight=monitor_h,
                outputWidth=monitor_w,
                outputHeight=monitor_h,
                fpsNumerator=60,
                fpsDenominator=1,
            ))
            changed.append(f"已将画布分辨率从 {canvas_w}×{canvas_h} 修正为 {monitor_w}×{monitor_h}")
        else:
            already_ok.append(f"画布分辨率正确（{canvas_w}×{canvas_h}）")

        # Step 4: 确保 CS2 Insight 场景存在
        scene_name = _dedicated_scene_name()
        scenes_resp = ws.call(obs_requests.GetSceneList())
        scenes_data = getattr(scenes_resp, "datain", None) or {}
        scene_names = [s.get("sceneName", "") for s in scenes_data.get("scenes", [])]

        if scene_name not in scene_names:
            ws.call(obs_requests.CreateScene(sceneName=scene_name))
            changed.append(f"已创建场景「{scene_name}」")
        else:
            already_ok.append(f"场景「{scene_name}」已存在")

        # Step 5: 确保 Game Capture 源存在
        capture_name = _dedicated_capture_name()
        items_resp = ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
        items_data = getattr(items_resp, "datain", None) or {}
        source_names = [item.get("sourceName", "") for item in items_data.get("sceneItems", [])]

        if capture_name not in source_names:
            ws.call(obs_requests.CreateInput(
                sceneName=scene_name,
                inputName=capture_name,
                inputKind="game_capture",
                inputSettings={"capture_mode": "window", "window": "cs2.exe"},
            ))
            changed.append(f"已创建 Game Capture 源「{capture_name}」")
        else:
            already_ok.append(f"Game Capture 源「{capture_name}」已存在")

        # Step 6: 设置拉伸填满画布
        item_id_resp = ws.call(obs_requests.GetSceneItemId(
            sceneName=scene_name, sourceName=capture_name
        ))
        item_id_data = getattr(item_id_resp, "datain", None) or {}
        item_id = item_id_data.get("sceneItemId")
        if item_id is not None:
            ws.call(obs_requests.SetSceneItemTransform(
                sceneName=scene_name,
                sceneItemId=int(item_id),
                sceneItemTransform={
                    "positionX": 0,
                    "positionY": 0,
                    "boundsType": "OBS_BOUNDS_STRETCH",
                    "boundsWidth": monitor_w,
                    "boundsHeight": monitor_h,
                },
            ))
            changed.append("已设置 Game Capture 拉伸填满画布")

        # Step 7: 修正输出设置（RecQuality / RecFormat2）
        rec_q_resp = ws.call(obs_requests.GetProfileParameter(
            parameterCategory="SimpleOutput", parameterName="RecQuality"
        ))
        rec_q_data = getattr(rec_q_resp, "datain", None) or {}
        rec_quality = rec_q_data.get("parameterValue", "")

        if rec_quality == "Stream":
            ws.call(obs_requests.SetProfileParameter(
                parameterCategory="SimpleOutput",
                parameterName="RecQuality",
                parameterValue="High",
            ))
            changed.append("录像质量已从「与串流一致」改为「高质量，中等文件大小」")
        else:
            already_ok.append("录像质量设置正常")

        rec_f_resp = ws.call(obs_requests.GetProfileParameter(
            parameterCategory="SimpleOutput", parameterName="RecFormat2"
        ))
        rec_f_data = getattr(rec_f_resp, "datain", None) or {}
        rec_format = rec_f_data.get("parameterValue", "")

        if rec_format != "hybrid_mp4":
            ws.call(obs_requests.SetProfileParameter(
                parameterCategory="SimpleOutput",
                parameterName="RecFormat2",
                parameterValue="hybrid_mp4",
            ))
            changed.append("录像格式已改为「混合 MP4」")
        else:
            already_ok.append("录像格式正确（混合 MP4）")

        return {"success": True, "changed": changed, "already_ok": already_ok}

    finally:
        _ws_disconnect(ws)
```

- [ ] **Step 3: 验证语法**

```bash
cd backend
python -c "import app.obs_config_center; print('OK')"
```

预期输出：`OK`（无报错）。

- [ ] **Step 4: Commit**

```bash
git add backend/app/obs_config_center.py
git commit -m "feat: add calibrate() to obs_config_center"
```

---

## Task 3: 新增 `/api/obs-config/calibrate` 端点，删除预设端点

**Files:**
- Modify: `backend/app/main.py`

- [ ] **Step 1: 删除四个预设端点**

在 `main.py` 中找到并完整删除以下四个路由函数（约第 984–1044 行）：

```python
@app.post("/api/obs-config/apply-recommended")
def obs_config_apply_recommended(...): ...

@app.post("/api/obs-config/import-preset")
async def obs_config_import_preset(...): ...

@app.get("/api/obs-config/export-preset")
def obs_config_export_preset(): ...

@app.post("/api/obs-config/import-native")
async def obs_config_import_native(...): ...
```

同时检查并删除仅被上述函数使用的 Pydantic 模型（如 `ObsConfigApplyRecommended`）。

- [ ] **Step 2: 在 `/api/obs-config/backups` 之前插入新端点**

在 `@app.get("/api/obs-config/backups")` 之前插入：

```python
@app.post("/api/obs-config/calibrate")
def obs_config_calibrate():
    cfg = load_config()
    try:
        return obs_config_center.calibrate(cfg.obs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
```

- [ ] **Step 3: 验证后端启动无报错**

```bash
cd backend
python -c "from app.main import app; print('OK')"
```

预期：`OK`。

- [ ] **Step 4: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: add /api/obs-config/calibrate, remove preset endpoints"
```

---

## Task 4: 删除 obs_config_center.py 中的预设函数

**Files:**
- Modify: `backend/app/obs_config_center.py`

- [ ] **Step 1: 删除五个预设函数**

在 `obs_config_center.py` 中找到并完整删除以下函数：

| 函数名 | 起始行关键字 |
|--------|------------|
| `apply_recommended()` | `def apply_recommended(` |
| `import_cs2obs_bytes()` | `def import_cs2obs_bytes(` |
| `export_cs2obs_dict()` | `def export_cs2obs_dict(` |
| `import_native_files()` | `def import_native_files(` |
| `_apply_scale_inner_transform()` | `def _apply_scale_inner_transform(` |

删除时连带删除各函数的 docstring 和空行，保持文件整洁。

- [ ] **Step 2: 检查并清理孤立的辅助函数**

搜索以下函数，若它们仅被上述已删除函数调用，则一并删除：

```bash
grep -n "_bundled_obs_basic_ini_path\|_try_set_video_and_profile_params\|_merge_write_simple_output\|_parse_basic_ini_video_dims\|_pick_rec_encoder_from_simple\|_parse_simple_output\|_ensure_project_profile_folder\|_set_global_ini_current_profile\|_effective_project_profile\|_obs_studio_root\|_create_backup\|resolve_default_project_profile_for_obs" backend/app/obs_config_center.py
```

对每个出现的函数，确认是否还被 `calibrate()`、`diagnose()`、`get_status_payload()`、`list_backups()`、`restore_backup()`、`delete_backup()`、`open_backup_folder()` 所使用。仅删除完全孤立的函数。

- [ ] **Step 3: 验证语法与导入**

```bash
cd backend
python -c "import app.obs_config_center; print('OK')"
```

预期：`OK`。

- [ ] **Step 4: 删除预设模板文件（若存在）**

```bash
# 检查文件是否存在
ls backend/app/data/basic.ini 2>/dev/null && git rm backend/app/data/basic.ini || echo "不存在，跳过"
```

- [ ] **Step 5: Commit**

```bash
git add -u backend/app/obs_config_center.py
git add -u backend/app/data/
git commit -m "refactor: remove preset functions from obs_config_center"
```

---

## Task 5: 更新前端 API 客户端

**Files:**
- Modify: `frontend/src/api/obsConfigCenter.js`

- [ ] **Step 1: 将 obsConfigCenter.js 替换为以下内容**

```js
import API from "./api";

export async function getObsConfigStatus() {
  const { data } = await API.get("/obs-config/status");
  return data;
}

export async function calibrateObs() {
  const { data } = await API.post("/obs-config/calibrate");
  return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/api/obsConfigCenter.js
git commit -m "refactor: replace preset API fns with calibrateObs in obsConfigCenter.js"
```

---

## Task 6: 重写 ObsConfigCenterPage.jsx

**Files:**
- Modify: `frontend/src/pages/ObsConfigCenterPage.jsx`

- [ ] **Step 1: 将整个文件替换为以下内容**

```jsx
import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/api";
import { CheckCircle2, Loader2, Wifi, WifiOff } from "lucide-react";
import PageContainer from "../components/PageContainer";
import { useAppShell } from "../context/AppShellContext";
import { calibrateObs, getObsConfigStatus } from "../api/obsConfigCenter";

export default function ObsConfigCenterPage() {
  const {
    obsConfig,
    setObsConfig,
    persistObsConfig,
    obsPasswordPlaceholder,
    handleObsPasswordFocus,
    handleObsPasswordBlur,
    batchRecording,
    setProgressText,
  } = useAppShell();

  const [status, setStatus] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrateResult, setCalibrateResult] = useState(null);
  const [errorText, setErrorText] = useState("");
  const [obsTesting, setObsTesting] = useState(false);
  const [obsTestResult, setObsTestResult] = useState(null);

  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;

  const fetchStatus = useCallback(async () => {
    const st = await getObsConfigStatus();
    setStatus(st);
  }, []);

  const refreshSilent = useCallback(async () => {
    setErrorText("");
    try {
      await fetchStatus();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || "加载失败");
    }
  }, [fetchStatus]);

  useEffect(() => {
    void refreshSilent();
  }, [refreshSilent]);

  const testObsConnection = async () => {
    setObsTesting(true);
    setObsTestResult(null);
    try {
      const { data } = await API.post("/obs/test", obsConfigRef.current);
      if (data?.ok) {
        await persistObsConfig?.();
        await refreshSilent();
        setStatus((prev) => {
          if (!prev) return prev;
          const ver = data.obs_version || prev.obs_version;
          return { ...prev, obs_connected: true, ...(ver ? { obs_version: ver } : {}) };
        });
      } else {
        setObsTestResult({ ok: false, error: data?.error || "连接失败" });
      }
    } catch (e) {
      setObsTestResult({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally {
      setObsTesting(false);
    }
  };

  const handleCalibrate = async () => {
    setCalibrating(true);
    setCalibrateResult(null);
    setErrorText("");
    try {
      const data = await calibrateObs();
      setCalibrateResult(data);
      const n = data.changed?.length ?? 0;
      setProgressText(
        n > 0 ? `校准完成，已修正 ${n} 项配置` : "校准完成，OBS 配置均正常",
        { autoDismissMs: 8000 },
      );
      await refreshSilent();
    } catch (e) {
      setErrorText(e.response?.data?.detail || e.message || "校准失败");
    } finally {
      setCalibrating(false);
    }
  };

  const calibrateDisabled = batchRecording || calibrating || !status?.obs_connected;

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto">
      <PageContainer>
        <div>
          <h1 className="text-lg font-bold tracking-wide text-cs2-text-primary">OBS 配置中心</h1>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-cs2-text-secondary">
            一键校准 OBS 录制环境，自动修复画布分辨率错位、4:3 黑边、Game Capture 源缺失、录像格式错误等问题。
          </p>
        </div>

        {errorText ? (
          <div className="mt-3 rounded-lg border border-cs2-border-error/40 bg-cs2-rose-surface px-3 py-2 text-[12px] text-cs2-rose-on-surface">
            {errorText}
          </div>
        ) : null}

        {/* OBS WebSocket 连接 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-cs2-text-primary">OBS WebSocket 连接</div>
              <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-muted">
                与 OBS「工具 → WebSocket 服务器设置」中的主机、端口、密码一致；保存配置后录制均使用该连接。
              </p>
            </div>
            {status != null ? (
              <div className="shrink-0 text-right">
                {status.obs_connected ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-text-success">
                    <Wifi className="h-3.5 w-3.5 shrink-0" />
                    已连接{status.obs_version ? ` · ${status.obs_version}` : ""}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-cs2-amber-on-surface">
                    <WifiOff className="h-3.5 w-3.5 shrink-0" />
                    未连接
                  </span>
                )}
              </div>
            ) : null}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                主机地址
              </label>
              <input
                type="text"
                value={obsConfig.host ?? ""}
                onChange={(e) => setObsConfig({ ...obsConfig, host: e.target.value })}
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                端口
              </label>
              <input
                type="number"
                value={obsConfig.port ?? 4455}
                onChange={(e) => setObsConfig({ ...obsConfig, port: Number(e.target.value) })}
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors focus:border-cs2-accent/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-cs2-text-muted">
                密码
              </label>
              <input
                type="password"
                value={obsConfig.password ?? ""}
                placeholder={obsPasswordPlaceholder}
                onChange={(e) => setObsConfig({ ...obsConfig, password: e.target.value })}
                onFocus={() => handleObsPasswordFocus?.()}
                onBlur={() => handleObsPasswordBlur?.()}
                autoComplete="new-password"
                className="w-full rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-xs text-cs2-text-primary transition-colors placeholder:text-cs2-text-muted/80 focus:border-cs2-accent/50 focus:outline-none"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => void testObsConnection()}
            disabled={obsTesting}
            className="mt-3 w-full rounded-lg border border-cs2-border bg-cs2-bg-input py-2.5 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:bg-cs2-bg-hover disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {obsTesting ? "测试中…" : "测试连接"}
          </button>
          {obsTestResult && !obsTestResult.ok ? (
            <div className="mt-3 rounded-lg bg-cs2-rose-surface px-3 py-2 font-mono text-[12px] text-cs2-rose-on-surface">
              <span className="flex items-center gap-2">
                <WifiOff className="h-3.5 w-3.5 shrink-0" /> {obsTestResult.error}
              </span>
            </div>
          ) : null}
        </section>

        {/* 一键校准 */}
        <section className="mt-4 rounded-xl border border-cs2-border bg-cs2-bg-card p-5 shadow-sm">
          <div className="text-sm font-semibold text-cs2-text-primary">一键校准</div>
          <p className="mt-2 text-[12px] leading-relaxed text-cs2-text-secondary">
            自动检测并修正：OBS 画布分辨率（对齐主显示器）、CS2 Insight 专用场景及 Game Capture 源（自动创建）、
            拉伸策略（填满画布，解决 4:3 黑边）、录像格式（混合 MP4）、录像质量（非「与串流一致」）。
            仅操作 CS2 Insight 专用场景，不影响其他 OBS 场景。
          </p>
          <button
            type="button"
            onClick={() => void handleCalibrate()}
            disabled={calibrateDisabled}
            title={
              !status?.obs_connected
                ? "请先连接 OBS WebSocket"
                : batchRecording
                  ? "批量录制进行中"
                  : ""
            }
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-cs2-accent px-4 py-2 text-[12px] font-bold text-cs2-text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {calibrating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            校准 OBS 配置
          </button>

          {calibrateResult ? (
            <div className="mt-4 space-y-1.5">
              {calibrateResult.changed?.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px] text-cs2-text-success">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {msg}
                </div>
              ))}
              {calibrateResult.already_ok?.map((msg, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px] text-cs2-text-muted">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {msg}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </PageContainer>
    </div>
  );
}
```

- [ ] **Step 2: 验证前端无编译报错**

```bash
cd frontend
npm run build 2>&1 | tail -20
```

预期：`built in X.Xs`，无 error。若有 `Cannot find module` 或 `is not exported` 报错，检查 import 路径。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ObsConfigCenterPage.jsx
git commit -m "feat: replace preset UI with one-click calibration in ObsConfigCenterPage"
```

---

## 自检清单

完成所有 Task 后，逐项确认：

- [ ] `POST /api/obs-config/calibrate` 在 OBS 连接时能正常返回 `{success, changed, already_ok}`
- [ ] OBS 未连接时点校准按钮被禁用（`status.obs_connected` 为 false）
- [ ] OBS 录制中时 API 返回 400，前端展示 errorText
- [ ] `calibrate()` 不会修改或删除 CS2 Insight 专用场景以外的任何 OBS 场景
- [ ] 旧的 `/api/obs-config/apply-recommended` 端点已不存在（curl 返回 404）
- [ ] 前端 `ObsConfigCenterPage.jsx` 不再 import `applyRecommendedObsPreset` / `importNativeObsConfig`
