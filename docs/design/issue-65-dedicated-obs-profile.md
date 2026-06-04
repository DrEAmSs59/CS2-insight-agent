# 设计方案：录制时切换到 CS2IA 专属 OBS 配置文件（Issue #65）

> 状态：**设计中，本次分支不发版**。本文档用于后续实现。
> 关联 Issue：#65（录制视频编码器选择问题），可顺带覆盖 #64（输出分辨率警告）。

---

## 1. 背景与问题

有直播需求的主播通常把 OBS 录制设为「使用直播编码器」（`RecQuality=Stream`），这样直播 + 录制共用一条编码流，显卡只编码一次、性能负担小。但这种模式下：

- OBS **无法暂停录制**，CS2IA 基于 seek 的分片录制流程会出现缺录、错乱等问题。
- 若改成独立录制编码器，直播 + 录制时显卡要编码两条流，给直播带来很大负担。

结果：用户每次用 CS2IA 都得**手动把录制编码器改成非直播编码器，用完再改回去**。

### 现状实现的缺陷

当前 [`obs_config_center.py` `calibrate()`](../../backend/app/obs_config_center.py) 的做法是**直接修改用户当前 profile**：检测到 `RecQuality=Stream` 就强行改成 `Small` 并另配编码器（`obs_config_center.py:960` 附近），再依赖备份/恢复兜底。这正是痛点根源——它动了主播精心调好的直播配置，且依赖「改了再恢复」这套脆弱逻辑。

---

## 2. 目标与非目标

### 目标

1. **不影响用户原配置**：主播的直播 profile 一个字节都不改。
2. **无感**：用户点「开始录制」即可，无需任何手动切换；录制产物的分辨率/格式/质量符合预期。
3. **崩溃安全**：CS2IA 异常退出也不会把用户卡在专属 profile 上。
4. **OBS 配置页有清晰提示**：让用户理解「CS2IA 会用自己的配置文件录制，不动你的直播配置」。

### 非目标

- 不支持「边直播边让 CS2IA 录制 demo」——CS2IA 用 `-insecure` 单独拉起 CS2 放录像，与主播实时直播是互斥的两个时段（见 §4 时机分析）。
- 不切换 Scene Collection（见 §5）。

---

## 3. 核心思路

新建一个 CS2IA 专属 OBS **配置文件（Profile）**，**在「点击开始录制之后、拉起 CS2 之前」切过去**，录制结束（或中止/崩溃）后切回用户原 profile。

```
点击开始录制
  → 记住用户当前 profile 名（持久化到磁盘）
  → 确保专属 profile 存在且已配置好（独立录制编码器 / hybrid_mp4 / 分辨率 / 输出目录）
  → SetCurrentProfile(专属 profile)
  → 拉起 CS2、逐片段 StartRecord / StopRecord
  → 录制结束 / 中止 / 崩溃
  → SetCurrentProfile(用户原 profile)   ← 收尾 finally 中执行
```

---

## 4. 时机分析：为什么这套方案安全

OBS 在**正在直播 / 正在录制时不允许（或不应）切换 Profile**。但本方案的切换点在「点击开始录制之后、CS2 启动之前」，此刻：

- OBS 没有任何 output 在跑（没直播、没录制）。
- 因此 `SetCurrentProfile` 调用是安全的，不触碰「活动 output 中切换」的未定义行为。

> ⚠️ 仍需在切换前 **guard**：调用 `GetStreamStatus` / `GetRecordStatus`，若任一活动则拒绝并给出清晰提示（防止用户在直播中误触发）。

---

## 5. 只切 Profile，不切 Scene Collection

OBS 里 **Profile（编码器/码率/格式/分辨率）和 Scene Collection（场景/源）是正交的**——切 Profile 不会动 Scene Collection。

而 #65 纯粹是**录制编码器**问题，编码器只存在于 Profile 里。因此：

