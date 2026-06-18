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

<h3 align="center"><b>CS2 洞察智能体：为 CS2 玩家打造的桌面端智能电竞终端</b> </h3>
<h4 align="center"> Demo 管理，高光提取，自动剪辑，LLM 锐评</h4>

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
- **目录自动监听** — 支持 5E / 完美 / 官匹 demo / faceit 等 Demo 下载目录的监听，一键自动入库。

### 高光解析与片段挖掘

- **批量 Demo 解析** — 支持同时解析大量 Demo 的高光时刻，同一玩家在多场 Demo 中的高光会按场次组织展示。
- **目标玩家锁定** — 自动识别对局内全部玩家，按 Steam ID、平台 ID 或昵称定位目标，兼容 5E、完美世界、官匹等不同 Demo 导出习惯。
- **细粒度高光分析** — 自动分出 **高光**（多杀、颗秒、残局、刀杀、跳杀、拆包等）、**下饭**（电击枪、沙鹰、队友误伤及「人肉吸铁石」「人体描边」「肩并肩」等名场面）、**跨回合合集**（亲儿子喂饭、本命苦主、全场击杀/死亡串烧、按回合连续录制），以及 **梗局**（211 / o / i / z 系列研发标签，可配 AI 整局总评）。标签说明见 [片段类型与标签](./docs/highlight_tags.md)。
- **回合时间线** — 除自动挖出的片段卡片外，可按回合浏览击杀/死亡时间线，把某一枪、某一死或整回合画面直接加入录制队列。
- **回合连续录制** — 支持从回合开局录到死亡或回合结束，可勾选若干回合拼成一条长片。

### 自动录制

- **批量录制队列** — 多场比赛、多个片段排队，程序依次启动 CS2 回放并驱动 OBS 成片；录制前可预览整批计划，队列里也可微调每段的节奏。
- **录制前观战设置** — 一键配置观战 HUD（仅死亡通知、隐藏 ID/聊天/Demo 条）、视野与持枪角度、闪光亮度、语音、分辨率与画幅、片段之间的 OBS 转场等；本场也可临时打开实验性 POV 第一人称 HUD。
- **多样化成片风格**：
  - 裁判视角或 POV 第一人称 HUD（可隐藏/显示雷达、调整正上方人数条）
  - 纯净观战画面、自定义 FOV、隐藏投掷物轨迹
  - **受害者视角** — 高光或多杀合集可在你的主视角之后，自动追加被击杀者视角片段
  - **按键显示叠加** — 在 OBS 里叠加 WASD、蹲跳等按键提示，与画面不同步时可手动微调
  - 片段之间淡入淡出等转场
- **安全录制方案**：
  - 通过 OBS 与游戏状态联动控制录制，不注入、不 Hook 游戏进程
  - 自动备份并在录制结束后恢复你的键位与画面设置


### 合辑工作台

- 录制成功的片段自动入库，可在合辑工作台拖拽排序、配 BGM / 转场主题，导出 MP4；支持按高光/下饭/合集/时间线等类型筛选，以及片头片尾编排。
- **玩家信息卡** — 导出时可开启左下角名牌：每段画面开头短暂显示该片段对应玩家昵称、高光/下饭/合集类型、回合与情景标签（如多杀、颗秒等）；可为时间线里出现的每位玩家单独上传头像，不上传则显示昵称首字。适合 B 站式集锦片头标注，无需后期在 PR 里逐条加字。
- **使用前需配置 FFmpeg**：前往 [FFmpeg 官网](https://ffmpeg.org/download.html) 或 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载 Windows 构建包，解压后在程序设置页面的「FFmpeg 路径」中填入 `ffmpeg.exe` 的完整路径。导出时会优先使用显卡硬件编码（NVENC / QSV / AMF），没有则使用软件编码。


### AI 锐评（可选）

- **OpenAI 兼容多家厂商** — 内置 DeepSeek、通义 Qwen、智谱 GLM、MiniMax、OpenAI、OpenRouter；本地模型支持 Ollama、LM Studio。
- **毒舌人设 Prompt** — 高光吹爆、下饭嘲讽、梗死亡当段子；硬约束 100 字以内、单行 JSON 输出，不输出场外废话。
- **整局梗合集总评** — 211/o/i/z 系研发局会触发「整局综合评价」，独立于片段级评分。

---

## 安装

前往 [Releases 页面](https://github.com/DrEAmSs59/CS2-insight-agent/releases) 下载最新的 `CS2-Insight-Agent-Setup-x.x.x.exe`，双击运行安装包，按提示完成安装。

安装完成后从桌面或开始菜单启动程序，**无需打开浏览器，无需手动启动后端**，Electron 主进程会自动在内部启动 Python 后端服务。

程序内置**在线更新**功能：启动时会自动检测是否有新版本，有更新时右上角会弹出提示，点击即可在程序内完成下载和安装，无需手动重新下载安装包。

> **建议安装路径不含中文字符。** 例如 `D:\CS2-Insight-Agent\` ✅，`D:\游戏工具\CS2-Insight-Agent\` ❌

---

## Roadmap

- **V1**
   - [X] 高光解析
   - [X] AI 锐评
   - [X] 全自动导播
- **V2**
   - [X] Electron 桌面端、程序内在线更新
   - [X] 合辑工作台（FFmpeg 导出）
   - [X] POV HUD 实验性功能
   - [X] 回合时间线浏览与入队录制
   - [X] 录制前观战预热 / 受害者 POV / 虚拟键盘 OBS 叠加
- **V3**
   - [ ] Demo 图分析
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
