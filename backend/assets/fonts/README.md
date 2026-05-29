# 名牌烧录字体

合辑导出左下角「玩家信息卡」使用本目录字体（由 `env_utils.resolve_name_card_font*` / `resolve_rajdhani_fonts` 加载）。

| 文件 | 用途 |
|------|------|
| `Rajdhani-SemiBold.ttf` | 英文眉标 / chip / RESULT 标签（600） |
| `Rajdhani-Bold.ttf` | 英文玩家名 / RESULT 数值（700） |
| `NotoSansSC-Medium.ttf` | 中文眉标 / chip（600） |
| `NotoSansSC-Bold.ttf` | 中文玩家名 / 战绩（700） |

缺文件时回退到系统 CJK 字体（Windows 微软雅黑等），Rajdhani 缺失则英文回退到 CJK 字体。
