<h1 align="center">
  <br>
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/"><img src="https://raw.githubusercontent.com/DrEAmSs59/CS2-insight-agent/main/frontend/public/cs2-insight-logo.png" alt="CS2-Insight-Agent" width="140"></a>
  <br>
  CS2-Insight-Agent
  <br>
</h1>

<p align="center">
  <img src="./asset/icon-cn.svg" alt="" width="20" height="20" style="vertical-align: middle;"> 简体中文 | <a href="./README_EN.md"><img src="./asset/icon-en.svg" alt="" width="20" height="20" style="vertical-align: middle;"> English</a>
</p>

<h3 align="center"><b>CS2 洞察智能体：一站式 CS2 创作套件</b> </h3>
<h4 align="center">Demo 分析 · 饰品换肤 · OBS 自动录制 · LiteCut 精剪 · LLM 锐评<br>0 注入 · 0 Hook · 0 逆向游戏进程 · 本地回放低风险</h4>

<p align="center">
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/releases">
    <img src="https://img.shields.io/github/v/release/DrEAmSs59/CS2-insight-agent"
         alt="release">
  </a>
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/stargazers">
    <img src="https://img.shields.io/github/stars/DrEAmSs59/CS2-insight-agent.svg"
         alt="Stars">
  </a>
    <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue"
         alt="License">
  </a>
  
</p>

<p align="center">
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/PLAYER_GUIDE.md">使用指南</a> •
  <a href="https://github.com/DrEAmSs59/CS2-insight-agent/blob/main/CONTRIBUTING.md">贡献指南</a> •
  <a href="https://www.bilibili.com/video/BV1PcVj69ExZ/">视频教程</a> •
  <a href="#核心功能">核心功能</a> •
  <a href="#安装">快速安装</a> •
  <a href="#支持项目">支持项目</a> •
  <a href="#声明">声明</a> •
  <a href="#License">License</a>
</p>


![screenshot](./asset/output-1080.gif)

<p align="center">
  <a href="https://www.bilibili.com/video/BV1PcVj69ExZ/">▶ 视频教程 BV1PcVj69ExZ</a>
</p>

<h4 align="center">成片展示</h4>

<p align="center">
  <a href="https://www.bilibili.com/video/BV1ZkGi6YENF/">▶ BV1ZkGi6YENF</a> ·
  <a href="https://www.bilibili.com/video/BV1TPGq67EFS/">▶ BV1TPGq67EFS</a>
</p>
<p align="center"><sub>片头片尾 BGM、战队 Logo 由 UP 主自行合成；游戏片段由本项目自动剪辑</sub></p>

<p align="center">
  <a href="https://www.bilibili.com/video/BV1KF5s6nEed/">▶ BV1KF5s6nEed</a> ·
  <a href="https://www.bilibili.com/video/BV1G198BkEHd/">▶ BV1G198BkEHd</a>
</p>
<p align="center"><sub>片头片尾 BGM 及游戏片段均由本项目剪辑合成产出</sub></p>

---

## 核心功能

### Demo 库维护

- **本地库记录展示** — 列表、缩略图展示 Demo 的比赛来源、记分板、关注玩家、展示名、备注等关键信息。
- **目录自动监听** — 支持 5E / 完美 / 官匹 / FACEIT 等 Demo 下载目录监听，一键自动入库。
- **与分析联动** — 可在 Demo 库勾选一场或多场，直接进入 Demo 分析；也可在分析页上传本地 Demo。

### Demo 分析

统一的对局分析工作台：载入后自动解析全场玩家，可在右上角切换本场 Demo，左侧选玩家后浏览其片段与数据。主要视图包括：

