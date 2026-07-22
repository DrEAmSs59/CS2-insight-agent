# AI OBS 调优 Agent 方案

> 状态：首个端到端版本已实现，包括自动连接、结构化 AI 评估、变更确认、Profile 备份、配置写入与回读、短录制、ffprobe/Stats/日志验收，以及用户触发的安全恢复。  
> 目标：在 AI 洞察模式下，用可审计、可回滚的流程完成 OBS 录制参数访谈、变更、短录制和成片验收。

## 1. 结论

这个功能值得做，但不建议把用户提示词原样交给一个拥有任意 Shell/文件权限的通用 Agent。更稳妥的落地方式是：

- **LLM 只负责理解目标、追问缺失信息和解释结果**；
- **策略引擎负责把目标转换成有类型的 OBS 变更计划**；
- **本机执行器只暴露白名单工具**，例如探测、备份、设置视频参数、设置录制编码器、短录制、ffprobe、日志分析和回滚；
- 任何写操作都必须经过“快照 → 计划差异 → 用户确认 → 应用 → 回读 → 真实录制验证”；
- “设置为 480 FPS”与“稳定获得 480 FPS 素材”是两个不同结论，后者必须同时通过 OBS Stats/日志和录制文件验收，不能只看 UI 或 `r_frame_rate`。

因此产品名称可以是“AI OBS 调优”，但核心执行链路应当是确定性的，不依赖模型自由生成命令。

## 2. 当前项目能力审计

| 能力 | 当前状态 | 缺口 |
|---|---|---|
| OBS 安装探测 | `env_utils.detect_obs_path()` 已覆盖注册表、卸载项和常见安装结构 | 状态接口没有统一返回安装来源、版本、便携版标记 |
| WebSocket 连接 | `/api/obs/config-check` 可拉起 OBS、重试连接并保存验证状态 | AI 调优面板尚未调用启动流程，也没有处理服务未启用、认证不匹配和端口冲突 |
| 视频设置读取 | `GetVideoSettings` 已读取并向调优接口暴露画布、输出、FPS 分子/分母 | 仍需使用 `GetVersion.availableRequests` 做逐项能力协商 |
| 视频设置修改 | `calibrate()` 已用 `SetVideoSettings` 修改分辨率并回读 | 当前固定对齐主显示器；没有目标方案、差异预览和精确 FPS 配置入口 |
| 场景与捕获源 | 已创建专属场景和 Game Capture，并可铺满画布 | Scene Collection 仍是共享资源，需要明确哪些源可改、哪些只读 |
| 编码器处理 | 检测到“与串流一致”时会填写一个硬件编码器 ID | 当前优先级是静态字符串，未证明 GPU、OBS 插件与所选编码器真的可用 |
| Profile 备份 | `_create_backup()`、列表、恢复、删除 API 已存在 | `calibrate()` 当前没有在修改前调用备份；备份也缺少文件校验和与计划关联 |
| 专属 Profile | 已有 `issue-65-dedicated-obs-profile.md` 设计 | 尚未在录制开始/结束链路实现切换、崩溃恢复和启动对账 |
| 短录制验证 | 录制控制器已有 Start/Pause/Stop 能力 | 配置中心没有独立的调优测试录制任务 |
| 成片验证 | 项目已有 FFmpeg 路径探测 | 没有面向调优结果的 ffprobe 结构化报告 |
| 稳定性判断 | 无 | 未采集 `GetStats` 前后差值，未解析 encoding/rendering lag，也未给出降级建议 |

当前最需要先修正的安全问题是：`calibrate()` 会直接修改当前活动 Profile，且修改前没有调用已有的 `_create_backup()`。在 AI 调优功能上线前，应优先完成专属 Profile 隔离或至少补齐强制备份与恢复闭环。

## 3. 产品边界

### Agent 可以做

1. 探测 OBS、当前 Profile、OBS/obs-websocket 版本、GPU、驱动暴露的编码能力和 FFmpeg/ffprobe。
2. 询问目标分辨率、FPS、画质优先级、磁盘预算和测试时长。
3. 生成明确的“当前值 → 目标值”计划，并解释风险。
4. 在用户确认后操作 **CS2 Insight 专属 Profile**。
5. 做短录制、回读、ffprobe 和日志/Stats 验收。
6. 如果不稳定，报告瓶颈并给出按影响从小到大的调整建议。
7. 回滚本次会话的改动。