- **只 `SetCurrentProfile`**，不碰 Scene Collection。
- `calibrate()` 现在建的那个 Game Capture 专属场景（以及 #63 要加的音频源）继续待在用户当前 Scene Collection 里、保持共用。
- 这样完全避开 OBS WebSocket 协议中「切换 Scene Collection 是 undefined behavior、可能崩溃」的高危路径（官方协议文档对 `SetCurrentSceneCollection` 的明确警告）。

---

## 6. WebSocket API 可用性（已确认）

OBS WebSocket v5 协议已确认提供（且项目所用 `obs-websocket-py` 1.0 用动态 `ClassFactory`，任意请求名都能调）：

| 请求 | 用途 |
|---|---|
| `GetProfileList` | 列出所有 profile、读当前 profile 名 |
| `CreateProfile` | 新建 profile（建出来是默认空配置） |
| `SetCurrentProfile` | 切换当前 profile |
| `GetProfileParameter` / `SetProfileParameter` | 读写当前 profile 的参数（编码器等） |
| `GetStreamStatus` / `GetRecordStatus` | 切换前 guard |
| `GetVideoSettings` / `SetVideoSettings` | 当前 profile 的画布/输出分辨率/FPS |

> `SetProfileParameter` / `SetVideoSettings` **只作用于当前 profile**，所以必须先 `SetCurrentProfile` 切过去，再配参数。

---

## 7. 「无感」如何实现：专属 profile 的内容从哪来

这是方案的核心难点。专属 profile 必须让录制产物与用户预期一致，同时不碰用户直播 profile。两条路线：

### 路线 A（推荐）：WS 创建 + 按需配置

1. 切换前先用 `GetProfileParameter` / `GetVideoSettings` 从**用户当前 profile** 读出关键值：基础/输出分辨率、FPS、录制输出目录。
2. `CreateProfile(专属)`（若不存在）。
3. `SetCurrentProfile(专属)`。
4. 在专属 profile 内用 `SetVideoSettings` + `SetProfileParameter` 写入：
   - 画布/输出分辨率、FPS：沿用现状一键校准模式（base=output=主显示器分辨率，见 §10）
   - `RecQuality=Small`（脱离「与直播一致」）
   - **独立录制编码器**（按硬件优先级选，复用现有 `_HW_PRIORITY` 逻辑）
   - `RecFormat2=hybrid_mp4`
   - 录制输出目录（沿用用户的，保证产物落在用户习惯的位置）

> 优点：OBS 通过 WS 创建，运行期就能识别并切换，不存在「磁盘新建文件夹 OBS 不感知」的问题。
> 局限：profile 内大量设置（音频设备、热键等）保持 OBS 默认。对 CS2IA 录 demo 而言够用——游戏音频走 Scene Collection 里的捕获源（#63），不依赖 profile 级音频设备。

### 路线 B（备选）：磁盘拷贝种子

复用现有 `_ensure_project_profile_folder()` / `_copy_profile_tree()`，把用户当前 profile 文件夹整体拷成「CS2 Insight」profile，再只覆盖录制相关参数。

> 优点：完全继承用户所有设置，最「无感」。
> 致命局限：**OBS 运行期在磁盘上新建 profile 文件夹，OBS 不会感知，`SetCurrentProfile` 找不到它**，需要 OBS 重启或重扫。与「无感、运行期切换」目标冲突。

**结论：采用路线 A。** 首次在 OBS 配置页「一键校准」时创建并配置好专属 profile，之后录制时只做 `SetCurrentProfile` 切换（已配好，无需每次重配）。

> 待验证项见 §11：切 profile 后编码器是否**免 OBS 重启**即生效（很可能是，因为切 profile 会重新初始化输出管线，优于现状 `SetProfileParameter` 不热重载需重启）。

---

## 8. 崩溃安全的「切回」

CS2IA 录制中途崩溃 / 进程被 `taskkill`，用户可能被卡在专属 profile 上。处理方式（镜像现有 `cs2_config_backup` 的 `recording_state.json` 持久化模式）：

