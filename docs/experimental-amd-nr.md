# 实验档：游戏内神经重画录制（AMD 专用）

> **这是什么**：录制队列页里的可选实验功能。勾选后，本次录制不再走 OBS，而是调用
> **CIAP Pro 的 HLAE 1000fps 后端**抓帧，并在 CS2 内注入 ReShade + OpenNR 做**逐帧神经重画**，
> 抓完自动 FrameMeld 到 60fps、按参考片做亮度锁源、最后 x265 10bit 封装。
>
> **代价**：一条 9 秒片段约 **11–12 分钟**（约常规录制链路的 3.5–5 倍），需要 AMD 显卡 +
> CIAP Pro 已安装 + 手动放置第三方运行时文件。
>
> **默认关闭**。关闭时行为与原来完全一致（OBS 录制，0 注入 0 Hook）。

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| 显卡 | AMD RDNA3 / RDNA4（本项目在 RX 9070 XT 上验证）。需要 `amdhip64_7.dll`（新驱动自带） |
| 录制后端 | **CS2 Insight Agent Pro 2.7.7.3+**（本模块只调用它的本地 HTTP API `127.0.0.1:19871`） |
| CS2 | 能正常以 `-insecure` 启动 demo 回放（Pro 自带 HLAE 运行时） |
| ffmpeg | FrameMeld 版 ffmpeg（需支持 `-framemeld`）；可用 `ffmpeg_path` 或 `CS2_NR_FFMPEG` 指定 |
| 磁盘 | 每条片子抓帧约 1.2 GB / 9 s，外加 FrameMeld 中间片；建议留 10 GB 以上 |
| 运行时 | `runtime/` 7 个文件（见下），放在 `data/experimental-nr-runtime/` 或 `CS2_NR_RUNTIME_DIR` |

### 运行时文件（`data/experimental-nr-runtime/`）