### Agent 不可以做

- 修改或清空 WebSocket 密码；
- 修改音频采样率、声道、设备、监听方式或音轨映射；
- 修改用户的直播 Profile、直播服务、串流密钥或场景集合；
- 在 OBS 有活动输出时切换 Profile 或改视频/编码参数；
- 静默降低用户指定的 FPS、分辨率或画质目标；
- 自动更新驱动、重装 OBS、下载插件或改项目代码；
- 执行模型生成的任意 Shell 命令或任意路径写入。

## 4. 推荐架构

```text
用户
  ↓ 目标与回答
OBS Tuning Agent（LLM：理解 / 追问 / 解释）
  ↓ 结构化 GoalSpec
Policy + Planner（确定性规则、能力矩阵、风险门禁）
  ↓ 带哈希的 ChangePlan
用户确认
  ↓
Local OBS Tool Broker（白名单工具、路径约束、会话锁）
  ├─ Discovery：OBS / Profile / GPU / Encoder / FFprobe
  ├─ Snapshot：配置快照、备份、受保护字段指纹
  ├─ Apply：WebSocket 优先，停机文件修改仅作受控降级
  ├─ Verify：回读 / 短录制 / ffprobe / GetStats / 日志
  └─ Rollback：恢复 Profile、切回原 Profile、写审计报告
```

Agent 输出必须先通过 Pydantic/JSON Schema 校验。执行器只接受枚举化动作，例如：

```json
{
  "action": "set_video_settings",
  "profile": "CS2 Insight Recording",
  "fps_num": 480,
  "fps_den": 1,
  "base_width": 1920,
  "base_height": 1440,
  "output_width": 1920,
  "output_height": 1440
}
```

不提供 `run_command`、`write_file`、`delete_path` 这类通用工具。

## 5. 会话状态机

```text
DISCOVERING
  → NEEDS_INPUT
  → PLAN_READY
  → AWAITING_APPROVAL
  → SNAPSHOTTING
  → APPLYING
  → READBACK_VERIFYING
  → TEST_RECORDING
  → MEDIA_VERIFYING
  → STABILITY_VERIFYING
  → PASSED | DEGRADED | FAILED
                 ↘ ROLLING_BACK → ROLLED_BACK
```

关键门禁：

- `PLAN_READY` 之后计划必须带 `plan_hash`；批准的哈希与执行时不一致就拒绝执行。
- 发现直播、录制、Replay Buffer 或 Virtual Camera 正在输出时，禁止切 Profile 或修改关键参数。
- 直接改 INI 之前必须确认 OBS 已正常退出，并再次检查进程与文件修改时间。
- 应用后必须重新连接和回读，不能把请求成功等同于配置生效。
- 任一步骤失败都保留快照和报告；只对本会话实际修改的内容执行回滚。

### 5.1 OBS 启动与 WebSocket 自愈

AI 面板的只读 Discovery 不应隐式启动桌面程序。建议在用户首次点击“让 Agent 准备 OBS”时确认一次，之后允许记住“进入 AI 调优时自动准备 OBS”的偏好。准备流程由确定性执行器负责，不由 LLM 拼接命令：

```text
DETECT_INSTALL
  → OBS_RUNNING? ── no → INSPECT_WS_CONFIG → LAUNCH_OBS
       │ yes                         │
       └─────────────────────────────┘
                     ↓
              CONNECT_WITH_RETRY
                → CONNECTED
                → NEEDS_PASSWORD
                → NEEDS_SAFE_RESTART
                → PORT_CONFLICT
                → UNSUPPORTED_VERSION
```

处理规则：