1. 切到专属 profile **之前**，把「用户原 profile 名 + 时间戳」写入磁盘状态文件（如 `data/.obs_profile_state.json`）。
2. 正常收尾时切回原 profile 并清除该状态文件。
3. **CS2IA 启动时对账**：若发现状态文件存在（说明上次没正常切回），且 OBS 当前停在专属 profile，则提示用户 / 自动切回原 profile。
4. 切回逻辑挂在 [`obs_director.py`](../../backend/app/obs_director.py) 录制收尾的 `finally`（`_cleanup_recording_session` / `_kill_cs2` → `_restore_user_configs` 同一链路），与 CS2 taskkill、玩家 config 回滚一起执行。

---

## 9. 代码落点

| 模块 | 改动 |
|---|---|
| [`obs_config_center.py`](../../backend/app/obs_config_center.py) | 新增 `ensure_dedicated_profile()`（创建+配置专属 profile）、`switch_to_dedicated_profile()` / `restore_user_profile()`；`calibrate()` 改为操作专属 profile 而非用户当前 profile；`diagnose()` / `get_status_payload()` 针对专属 profile 检测 |
| [`obs_director.py`](../../backend/app/obs_director.py) | 录制开始前（`execute_plan_queue` 拉起 CS2 之前）调 `switch_to_dedicated_profile`；收尾 `finally` 调 `restore_user_profile`；guard 直播/录制状态 |
| 新增 `obs_profile_state.py`（或并入 `cs2_config_backup`） | `data/.obs_profile_state.json` 读写 + 启动对账 |
| [`env_utils.py`](../../backend/app/env_utils.py) `AppConfig` | 新增字段（见下） |
| 前端 [`ObsConfigCenterPage.jsx`](../../frontend/src/pages/ObsConfigCenterPage.jsx) / [`obsConfigHealth.js`](../../frontend/src/utils/obsConfigHealth.js) | 展示专属 profile 状态 + §12 提示文案 |

### 新增配置项（`AppConfig` / `OBSConfig`）

```python
# OBSConfig 内
dedicated_profile_enabled: bool = True          # 是否启用专属 profile 隔离（默认开）
dedicated_profile_name: str = "CS2 Insight"     # 专属 profile 名（稳定标识，勿随意改）
# 分辨率沿用现状一键校准模式（base=output=主显示器），不额外加分辨率配置项
```

---

## 10. 顺带解决 #64（输出分辨率警告）

**决策：专属 profile 的分辨率沿用现状「一键校准」模式（base=output=主显示器分辨率），不锁 1080p。**

#64 仍然被解决，但靠的是**隔离**而非锁分辨率：隔离后 `diagnose()` 只对**专属 profile** 判断分辨率，CS2IA 不再对用户自己的直播 profile 做任何分辨率检测/警告。用户在直播 profile 里把输出设成 1080p（或任意值）都不会再被提醒——#64 的投诉点（被警告「应为 2560×1440」）随之消失。

---

## 11. 实现前必须实测的验证项

动手前用最小脚本连本机 OBS 跑一遍，确认：

1. **运行期 `CreateProfile` → `SetCurrentProfile` → 切回** 全流程正常。
2. **切 profile 后录制编码器是否免 OBS 重启即生效**（决定能否去掉现状的 `restart_obs_required` 提示）。
3. `SetProfileParameter`（编码器等）在专属 profile 为当前 profile 时写入后，`StartRecord` 是否能用该编码器正常起录。
4. 切换 profile 期间 OBS WebSocket 是否有短暂不可用窗口（决定是否需要在切换后加一个小的稳定等待 + 回读校验）。

---

## 12. OBS 配置页详细提示文案（前端）

### 12.1 功能说明区块（常驻）

> **CS2IA 专属录制配置**
> CS2IA 会使用一个独立的 OBS 配置文件「CS2 Insight」进行录制，**不会修改你平时的直播/录制配置**。录制开始时自动切换过去，录制结束后自动切回，全程无需手动操作。
> 这样既能用独立录制编码器保证分片录制不缺录，又不会影响你直播时「直播+录制共用编码器」的性能优化。

### 12.2 状态指示（诊断结果项）