- **高光与录制** — 批量解析高光时刻；按 Steam ID / 平台 ID / 昵称锁定目标玩家；自动分出 **高光**（多杀、颗秒、残局、刀杀、跳杀、拆包等）、**下饭**（电击枪、沙鹰、队友误伤及「人肉吸铁石」「人体描边」「肩并肩」等名场面）、**跨回合合集**（亲儿子喂饭、本命苦主、全场击杀/死亡串烧、按回合连续录制），以及 **梗局**（211 / o / i / z 系列研发标签，可配 AI 整局总评），并可直接加入录制队列。标签说明见 [片段类型与标签](./docs/highlight_tags.md)。
- **回合时间线 / 枪械击杀** — 按回合浏览击杀与死亡时间线，把某一枪、某一死或整回合加入队列；支持回合连续录制（开局录到死亡或回合结束，可多回合拼成长片）。
- **2D 回放** — 在本地高速 2D 回放中复盘走位、交火与回合进程，无需先开 CS2。
- **热力图** — 整场走位密度、交战热点、击杀 / 死亡热点；可按玩家、阵营、地图楼层筛选，用于观察站位、转点与失守区域。
- **概览 / 玩家 / 回合 / 经济** — 比赛概览、阵容与个人数据、逐回合走势，以及经济相关信息，方便快速摸清本场结构。
- **饰品与自定义换肤** — 在「饰品」页查看本场 Demo 中实际出现过的武器、刀具、手套、探员等；支持 3D / 游戏内检视。可进入「自定义饰品」，为可换项挑选皮肤（磨损、模板等），保存为自定义皮肤方案，供后续回放与成片使用。  
  > 换肤核心为闭源组件，详见 [License](#License)。

### 自动录制

- **批量录制队列** — 多场比赛、多个片段排队；依次启动 CS2 回放并驱动 OBS 成片；录制前可预览计划，队列内可微调节奏。
- **录制前观战设置** — 一键配置观战 HUD（仅死亡通知、隐藏 ID/聊天/Demo 条）、视野与持枪角度、闪光亮度、语音、分辨率与画幅、片段之间的 OBS 转场等；本场也可临时打开实验性 POV 第一人称 HUD。
- **多样化成片风格**：
  - 裁判视角或 POV 第一人称 HUD（可隐藏/显示雷达、调整正上方人数条）
  - 纯净观战画面、自定义 FOV、隐藏投掷物轨迹
  - **受害者视角** — 高光或多杀合集可在你的主视角之后，自动追加被击杀者视角片段
  - **按键显示叠加** — 在 OBS 里叠加 WASD、蹲跳等按键提示，与画面不同步时可手动微调
  - **击杀特效叠加** — 在颗秒、复仇、穿墙、盲狙、一石二鸟及多杀/残局发生时，由 OBS 自动叠加带透明通道和声音的特效视频
  - 片段之间淡入淡出等转场
- **安全录制方案**：
  - 通过 OBS 与游戏状态联动控制录制，不注入、不 Hook 游戏进程
  - 自动备份并在录制结束后恢复你的键位与画面设置

### 合辑工作台

- 录制成功的片段自动入库；拖拽排序、配 BGM / 转场主题，导出 MP4；可按高光 / 下饭 / 合集 / 时间线等筛选，并编排片头片尾。
- **玩家信息卡** — 导出时可开启左下角名牌：每段画面开头短暂显示该片段对应玩家昵称、高光/下饭/合集类型、回合与情景标签（如多杀、颗秒等）；可为时间线里出现的每位玩家单独上传头像，不上传则显示昵称首字。
- 适合「录完 → 排序 → 一键出片」的轻量合辑流程。

- **FFmpeg 导出配置** — 合辑工作台和 LiteCut 导出都要用到 `ffmpeg.exe`，建议选择下面任意一种：
  - **推荐：[FrameMeld](https://github.com/LiTA8341/FrameMeld) 提供的 FFmpeg** — 到 [Releases](https://github.com/LiTA8341/FrameMeld/releases) 下载最新版本，解压后使用其中的 `ffmpeg.exe`。除了普通导出，还支持补帧、去重和动态模糊。
  - **普通导出：[FFmpeg 9.0 full build](https://www.gyan.dev/ffmpeg/builds/#release-builds)** — 不需要帧混合时可以选这个。下载时认准 **full** 完整版，不要使用 essentials 或其他精简版。
  - **配置方法** — 在程序设置页面的「FFmpeg 路径」中选择解压出来的 `ffmpeg.exe`。导出时会优先使用显卡硬件编码（NVENC / QSV / AMF），不可用时自动改用软件编码。

### LiteCut（多轨精剪）

内置轻量非编：在 Insight 录制成片之上做多轨精剪，也可导入本地素材（需先完成上方推荐的 FFmpeg 配置）。

- **工程管理** — 新建 / 打开 / 复制工程，自定义画布尺寸与帧率；支持模板创建、工程 JSON 导入导出、崩溃恢复。
- **素材池** — 直接使用 **Insight 录制** 片段（按高光 / 下饭 / 合集 / 时间线等筛选），或拖入本地视频、音频、图片、字体；支持预览代理、素材重定位与麦克风配音。
- **多轨时间轴** — 视频轨、音频轨、文字 / 叠加轨；分割、裁切、波纹删除、滑移、编组、音视频链接 / 分离；标记点与吸附；撤销重做与快捷键。
- **包装与调色** — 字幕与文字样式、滤镜 / 色彩校正（电竞、冷暖、夜战等）、固定速度与分段变速、画面与音量关键帧、多种出入转场（淡化、闪白、擦除、故障等）；可保存并复用风格预设。
- **击杀轴** — 录制成片自带的击杀时间点会随裁剪 / 移动 / 变速跟随，用于定位节奏（只读，不参与导出）。
- **导出** — 按工程参数与输出范围导出成片，优先硬件编码。

### AI 锐评（可选）

- **OpenAI 兼容多家厂商** — 内置 DeepSeek、通义 Qwen、智谱 GLM、MiniMax、OpenAI、OpenRouter；本地模型支持 Ollama、LM Studio。
- **毒舌人设 Prompt** — 高光吹爆、下饭嘲讽、梗死亡当段子；硬约束 100 字以内、单行 JSON 输出，不输出场外废话。
- **整局梗合集总评** — 211/o/i/z 系研发局会触发「整局综合评价」，独立于片段级评分。

---

## 安装

前往 [Releases 页面](https://github.com/DrEAmSs59/CS2-insight-agent/releases) 下载最新的 `CS2-Insight-Agent-Setup-x.x.x.exe`，双击运行安装包，按提示完成安装。

安装完成后从桌面或开始菜单启动程序，**无需打开浏览器，无需手动启动后端**。轻量 Tauri 桌面壳会自动启动内嵌 Python 后端，并使用 Windows 系统 WebView2 显示界面。

源码开发需先安装 `uv 0.11.x`，然后运行
`.\packaging\demoparser-lean\setup-backend-dev.ps1`。脚本会依据仓库根目录的
`uv.lock` 创建 Python 3.12 环境并安装经过哈希锁定的依赖。项目的高速 2D
回放使用 PyO3 编译的定制 `demoparser2` Rust 扩展；后端会在启动阶段验证
所需 Rust 接口，不会使用 PyPI 原版解析器静默降级。

依赖边界保持独立：Python 后端使用 `uv`/`uv.lock`，前端与 Tauri JS
工具链使用 `pnpm`/`pnpm-lock.yaml`，Rust 桌面壳使用 `cargo`/`Cargo.lock`；
OBS 与 FFmpeg 仍由各自的运行时集成管理。

当前不运行后台自动更新器；需要升级时，请直接从 [Releases 页面](https://github.com/DrEAmSs59/CS2-insight-agent/releases) 下载新版安装包。

> **建议安装路径不含中文字符。** 例如 `D:\CS2-Insight-Agent\` ✅，`D:\游戏工具\CS2-Insight-Agent\` ❌

---

## Roadmap

- **V1**
   - [X] 高光解析
   - [X] AI 锐评
   - [X] 全自动导播
- **V2**
   - [X] Tauri 轻量桌面端
   - [X] 合辑工作台（FFmpeg 导出）
   - [X] POV HUD 实验性功能
   - [X] 回合时间线浏览与入队录制
   - [X] 录制前观战预热 / 受害者 POV / 虚拟键盘 OBS 叠加
   - [X] Demo 图分析（2D 回放 / 热力图等）
- **V3**
   - [ ] 战术教练（投掷物轨迹分析 / 路线复盘）


### Top contributors:

<a href="https://github.com/DrEAmSs59/CS2-insight-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=DrEAmSs59/CS2-insight-agent" alt="contrib.rocks image" />
</a>


---

## License

本项目采用 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) 协议发布。

- 允许个人学习、研究、爱好、评测及其他非商业用途使用。在遵守本协议的前提下，你可以阅读、修改、构建和分发本项目源码及其衍生版本。
- 未经书面授权，禁止将本项目或其衍生版本用于任何商业用途，包括但不限于：商业软件、付费服务、商业代剪/代录服务、商业平台集成、对外销售、出租、转售或作为商业产品的一部分分发。
  - 商业授权咨询：`dreamss29_@outlook.com`
- 📦 如果你分发本项目的编译产物、安装包或修改版本，请同时保留本项目的许可证声明，并遵守 `THIRD_PARTY_LICENSES.md` 中列出的所有第三方开源组件许可证。
- 🔒 **「Demo 分析 → 饰品」导航栏中的自定义皮肤（换肤）功能为闭源专有组件**，不适用上述开源协议：
  - 范围说明：包括但不限于「自定义饰品 / 自定义皮肤方案」相关的界面能力、皮肤替换与写入逻辑、以及底层闭源组件（如 `skin-core` 等二进制及其配套实现）。开源仓库仅提供调用入口，**不包含**换肤算法与核心实现源码。
  - 权利声明：该功能及其全部闭源实现的知识产权归权利人所有；不以开源形式提供、不授予反向工程许可，亦不因本项目其余部分开源而默示开放。
  - 禁止行为：未经权利人事先书面授权，任何个人或组织不得对该闭源组件进行逆向工程、反编译、反汇编、调试追踪、破解、绕过完整性校验或授权校验、篡改、提取算法/协议/密钥、复制、二次封装、再分发，或以其他任何方式获取、披露、利用其内部实现。
  - 法律后果：一经发现上述行为，权利人有权依法追究行为人的民事、行政乃至刑事责任，并保留要求停止侵害、赔偿损失及其他一切合法救济的权利。商业合作或授权咨询：`dreamss29_@outlook.com`。

## 声明

Counter-Strike 2、CS2、Counter-Strike、Steam、Valve 等名称、商标和标识归其各自权利人所有。

本项目与 Valve Corporation、完美世界竞技平台、5E 对战平台、OBS Studio 及其他相关平台或软件的所有者不存在从属、合作、赞助、授权或背书关系。

### 安全使用提示

- **默认录制流程**调用 CS2 时使用 `-insecure` 仅用于本地 Demo 回放，不存在 DLL 注入或 Hook；不会对磁盘上的 `.dem` 做修改，不连接、不修改、不干预任何官方游戏服务器、匹配服务或反作弊系统，也不提供任何作弊、绕过检测或破坏公平竞技的功能，**不要在已登录匹配服务器的 CS2 客户端中并行使用**，以免触发反作弊系统的不必要警示。
- 若你在「常用参数管理 → 实验性功能」中**主动开启 POV**，程序会临时向 CS2 的 `game/csgo` 目录写入 `pov.vpk`，并**增量修改** `gameinfo.gi` 的 `SearchPaths` 以加载 POV HUD 资源；录制结束或异常收尾时会自动恢复。该模式同样**强制**使用 `-insecure` 启动 CS2，**不要用于连接 VAC 安全服务器**。
- 录制期间会临时修改若干 CS2 archive cvar 与按键绑定。本项目会在启动录制时在程序数据目录的 `.cs2_config_backup` 中**自动备份**玩家原始的 `config.cfg` / `video.txt` / `user_convars_*.vcfg`，录制结束后会回滚；如遇异常退出导致设置被覆盖，可在该目录手动取回原始文件。

---

## 支持项目

如果这个项目帮你节省了剪辑时间，欢迎请我喝一杯咖啡 ☕  
你的支持会用于 Demo 解析、录制兼容性测试和后续功能维护。

<div style="display: flex; justify-content: center; align-items: center; gap: 20px;">
  <img src="asset/wx.jpg" alt="赞助方式1" style="height: 200px;" />
  <img src="asset/ali.jpg" alt="赞助方式2" style="height: 200px;" />
</div>