1. 安装路径存在且 WebSocket 已配置时，复用现有 `/api/obs/config-check` 的进程锁、启动和连接重试能力；AI 面板目前缺少的就是这一层编排。
2. OBS 未运行且 WebSocket 服务关闭时，可以先备份 `plugin_config/obs-websocket/config.json`，只启用服务并保留当前端口、认证方式与密码，然后启动 OBS、连接并回读验证。
3. OBS 正在运行但无法连接时，不直接覆盖 WebSocket 配置文件。Agent 先判断密码错误、端口冲突或服务关闭；确需离线修改时，要求用户批准正常关闭并重启 OBS。
4. 认证已开启但项目没有正确密码时，询问现有密码；不得关闭认证、读取后回显密码或擅自轮换密码。官方也建议保持密码认证。
5. 默认只连接本机地址；不得为了连接成功自动开放防火墙、绑定公网地址或把密码放进可见的命令行参数。
6. OBS 28 及以上内置 obs-websocket；旧版本缺少兼容插件时只报告阻塞，不自动下载、安装或升级。

第一版 `POST /api/obs-tuning/bootstrap` 已实现，返回逐步事件和最终状态；它只负责安装探测、受控启动、WebSocket 连接与必要的停机配置修复，不修改 Profile、视频、音频、场景或直播设置。前端首次使用需要点击“启动并连接 OBS”，之后可保存“进入 AI 调优时自动准备 OBS”的偏好。成功后再进入调优会话。

## 6. Profile 与备份策略

推荐最终使用固定的专属 Profile，例如 `CS2 Insight Recording`，并复用当前 Scene Collection，避免触碰用户的直播编码配置。

首次创建仍需做一次本机兼容性验证：不同 OBS 版本中，`CreateProfile` 创建内容、Profile 切换后的输出管线重载、以及 `SetProfileParameter` 的热生效行为不能靠假设。应先用 `GetVersion.availableRequests` 探测请求可用性，再进行最小实验。

建议顺序：

1. 读取当前 Profile 名、视频设置、录制输出设置和受保护字段摘要。
2. 创建全量备份，manifest 中记录 `session_id`、`plan_hash`、OBS 版本、Profile、每个文件的 SHA-256。
3. 若专属 Profile 已存在，只更新允许字段；若不存在，使用经过当前 OBS 版本验证的创建策略。
4. 应用前记录原 Profile 到持久化恢复状态文件。
5. 在 `finally`、应用启动对账、录制中止三条路径都尝试切回原 Profile。

受保护字段在应用前后做规范化指纹比对：音频采样率、声道、全局音频设备、音轨映射、串流服务、串流密钥引用、WebSocket 设置、Scene Collection 名称。任何非预期变化都将会话标记为失败并提示回滚。

## 7. 480 FPS 的专门处理

### 7.1 配置目标

- 通过 `SetVideoSettings` 设置 `fpsNumerator=480`、`fpsDenominator=1`；
- 保留用户当前画布/输出分辨率作为默认方案；
- 只有用户明确选择 4:3 高帧方案，才把目标设为 1920×1440；
- NVENC 仅在“OBS 确认可创建编码器 + 短录制成功”后标记为可用，不能只根据显卡品牌判断；
- 本地高帧录制优先质量型恒定量化策略，但具体编码器参数必须按 OBS 版本和编码器能力模板生成，不能硬编码一个跨显卡通用值。

### 7.2 验收不能只看 ffprobe

`r_frame_rate=480/1` 只说明码流/容器声明的帧率。即使 OBS 重复帧或丢失了渲染帧，这个字段仍可能正确。因此至少需要四层证据：

1. **OBS 回读**：FPS 分子/分母、画布、输出和 Profile 均符合计划。
2. **媒体结构**：ffprobe 返回分辨率、codec、encoder tag、音轨数量、`r_frame_rate`、`avg_frame_rate`、时长和 `nb_read_frames`。
3. **OBS 稳定性**：测试前后读取 `GetStats`，计算 rendering skipped frames 和 output skipped frames 的增量；同时解析对应 OBS 日志段。
4. **有效帧证据**：`nb_read_frames / duration` 接近 480，并在可选的深度测试中抽样检测重复帧比例；若 CS2 实际渲染帧率低于 480，必须说明“文件为 480 FPS 时间基，但不代表 480 个独立游戏画面/秒”。

建议默认做 10 秒快速测试；要声称“稳定”，再做 60 秒确认测试。阈值应由产品明确配置，而不是由 LLM临时决定，例如：

- `render_skipped_delta / rendered_delta <= 0.1%`
- `output_skipped_delta / output_total_delta <= 0.1%`
- `abs(nb_read_frames / duration - 480) <= 0.5`
- OBS 日志中无 encoder overload，且没有连续的 rendering/encoding lag 峰值