| 状态 | 文案 |
|---|---|
| 专属 profile 已就绪 | ✅ 专属录制配置「CS2 Insight」已创建并配置完成 |
| 专属 profile 缺失 | ⚠️ 尚未创建专属录制配置，点击「一键校准」自动创建（不影响你的现有配置） |
| 专属 profile 编码器异常 | ⚠️ 专属录制配置的编码器无效，点击「一键校准」修复 |
| 检测到卡在专属 profile（崩溃残留） | ⚠️ 上次录制异常退出，OBS 当前仍停在「CS2 Insight」配置。[一键切回我的配置] |

### 12.3 一键校准结果提示

校准成功后，`changed` / `already_ok` 列表里展示：

- 「已创建专属录制配置「CS2 Insight」（你的直播配置未做任何改动）」
- 「专属配置录制编码器已设为「jim_nvenc」（独立于直播编码器）」
- 「专属配置录制格式：混合 MP4 / 分辨率 1920×1080」

### 12.4 直播中触发的拦截提示

> ❌ 检测到 OBS 正在直播/录制，无法切换录制配置。请先停止当前直播/录制，再使用 CS2IA 录制功能。

### 12.5 录制流程内的轻提示（可选 toast）

- 录制开始：「已切换到 CS2IA 专属录制配置」
- 录制结束：「已切回你的原配置」

---

## 13. 风险与边界

| 风险 | 缓解 |
|---|---|
| 用户在直播中误触发录制 | 切换前 guard `GetStreamStatus`/`GetRecordStatus`，拒绝并提示（§12.4） |
| 崩溃后卡在专属 profile | 磁盘状态文件 + 启动对账自动切回（§8、§12.2） |
| 切 profile 后编码器需重启才生效 | §11 实测；若需重启则提示用户，或退回「首次创建时配置好、之后只切换」策略规避 |
| 专属 profile 被用户手动删除 | 录制前 `ensure_dedicated_profile()` 检测不存在则重建 |
| 多 OBS 版本编码器名差异 | 复用现有 `_HW_PRIORITY` 硬件优先级回退逻辑 |
| profile 名本地化/重名冲突 | 用固定标识名「CS2 Insight」，创建前查 `GetProfileList` 去重 |

---

## 14. 分阶段实现建议

1. **阶段 0 — 验证**：写 §11 的最小脚本，敲定不确定项（尤其「切 profile 是否免重启」）。
2. **阶段 1 — 后端核心**：`ensure_dedicated_profile` / `switch` / `restore` + 状态文件 + 启动对账；`calibrate()` 改造。
3. **阶段 2 — 录制流程接入**：`obs_director` 切换/切回 + guard + 崩溃收尾。
4. **阶段 3 — 诊断与前端**：`diagnose`/`get_status` 适配 + §12 全部提示文案。
5. **阶段 4 — #64 收尾**：确认 `diagnose()` 只判断专属 profile、不再对用户直播 profile 做分辨率警告（隔离即解决，无需锁 1080p）。

---

## 15. 已确认的决策

1. **使用场景：CS2IA 录制时 OBS 一定不在直播状态。** ✅ 「互斥」前提成立，本方案的切换时机（点击录制后、拉起 CS2 前）安全。`GetStreamStatus`/`GetRecordStatus` 的 guard 作为防误触保险仍保留。
2. **分辨率策略：专属 profile 沿用现在「一键检测/校准」的模式**——即 base=output=主显示器分辨率（与现状 `calibrate()` 一致），**不锁 1080p**。`dedicated_profile_output_height` 配置项取消，固定跟随显示器。
   - #64 仍然被解决：因为隔离后 `diagnose()` 只判断专属 profile，**不再对用户自己的直播 profile 的分辨率做任何警告**，用户在直播 profile 里设 1080p 不会再被提醒。
3. **保留「改用户当前 profile」作为降级。** ✅ 当 OBS 版本过老、不支持 profile 相关 API（`CreateProfile`/`SetCurrentProfile` 等）时，回退到现状逻辑（直接改当前 profile + 备份恢复）。`ensure_dedicated_profile()` 失败时走降级分支。
