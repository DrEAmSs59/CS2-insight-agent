# Normal 雨滴外观与精细雨区

2026-09-17 从 weather-effects 的已验收 `mirage-rain-master-v1` 和当前七图预览分离。
移植范围只有空中雨滴外观、雨粒子宿主及其覆盖范围。

| 雨滴参数 | 数值 |
| --- | --- |
| 颜色 / 混合 | RGBA 255 / 255 / 255 / 255；`PARTICLE_OUTPUT_BLEND_MODE_ALPHA` |
| 不透明度 | 0.423225–0.577125 |
| 亮度倍率 / 宽度倍率 | 1.8 / 0.5 |
| 源 alpha 映射零点 / 满值 | 0 / 0.22 |
| 尾长 | 2–20 |
| 初始 Z 速度 / 重力 Z | -400 / -500 |
| 单宿主发射率 / 生成半径 | 16 / 64 |

`rain_single_128.vpcf_c` 与冻结母版及当前七图预览的同名粒子逐字节一致。
大小 2359 字节，SHA256：
`8886c3d877b41a27b14dcce350f1839dd14d2a7802783c24a2be99e466382191`。
母版于 2026-09-12 获用户视觉确认；本次 normal 组合未重新做游戏内视觉验收。

| 地图 | 雨宿主数 | 与原 normal 的雨区差异 |
| --- | ---: | --- |
| Cache | 969 | 原 38 个半径 390 的粗雨区，改为当前预览的半径 64 精细雨区 |
| Mirage | 832 | 原有雨宿主与当前预览完全相同，实体文件保留原字节 |
| Dust2 | 385 | 同上 |
| Inferno | 604 | 同上 |
| Ancient | 166 | 同上 |
| Nuke | 221 | 同上 |
| Anubis | 1004 | 同上 |

Cache 按当前原生地图露天列采样，网格间距 80；具体坐标见 `de_cache_regions.json`。
移植时只读取 `weather:rain_*` 的 `path_particle_rope_clientside` 实体，
校验粒子引用和 `max_simulation_time=0`，完整保留 normal 的其余 424 个实体。
七图底图 SHA256 与来源一致。Cache 的地图资源清单重新计算大小、CRC32、输出哈希，
其余六图的实体、所有地图的地面/水洼材质和模型均保留原始字节。

运行时 `backend/app/weather_particle_vpk.py` 校验固定大小和 SHA256，
每图只在外层包中覆盖 `particles/rain_fx/rain_single_128.vpcf_c`。
缺失、损坏或同路径冲突会在安装前报错。正常天气与雪天不使用本目录。
现有 Tauri 和便携包资源复制规则会保留该独立目录。

粒子继续引用游戏自带 `materials/particle/rain_streak.vtex` 和 `rain_impact_single.vpcf`。
本次没有移植地图光源、光影、天空盒、曝光/后处理、闪电宿主/粒子、地面或控制台配置。
normal 原有环境逻辑保持，因此最终屏幕亮度仍受 normal 环境渲染影响。

来源（weather-effects 项目内）：

- 粒子：`artifacts/rain-rework/de_mirage/master-v1/candidate/particles/rain_white.vpcf_c`
- 七图版本：`artifacts/rain-rework/seven-map-current-with-cache-v4/preflight.json`
- Cache 雨区：`artifacts/rain-rework/mirage-standard-storm-v1/de_cache/rain-regions.json`
- 独立提取实现：`tools/extract_normal_rain_particles.ps1`
- 提取规格、原始备份和实体核验：`artifacts/normal-rain-particle-extraction/`

提取脚本把 normal 原实体与来源雨宿主组合，重新解码后核对完整 DATA：
来源雨宿主完全一致，剔除雨宿主后的所有字段与 normal 原文件一致。
脚本不安装游戏文件；本次项目修改也未启动或修改本机 CS2。
