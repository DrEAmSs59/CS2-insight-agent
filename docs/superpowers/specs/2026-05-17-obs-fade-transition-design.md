# OBS 黑场 Fade 转场设计文档

**日期**: 2026-05-17  
**分支**: `refactor/recording-plan-executor`  
**目标路径**: `backend/app/recording/executor/` + `frontend/src/`

---

## 背景与目标

在片段边界（StartRecord / 段间 jump-cut / StopRecord）加入 OBS 黑场 Fade 转场，使成片段落之间有平滑过渡，而不是硬切。

**约束**：
- 不动 `obs_director.py`（该文件后续将废弃）
- 不破坏现有 `OBSRecordingController` 的 pause/resume 稳定模型
- 转场失败时自动 fallback 到硬切，不中断录制主流程
- 转场时长作为额外视频帧插入，不从 segment 的击杀前/后预留里扣

---

## 原理

OBS WebSocket v5 中，`SetCurrentProgramScene` 触发场景切换时会使用当前配置的转场动画（由 `SetCurrentSceneTransition` 设定）。录制输出捕获的是 OBS Program 输出，因此转场动画会被录入成片。

流程：设置转场 → 切到黑场 → sleep(duration_ms) 等动画完成 → 执行 OBS 录制操作 → 切回游戏场景 → sleep(duration_ms)。

---

## 方案：`OBSFadeController`（方案 B）

新增独立 `OBSFadeController` 类，与现有 `OBSRecordingController` 平级。两者职责严格分离：

| 类 | 职责 |
|---|---|
| `OBSRecordingController` | 录制状态（StartRecord / PauseRecord / ResumeRecord / StopRecord） |
| `OBSFadeController` | 场景切换（fade_to_black / fade_to_game）+ Scene 生命周期管理 |

---

## §1 配置层

### `AppConfig` 新增字段（`backend/app/env_utils.py`）

```python
obs_transition_enabled: bool = False
obs_transition_name: str = "Fade"
obs_transition_duration_ms: int = 350
obs_game_scene_name: str = "CS2 Insight Recording"
obs_black_scene_name: str = "CS2 Insight Black"
```

- `obs_transition_enabled` 默认 `False`，现有用户零感知。
- `obs_game_scene_name` 默认与 `obs_director.py` 的 `_OBS_RECORDING_SCENE_NAME` 一致。
- `obs_black_scene_name` 为纯黑场景，代码自动创建。

### `RecordingOptions` 新增字段（`backend/app/recording/models.py`）

```python
obs_transition_enabled: Optional[bool] = None    # None = 沿用 AppConfig
obs_transition_name: Optional[str] = None
obs_transition_duration_ms: Optional[int] = None
```

### 合并逻辑（`backend/app/recording/api.py`）

```python
def _resolve_fade_config(options: RecordingOptions, cfg: AppConfig) -> FadeConfig:
    return FadeConfig(
        enabled=options.obs_transition_enabled
                if options.obs_transition_enabled is not None
                else cfg.obs_transition_enabled,
        transition_name=options.obs_transition_name or cfg.obs_transition_name,
        duration_ms=options.obs_transition_duration_ms
                   if options.obs_transition_duration_ms is not None
                   else cfg.obs_transition_duration_ms,
        game_scene_name=cfg.obs_game_scene_name,
        black_scene_name=cfg.obs_black_scene_name,
    )
```

---

## §2 `OBSClient` 新增同步方法（`backend/app/recording/executor/obs_client.py`）

```python
def get_scene_names(self) -> list[str]:
    """GetSceneList → 返回所有场景名列表。"""

def create_scene(self, scene_name: str) -> None:
    """CreateScene。已存在时忽略。"""

def set_current_program_scene(self, scene_name: str) -> None:
    """SetCurrentProgramScene，触发当前配置的转场动画。"""

def set_current_scene_transition(self, name: str, duration_ms: int) -> None:
    """SetCurrentSceneTransition，设置全局转场名和时长。"""

def get_scene_transition_list(self) -> list[str]:
    """GetSceneTransitionList → 返回 OBS 中可用的转场名列表。"""

def scene_has_source(self, scene_name: str, source_name: str) -> bool:
    """GetSceneItemList → 检查 scene 中是否已有指定 source。"""

def add_color_source_to_scene(self, scene_name: str, source_name: str,
                               color: int = 0xFF000000) -> None:
    """在 scene 中创建纯色 Color Source（用于黑场）。"""

def ensure_game_capture_in_scene(self, scene_name: str,
                                  capture_name: str,
                                  capture_kind: str = "game_capture") -> None:
    """检查 / 创建 Game Capture source 并链接到 scene（从 obs_director.py 迁移）。"""
```

全部方法遵循"薄包装"原则：参数校验由调用方负责，内部只做 WebSocket 调用并在失败时 raise。

---

## §3 `OBSFadeController`（新文件 `backend/app/recording/executor/obs_fade_controller.py`）

### `FadeConfig` dataclass

```python
@dataclass
class FadeConfig:
    enabled: bool
    transition_name: str
    duration_ms: int
    game_scene_name: str
    black_scene_name: str
```