| 文件 | 说明 |
| --- | --- |
| `dxgi.dll` | ReShade 6.8.0（add-on 版），改名成 `dxgi.dll` 注入 |
| `ReShade.ini` | 至少包含 `[ADDON] AddonPath=.\` |
| `ReShade_advancedfx.addon` | advancedfx 桥（让 HLAE 抓帧路径经 ReShade 效果链） |
| `amd-nr.addon64` | OpenNR add-on（ReShade API 20） |
| `amd-nr.ini` | OpenNR 参数，见下文推荐值 |
| `dlssnr_amd_pass1.dll` | danielblnc 运行时（add-on 会校验 build 指纹） |
| `dlssnr_on_amd_weights.bin` | 网络权重（147 MB） |

> **授权提醒**：`dlssnr_amd_*` 为 Daniel Blanco 的「DLSS-NR on AMD」运行时（All rights reserved，
> 经作者许可原样分发，保留署名）；`amd-nr.addon64` / `ReShade_advancedfx.addon` / ReShade 本体 /
> FrameMeld ffmpeg 各自遵循其上游许可（MIT / GPL-3.0）。**本仓库不附带这些二进制**，
> 请自行从上游获取并遵守其许可；本模块只做调用与编排。

### 推荐 `amd-nr.ini`

```ini
[amd-nr]
StartOn=1
ToggleKey=120
ToggleMods=0
DisableOnAltTab=0
Scale=1
Passes=2
Intensity=1
Structure=1
Tone=0.5
ColourStrength=0.35
ResidualLimit=0.12
Guard=2
Bicubic=1
OutputSmooth=0.95
OutputSmoothLimit=20
Temporal=2
FixedSeed=1
History=1
Motion=1
DebugView=0
```

> 只写部分键会沿用默认值；`[amd-nr]` 段头不能省。`Passes=2` 是画质/耗时折中，
> `Tone=0.5` + `ColourStrength=0.35` 用于贴合原片饱和度。

## 2. 配置

`config.experimental`（`data/config.json`）字段：

| 字段 | 说明 |
| --- | --- |
| `nr_runtime_dir` | 运行时目录；留空 = `data/experimental-nr-runtime` |
| `nr_capture_dir` | 抓帧输出目录；留空 = `data/nr-captures` |
| `nr_pro_exe` | CIAP Pro 可执行文件；留空自动探测（`LOCALAPPDATA/Programs/...`） |
| `nr_pro_data_dir` | Pro 数据目录（找 `native-recording-jobs/*/request.json`）；留空 = `%APPDATA%\CS2 Insight Agent\data` |
| `nr_pro_base` | Pro HTTP 地址；留空 = `http://127.0.0.1:19871` |

对应环境变量（优先级高于 config）：`CS2_NR_RUNTIME_DIR`、`CS2_NR_CAPTURE_DIR`、`CS2_NR_PRO_EXE`、
`CS2_NR_PRO_DATA`、`CS2_NR_PRO_BASE`、`CS2_NR_CS2_EXE`、`CS2_NR_FFMPEG`。

固定路径：日志写 `data/logs/experimental-amd-nr-*.log`，临时 staging 清单写
`<CS2>/game/bin/win64/.cs2insight-staging.json`（卸载时删除）。

## 3. 使用

1. 启动 CIAP Pro（面板里的「检测环境」会尝试自动拉起）。
2. **录制队列**页：把回合合集片段加进队列 → 勾选底部「游戏内神经重画」→ 自动检测环境。
3. 环境就绪后点「开始实验档录制」：抓帧期间请勿操作鼠标键盘、不要切窗口（ReShade 需要前台渲染）。
4. 完成后面板显示交付片路径与日志路径；成片在 `data/nr-captures/`，同时保留原始 take。

HTTP 接口（`backend/app/recording/api.py`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/recording/experimental-nr/status` | 环境探测（含 `available` / `missing` / `gpus` / 路径） |
| POST | `/api/recording/experimental-nr/prepare` | 探测并尝试拉起 Pro |
| POST | `/api/recording/experimental-nr/start` | body：`demo_path`、`output_path?`、`start_tick`、`end_tick`、`dry_run`、`postprocess`、`luma_lock`、`timeout_sec` |

## 4. 管线

```
Pro(HLAE 1000fps) ──> NR take (1000fps, ReShade+OpenNR 已烘焙)
                     │
                     └─> 参考 take (StartOn=0, 同窗口)
NR take ──FrameMeld(1000→60, blur 0.35)──┐
参考 take ──FrameMeld(1000→60)───────────┴─> 亮度锁源(Y 通道 clip) ──> x265 10bit CRF18 ──> 解码自检
```

- **staging**：抓帧前把运行时 7 个文件拷进 CS2 `bin/win64`（同名先备份为 `.cs2insight-bak`），
  结束后删除注入物与 add-on 生成物、还原备份，并另存 `ReShade.log`/`amd-nr.log` 到本模块日志旁。
- **参考片 + 亮度锁源**：两次独立抓帧帧数会差几帧，`estimate_offset()` 按内容对齐后再逐像素
  把 NR 的 Y 钳在参考片 ±5/255（色度保留 NR），实测把静止区亮度抖动从 `temp_std≈14` 压到 `≈1.6`。
- **混合**：FrameMeld `--blur-amount 0.35`（126° 快门），避免默认 360° 快门在静步时拖影过重。

实测（RX 9070 XT / 9 s 窗口 / Passes=2）：

| 阶段 | 耗时 |
| --- | --- |
| NR 抓帧（1000fps） | 275 s |
| 参考片抓帧 | 275 s |
| FrameMeld ×2 | 31 s + 30 s |
| 亮度锁源 | 24 s |
| x265 + 自检 | 62 s |
| **合计** | **≈ 11.7 min** |

## 5. 风险与边界

- **反作弊**：抓帧依赖注入第三方 DLL 并写 CS2 安装目录，只应在**本地 `-insecure` demo 回放**里用。
  不要带这套文件进入联机对局（VAC 风险）。
- 实验档运行期间 CS2 目录不是原始状态；若进程被强杀，staging 可能残留：
  删除 `bin/win64` 里上表 7 个文件 + `amd-nr*` 生成物，把 `.cs2insight-bak` 改回原名即可。
- 抓帧对前台敏感：切窗口/锁屏会拿到黑帧或中断。
- 网络只在 1080p tier 训练，1440p 属于外推；本项目用 tiling 离线管线做定稿，**实验档定位是"快速看效果/草稿"**，
  最终交付建议仍走离线 v12 管线。
- 输出为 HEVC Main10；部分老播放器/社交平台不吃，需要 H.264 时请自行转码。

## 6. 排障

| 现象 | 处理 |
| --- | --- |
| `missing` 含 `AMD_GPU` | 非 AMD 显卡，或驱动未装 HIP 7 |
| `missing` 含 `CS2_EXE` | 设置里指定 CS2 路径，或设 `CS2_NR_CS2_EXE` |
| `missing` 含 `NR_RUNTIME` | 运行时 7 文件不全，见 §1 |
| `missing` 含 `PRO_AGENT` | 启动 CIAP Pro；`nr_pro_exe` / `CS2_NR_PRO_EXE` 指到 exe |
| `PRO_UNREACHABLE` | Pro 没起或端口不同（改 `nr_pro_base`） |
| `PRO_HTTP_ERROR 422` | `request.json` 模板与 Pro 版本不匹配；升级 Pro 或清掉旧的 `native-recording-jobs` |
| 抓完画面没变化 | 检查 `amd-nr.log` 是否有 `frame N processed`；`StartOn=0` 时不会重画 |
| 频闪明显 | 已默认开亮度锁源；可再调 `OutputSmooth`/`ResidualLimit`，或后期加时域降噪 |