阈值未通过时状态应是 `DEGRADED`，并保留原目标。最小调整建议按顺序给出：减少专属场景负担 → 调整编码器 preset/tuning → 限制 CS2 为 OBS 预留 GPU → 用户确认后降低输出分辨率 → 最后才建议降低 FPS。Agent 不得自动执行这些降级。

### 7.3 FPS 自定义与硬件推荐引擎

FPS 不应只提供固定的 60/120/240/480 四档。前端可以把这些值作为快捷预设，同时允许用户输入 1–1000 的任意整数；后端仍统一保存为 `fps_num=<用户值>`、`fps_den=1`。自定义值必须经过整数、范围、OBS 请求能力和后处理链兼容性校验。

“会不会卡”的回答不能由 LLM凭显卡型号拍脑袋生成。推荐程度应来自确定性的 `HardwareRecommendation`，LLM只负责把结果解释给用户。建议输入包括：

- CPU、GPU、内存、可用 NVENC/QSV/AMF 编码器实例与能力；
- 画布/输出分辨率、目标 FPS、编码器、preset、色彩格式和场景复杂度；
- CS2 基准测试的平均值与 P10/P1 低位帧率，不能只看峰值 FPS；
- 短录制得到的 rendering/encoding lag、GPU 编码负载、磁盘写入和文件码率；
- 用户用途：慢动作分析、高光成片或长时间素材归档。

推荐输出至少包含：

```json
{
  "grade": "cautious",
  "score": 74,
  "summary": "可以尝试，但必须先做短录制",
  "predicted_bottleneck": "obs_render_thread",
  "estimated_render_load_pct": 82,
  "estimated_encoder_load_pct": 68,
  "estimated_disk_gb_per_10min": [18, 36],
  "risk_reasons": ["单帧预算只有 2.08ms", "CS2 P10 接近目标 FPS"],
  "safer_alternative": {"width": 1920, "height": 1080, "fps_num": 360, "fps_den": 1},
  "confidence": "preflight_estimate"
}
```

推荐等级建议使用“推荐 / 可以尝试 / 探索性 / 不推荐直接使用”，同时显示依据与备选方案。应用前的分数必须明确标注为预测；完成短录制后，再用实测数据校正推荐并说明预测是否准确。不能把一个看似精确的百分比分数包装成硬件保证。

## 8. 后端 API

当前端到端版本使用以下接口：

| API | 用途 |
|---|---|
| `GET /api/obs-tuning/discovery` | 读取 OBS 安装、连接、Profile、精确 FPS、GPU/硬件编码候选、磁盘与 FFmpeg 状态；不返回密码 |
| `POST /api/obs-tuning/recommendation` | 根据目标和环境快照返回预测分、负载、风险、容量和保守起点 |
| `POST /api/obs-tuning/plan` | 重新探测环境，生成带 `plan_hash`、阻塞项、受保护字段和安全门禁的只读计划 |
| `POST /api/obs-tuning/bootstrap` | 识别并启动 OBS；仅在 OBS 未运行时备份并启用 WebSocket，随后重试连接；不修改认证、密码、Profile、音频、场景或直播配置 |
| `POST /api/obs-tuning/apply` | 重新校验计划和活动输出状态，备份 Profile，写入并回读视频/录制设置，完成短录制、ffprobe、Stats 与日志验收；不达标时不静默降级 |
| `POST /api/obs-config/backups/{backup_id}/restore` | 在确认 OBS 已正常退出后恢复对应备份，避免运行中覆盖配置文件 |

推荐接口先进行确定性计算；计划接口会把脱敏后的目标、硬件快照和规则建议交给已配置的大模型做结构化复核与解释。如果没有可用模型或调用失败，会明确标记为本机规则回退，不伪装成 AI 结果。模型没有 Shell、文件或 OBS 工具权限，执行器也不会运行模型生成的命令。Bootstrap 的唯一离线配置写入是把既有 `server_enabled` 改为 `true`，并在写入前保存原文件备份；密码永不出现在接口响应中。

后续执行闭环采用会话 API：