### `OBSFadeController`

```python
class OBSFadeController:
    def __init__(self, obs_config: OBSConfig, fade_config: FadeConfig) -> None: ...

    @property
    def is_ready(self) -> bool:
        """True 仅在 setup() 成功后。enabled=False 时始终为 False（no-op 模式）。"""

    async def setup(self) -> bool:
        """
        录制前调用一次。
        1. 若 enabled=False → 直接返回 False（调用方按 no-op 处理）
        2. GetSceneList
        3. 确认/创建 game_scene + Game Capture source（迁移自 obs_director.py）
        4. 确认/创建 black_scene + 纯黑 Color Source
        5. GetSceneTransitionList 验证 transition_name 可用（warning-only，不阻断）
        6. self._ready = True
        任一步 Exception → logger.warning + return False
        """

    async def fade_to_black(self) -> bool:
        """
        is_ready=False → return True（no-op，视为成功）
        set_current_scene_transition(name, duration_ms)
        set_current_program_scene(black_scene_name)
        await asyncio.sleep(duration_ms / 1000.0)
        Exception → logger.warning + return False
        """

    async def fade_to_game(self) -> bool:
        """同上，切回 game_scene_name。"""
```

**关键约束**：`fade_to_*` 只做场景切换，绝对不调用任何录制命令。

---

## §4 `RecordingExecutor` 集成（`backend/app/recording/executor/recording_executor.py`）

### 初始化阶段

```python
self._fade = OBSFadeController(obs_config, fade_config)
await self._fade.setup()   # 失败时 is_ready=False，后续全部 no-op
```

### StartRecord（每个 clip 开始）

```python
await self._fade.fade_to_black()    # 失败 → warning，继续
await self._obs.start_record_safe()
await self._fade.fade_to_game()     # 失败 → warning，继续
# [console guard demo_resume，现有逻辑不动]
```

### 段间 jump-cut

```python
# segment sleep 结束后：
await self._fade.fade_to_black()    # 录入 game→black fade-out
await self._obs.pause_record_safe() # OBS 暂停（黑场中）
# [demo_pause / seek / spec / GSI，现有逻辑不动，OBS 已暂停]
await self._obs.resume_record_safe()
await self._fade.fade_to_game()     # 录入 black→game fade-in
# [console guard demo_resume，现有逻辑不动]
```

### StopRecord（每个 clip 结束）

```python
await self._fade.fade_to_black()    # 录入 game→black fade-out
await self._obs.stop_record_safe()  # 在黑场中停止
```

### Fallback 规则

`fade_to_*` 返回 `False` 时：log warning，直接执行下一步 OBS 录制命令，等同于原有硬切行为。主录制流程不中断，不抛出异常。

---

## §5 前端 UI

### `CommonParamsModal`（全局默认值）

新增折叠区「OBS 转场效果」，包含：

| 控件 | 字段 | 类型 | 范围 |
|---|---|---|---|
| 启用渐入渐出 | `obs_transition_enabled` | Toggle | — |
| 转场样式 | `obs_transition_name` | Select | Fade / Cut / Swipe |
| 时长 | `obs_transition_duration_ms` | Number | 0–2000 ms，步进 50 |

保存时通过 `PUT /api/config` 写入 `AppConfig`。

### `RecordWarmupModal`（逐次覆盖）

同样 3 个控件，初始值从 `AppConfig` 读取，用户修改后写入 `RecordingRequestDTO.options`（`Optional` 字段）。未改动保持 `null`，后端合并时沿用全局默认。

样式选项硬编码为 `["Fade", "Cut", "Swipe"]`，不查询 OBS。

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `backend/app/env_utils.py` | 修改 | `AppConfig` 新增 5 个字段 |
| `backend/app/recording/models.py` | 修改 | `RecordingOptions` 新增 3 个 Optional 字段 |
| `backend/app/recording/api.py` | 修改 | `_resolve_fade_config()` + 构造 `OBSFadeController` + 传入 executor |
| `backend/app/recording/executor/obs_client.py` | 修改 | 新增 8 个同步方法 |
| `backend/app/recording/executor/obs_fade_controller.py` | **新建** | `FadeConfig` + `OBSFadeController` |
| `backend/app/recording/executor/recording_executor.py` | 修改 | 集成 `OBSFadeController`，3 处调用点 |
| `frontend/src/components/montage/MontageStyleConsole.jsx` 或 `CommonParamsModal` | 修改 | 全局默认 UI |
| `frontend/src/components/RecordWarmupModal`（或对应文件） | 修改 | 逐次覆盖 UI |
| `frontend/src/utils/montageUtils.js` 或 config API util | 修改 | 新字段的读写 |

---

## 不在本设计范围内

- `obs_director.py` 不动
- Demo tick 计算不动，segment sleep 不扣转场时长
- OBS Studio Mode 的 `TriggerStudioModeTransition` 不处理（非 Studio Mode 场景）
- 转场结束后不恢复 OBS 的原始转场设置（Set 后保持，用户可手动改回）