| API | 用途 |
|---|---|
| `POST /api/obs-tuning/sessions` | 创建会话并开始只读探测 |
| `GET /api/obs-tuning/sessions/{id}` | 获取状态、探测结果、问题和进度 |
| `PUT /api/obs-tuning/sessions/{id}/goal` | 提交用途、分辨率、自定义整数 FPS、编码/画质偏好、测试时长 |
| `GET /api/obs-tuning/sessions/{id}/recommendation` | 返回硬件感知的推荐等级、风险、预计瓶颈和保守备选方案 |
| `POST /api/obs-tuning/sessions/{id}/plan` | 生成确定性变更计划和风险说明 |
| `POST /api/obs-tuning/sessions/{id}/approve` | 以 `plan_hash` 明确批准 |
| `POST /api/obs-tuning/sessions/{id}/apply` | 执行备份、应用、回读和测试 |
| `GET /api/obs-tuning/sessions/{id}/events` | SSE 推送步骤、日志摘要与需要用户处理的门禁 |
| `POST /api/obs-tuning/sessions/{id}/abort` | 中止尚未完成的测试并安全收尾 |
| `POST /api/obs-tuning/sessions/{id}/rollback` | 恢复本会话备份 |
| `GET /api/obs-tuning/sessions/{id}/report` | 返回最终结构化报告 |

建议把报告持久化到 `data/obs_tuning/<session_id>/`，保存 `snapshot.json`、`plan.json`、`events.jsonl`、`ffprobe.json`、`stats.json` 和 `report.json`，但不保存 WebSocket 密码或其他密钥。

## 9. 前端信息架构

不新增独立的设置入口卡片，也不改变“设置 → 视频”的整体骨架。AI 洞察关闭时，OBS 可执行文件、WebSocket 和一键校准保持原样；开启时，只把这些 OBS 专属区域替换成内嵌的 Agent 调优面板。FFmpeg 可执行文件与合辑编码器始终放在 Agent 面板上方，作为全局工具独立保留：它们既服务合辑导出，也用于调优后的媒体校验，不属于 Agent 的 OBS 修改范围。高风险的执行、测试和回滚详情仍使用独立流程页面。

1. **目标确认**：展示只读探测结果，询问素材用途、分辨率、预设/自定义 FPS、编码器、画质优先级和测试时长；参数变化时实时刷新硬件推荐程度。
2. **变更预演**：逐项展示当前值、目标值、修改方式、是否需要重启，以及明确不触碰的字段；并同时保留“用户目标方案”和“Agent 保守起点”。
3. **执行进度**：以状态机时间线展示备份、应用、回读、短录制、ffprobe 和日志分析。
4. **验收报告**：区分“配置已生效”和“稳定性已通过”，给出备份位置、测试文件、证据、瓶颈与可选择的下一步。

条件界面预览路由：`/obs-ai-entry-preview`，可比较“原始 OBS 设置”与“内嵌 Agent 面板”，并验证 FFmpeg 在两种模式下保持原位。完整调优流程预览路由：`/obs-ai-preview`。页面内的所有设备信息和结果均为模拟数据，并有明显标记；不会调用真实 OBS API。

## 10. 推荐实施顺序

1. **P0 安全地基**：让现有 `calibrate()` 强制创建备份；状态接口保留 `fps_num/fps_den`；补活动输出 guard。
2. **P0 兼容性探针**：验证专属 Profile 创建/切换/热生效，完成 issue #65 的状态文件和崩溃对账。
3. **P1 只读 Discovery**：GPU、OBS availableRequests、编码器候选、ffprobe、磁盘与当前设置快照。
4. **P1 计划与审批**：GoalSpec、ChangePlan、plan hash、受保护字段指纹。
5. **P1 应用与回读**：白名单执行器、回滚、SSE 事件。
6. **P2 验收闭环**：短录制、ffprobe、GetStats、OBS 日志切片与结构化报告。
7. **P2 Agent 对话层**：把已有提示词拆为系统策略、用户目标和报告模板，让 LLM 只调用上述工具。

## 11. 参考

- [obs-websocket 5.x 协议](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
- [OBS Encoding Performance Troubleshooting](https://obsproject.com/kb/encoding-performance-troubleshooting)
- 项目已有设计：[`issue-65-dedicated-obs-profile.md`](./issue-65-dedicated-obs-profile.md)
