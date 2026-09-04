# CS2 创意工坊竞技模式 Demo 地图数据总结

## 1. 结论

CS2 不会把创意工坊地图信息写成一个独立结构。地图数据分散在以下层级：

1. `CDemoFileHeader`：内部地图名、活动 Addon。
2. Signon/`CSVCMsg_ServerInfo`：再次写入地图、Addon 和会话配置。
3. `CSVCMsg_GameSessionConfiguration`：地图名、竞技模式、地图组、阵营模型等。
4. SpawnGroup：主世界、天空盒、Entity Lump、世界偏移和资源清单。
5. StringTables/PacketEntities：资源索引、实体基线和地图实体状态。
6. GameEvent：服务器启动、换图、回合和下一张地图信息。

最重要的两个直接身份字段是：

- `map_name`：引擎实际加载的内部关卡名，不是 Workshop 页面标题。
- `addons` / `addon_name`：回放需要挂载的活动 Addon 标识。

判断一段 Demo 是否来自 Workshop，不能只检查 `map_name`，应联合检查 Addon、会话配置和主世界 SpawnGroup。

> 说明：本文没有使用 `pink_manifest_probe.dem` 判断竞技模式，因为该 Demo 不是竞技模式。竞技取值只参考真实赛事竞技 Demo；没有“竞技 + Workshop”实录支撑的 Workshop 动态值均标为引擎动态数据，不作为固定结论。

## 2. joedwards32/CS2 项目的生成链路

项目本身不编码 Demo，只负责向 CS2 引擎提供启动和 CSTV 参数。

- 默认竞技模式：`CS2_GAMETYPE=0`、`CS2_GAMEMODE=1`。
- `TV_AUTORECORD` 被替换到 `server.cfg` 的 `tv_autorecord`。
- Workshop 地图通过 `+host_workshop_map <ID>` 交给引擎。
- Workshop 集合通过 `+host_workshop_collection <ID>` 交给引擎。
- 使用 Workshop 时，项目清除普通 `+mapgroup`，把初始地图设为 `<empty>`，并启用 `mp_match_end_changelevel true`。

相关代码：

- `C:\code\CS2\sniper\Dockerfile:79`
- `C:\code\CS2\sniper\etc\entry.sh:104`
- `C:\code\CS2\sniper\etc\entry.sh:177`
- `C:\code\CS2\sniper\etc\server.cfg:18`

自动录制需要同时设置：

```ini
TV_ENABLE=1
TV_AUTORECORD=1
```

完整流程：

```text
CS2_HOST_WORKSHOP_MAP=Workshop ID
        ↓
+host_workshop_map ID
        ↓
CS2 下载并挂载 Workshop VPK
        ↓
引擎确定包内地图名、主世界、天空盒和实体块
        ↓
CSTV 将运行中的地图会话写入 Demo
```

因此 Demo 中记录的是引擎最终加载出来的运行时状态，而不是 Docker 环境变量或命令行文本本身。

## 3. Demo 头和 Signon 中的地图字段

| 消息 | Tag | 字段 | 类型 | 内容 |
|---|---:|---|---|---|
| `CDemoFileHeader` | 5 | `map_name` | string | 内部地图名 |
| `CDemoFileHeader` | 10 | `addons` | string | 活动 Addon 集合；官方地图通常为空 |
| `CDemoFileHeader` | 8 | `allow_clientside_entities` | bool | 是否允许客户端地图实体 |
| `CDemoFileHeader` | 9 | `allow_clientside_particles` | bool | 是否允许客户端粒子和地图特效 |
| `CDemoFileHeader` | 2 | `patch_version` | int32 | 网络/补丁版本 |
| `CDemoFileHeader` | 6 | `game_directory` | string | 服务器游戏目录 |
| `CDemoFileHeader` | 11 | `demo_version_name` | string | 通常为 `valve_demo_2` |
| `CDemoFileHeader` | 12 | `demo_version_guid` | string | Demo 格式 GUID |
| `CDemoFileHeader` | 13 | `build_num` | int32 | 引擎构建号，可选 |
| `CNETMsg_SignonState` | 1 | `signon_state` | enum | Signon 阶段，`FULL=6` 表示完整进入会话 |
| `CNETMsg_SignonState` | 2 | `spawn_count` | uint32 | 地图/服务器 Spawn 代数 |
| `CNETMsg_SignonState` | 5 | `map_name` | string | 当前地图名 |
| `CNETMsg_SignonState` | 6 | `addons` | string | 当前 Addon 集合 |

## 4. ServerInfo 中的地图字段

| Tag | 字段 | 类型 | 内容 |
|---:|---|---|---|
| 1 | `protocol` | int32 | 网络协议版本 |
| 2 | `server_count` | int32 | 当前服务器/换图会话代数 |
| 3 | `is_dedicated` | bool | 是否专用服务器 |
| 4 | `is_hltv` | bool | 是否 CSTV/HLTV 流 |
| 13 | `tick_interval` | float | 服务器 Tick 间隔；64 tick 通常为 `0.015625` |
| 14 | `game_dir` | string | 游戏目录 |
| 15 | `map_name` | string | 当前内部地图名 |
| 16 | `sky_name` | string | 天空环境名，可为空 |
| 18 | `addon_name` | string | 当前活动 Addon 标识 |
| 19 | `game_session_config` | message | 地图和模式会话配置 |
| 20 | `game_session_manifest` | bytes | 引擎生成的二进制会话清单 |

`game_session_manifest` 是不透明二进制数据。公开 protobuf 只定义了它是 `bytes`，没有公开稳定的内部字段 schema。

## 5. GameSessionConfiguration 全字段

| Tag | 字段 | 类型 | 说明 |
|---:|---|---|---|
| 1 | `is_multiplayer` | bool | 是否多人会话 |
| 2 | `is_loadsavegame` | bool | 是否从存档加载 |
| 3 | `is_background_map` | bool | 是否菜单背景地图 |
| 4 | `is_headless` | bool | 引擎会话标志，不等同于 `is_dedicated` |
| 5 | `min_client_limit` | uint32 | 最小客户端限制 |
| 6 | `max_client_limit` | uint32 | 最大客户端限制 |
| 7 | `max_clients` | uint32 | 最大客户端数 |
| 8 | `tick_interval` | fixed32 | 嵌套 Tick 字段，部分 Demo 写 `0` |
| 9 | `hostname` | string | 会话主机名，可缺失 |
| 10 | `savegamename` | string | 存档名，竞技通常为空 |
| 11 | `s1_mapname` | string | 兼容地图名字段 |
| 12 | `gamemode` | string | 字符串模式字段，竞技 Demo 中也可能为空 |
| 13 | `server_ip_address` | string | 会话服务器地址 |
| 14 | `data` | bytes | `VBKV` 二进制 KeyValues |
| 15 | `is_localonly` | bool | 是否仅本地会话 |
| 16 | `is_transition` | bool | 是否处于换图过渡 |
| 17 | `previouslevel` | string | 前一地图名，可缺失 |
| 18 | `landmarkname` | string | Source 关卡过渡地标，可缺失 |
| 19 | `no_steam_server` | bool | 是否不使用 Steam 服务器服务 |

### 5.1 真实竞技 Demo 的 VBKV 内容

真实赛事竞技 Demo 的 `game_session_config.data` 中可解码出：

| 键 | 实测值 | 含义 |
|---|---|---|
| `levelname` | `de_dust2` | 当前内部关卡名 |
| `mode` | `dedicated` | 专用服务器会话 |
| `loadmap` | `1` | 加载地图 |
| `changelevel` | `1` | 换图操作/能力 |
| `map` | `de_dust2` | 当前地图 |
| `mapgroup` | `""` | 地图组，可为空 |
| `requires_attr` | `""` | 库存属性要求 |
| `requires_attr_value` | `-1` | 属性值要求 |
| `requires_attr_reward` | `""` | 属性奖励设置 |
| `reward_drop_list` | `-1` | 掉落列表 |
| `numSlots` | `10` | 竞技玩家槽数 |
| `c_game_type` | `0` | Classic |
| `c_game_mode` | `1` | Competitive |
| `default_game_type` | `0` | 地图定义的默认游戏类型 |
| `default_game_mode` | `0` | 地图定义的默认游戏模式 |
| `ct_arms` | `models/weapons/ct_arms_idf.vmdl` | CT 手臂模型 |
| `t_arms` | `models/weapons/t_arms.vmdl` | T 手臂模型 |
| `ct_models` | `ctm_idf` 及其变体 | CT 模型集合 |
| `t_models` | `tm_leet_variantA` 等 | T 模型集合 |

Workshop 竞技地图通常会改变地图名、地图组、阵营模型和 Addon 相关值；竞技模式仍应由 `game_type=0`、`game_mode=1` 决定。

`data` 是动态 KeyValues。Workshop 专用键的实际内容必须用真实“竞技 + Workshop”Demo 验证，不能把非竞技 Demo 中的值直接套用。

## 6. SpawnGroup 完整字段

`CNETMsg_SpawnGroup_Load` 用于描述主世界、天空盒、地图 Prefab 和实体块。

| Tag | 字段 | 内容 |
|---:|---|---|
| 1 | `worldname` | 主地图、天空盒或 Prefab 的世界资源名 |
| 2 | `entitylumpname` | Entity Lump 名称 |
| 3 | `entityfiltername` | 实体加载过滤器 |
| 4 | `spawngrouphandle` | SpawnGroup 会话句柄 |
| 5 | `spawngroupownerhandle` | 所有者句柄 |
| 6 | `world_offset_pos` | 世界偏移 `x/y/z/w` |
| 7 | `world_offset_angle` | 世界旋转 `x/y/z` |
| 8 | `spawngroupmanifest` | 二进制加载清单，不是完整 VPK |
| 9 | `flags` | 加载标志位 |
| 10 | `tickcount` | 创建/启用 Tick |
| 11 | `manifestincomplete` | Manifest 是否尚未完整 |
| 12 | `localnamefixup` | 本地实体名称修正 |
| 13 | `parentnamefixup` | 父组名称修正 |
| 14 | `manifestloadpriority` | Manifest 加载优先级 |
| 15 | `worldgroupid` | Source 2 World Group ID |
| 16 | `creationsequence` | 创建序号 |
| 17 | `savegamefilename` | 存档恢复文件名 |
| 18 | `spawngroupparenthandle` | 父 SpawnGroup 句柄 |
| 19 | `leveltransition` | 是否属于关卡过渡 |
| 20 | `worldgroupname` | 如主世界 `default`、天空盒 `skyboxWorldGroup0` |

`flags` 的已定义值：

| 值 | 含义 |
|---:|---|
| 1 | 从存档加载实体 |
| 2 | 不生成实体 |
| 4 | 同步生成 |
| 8 | 初始 SpawnGroup |
| 16 | 创建客户端实体 |
| 64 | 阻塞直到加载完成 |
| 128 | 加载流式数据 |
| 256 | 创建新的 Scene World |

配套消息：

- `SpawnGroup_ManifestUpdate`：`spawngrouphandle#1`、`spawngroupmanifest#2`、`manifestincomplete#3`。
- `SpawnGroup_SetCreationTick`：`spawngrouphandle#1`、`tickcount#2`、`creationsequence#3`。
- `SpawnGroup_Unload`：`spawngrouphandle#1`、`flags#2`、`tickcount#3`。
- `SpawnGroup_LoadCompleted`：`spawngrouphandle#1`。
- `CDemoRecovery.initial_spawn_group`：`spawngrouphandle#1`、`was_created#2`。
- `CDemoRecovery.spawn_group_message`：原始 SpawnGroup 网络消息。
- `CDemoSpawnGroups.msgs`：Demo 终止/恢复区域保存的 SpawnGroup 消息数组。

当头部地图名缺失或不可信时，可结合以下信息识别主地图：

```text
worldgroupname == "default"
+ worldname
+ 初始 SpawnGroup 标志/句柄
```

## 7. 地图资源和实体数据容器

| 结构 | 相关字段 | 内容 |
|---|---|---|
| `CDemoStringTables.items_t` | `str#1`、`data#2` | 表项名称和二进制数据 |
| `CDemoStringTables.table_t` | `table_name#1`、`items#2`、`items_clientside#3`、`table_flags#4` | 字符串表 |
| `CSVCMsg_CreateStringTable` | `name#1` 至 `using_varint_bitcounts#10` | 创建资源、模型、基线等字符串表 |
| `CSVCMsg_UpdateStringTable` | `table_id#1`、`num_changed_entries#2`、`string_data#3` | 更新字符串表 |
| `CSVCMsg_ClearAllStringTables` | `mapname#1`、`create_tables_skipped#3` | 换图时清表并携带地图名 |
| `DEM_SendTables` | `data#1` | 网络实体字段定义 |
| `DEM_ClassInfo` | `class_id`、`network_name`、`table_name` | 实体类和序列化表关系 |
| `CSVCMsg_PacketEntities` | `entity_data#7` | 地图实体和游戏实体状态 |
| `CSVCMsg_PacketEntities` | `active_spawngroup_handle#9` | 实体所属 SpawnGroup |
| `CSVCMsg_PacketEntities` | `max_spawngroup_creationsequence#10` | 最大 SpawnGroup 创建序号 |
| `CSVCMsg_PacketEntities` | `server_tick#12` | 实体状态对应的服务器 Tick |
| `CSVCMsg_PacketEntities` | `serialized_entities#13` | 序列化实体数据 |
| `CSVCMsg_PacketEntities` | `alternate_baselines#15` | 实体替代基线 |
| `CSVCMsg_PacketEntities` | `non_transmitted_entities#19` | 未传输实体集合 |
| `CSVCMsg_PacketEntities` | `outofpvs_entity_updates#23` | PVS 外实体更新 |
| `CDemoFullPacket` | `string_table#1`、`packet#2` | 跳转/快照需要的完整状态 |

Demo 不会内嵌完整 Workshop VPK。地图几何、材质、模型和完整 `.vmap_c` 仍由本地资源或 Workshop 下载提供；Demo 主要保存资源引用、加载关系和网络状态。

## 8. 与地图有关的 GameEvent

| 事件 | 字段 |
|---|---|
| `server_spawn` | `hostname`、`address`、`port`、`game`、`mapname`、`addonname`、`maxplayers`、`os`、`dedicated`、`password` |
| `server_cvar` | `cvarname`、`cvarvalue` |
| `game_newmap` | `mapname`、`transition` |
| `map_shutdown` | 无字段 |
| `map_transition` | 无字段 |
| `round_start` | `timelimit`、`fraglimit`、`objective` |
| `teamplay_round_start` | `full_reset` |
| `nextlevel_changed` | `nextlevel`、`mapgroup`、`skirmishmode` |
| `match_end_conditions` | `frags`、`max_rounds`、`win_rounds`、`time` |
| `CDemoFileInfo.game_info.cs` | `round_start_ticks[]` |

`server_cvar` 和 `CNETMsg_SetConVar` 只保存发生网络同步或变化的 CVar，不是服务器所有配置的完整快照。

## 9. Workshop 信息与 Demo 字段的对应关系

| Workshop/地图信息 | Demo 中的表示 |
|---|---|
| Workshop PublishedFileID | 通常反映在 `addons` / `addon_name`；具体字符串格式由引擎决定 |
| Workshop Collection ID | 没有固定 `collection_id` 字段，可能只间接影响 `mapgroup` 和 `nextlevel` |
| 包内地图名 | `map_name`、`s1_mapname`、Session KV 的 `levelname/map` |
| 主世界 | `SpawnGroup_Load.worldname` |
| 天空盒世界 | 独立 SpawnGroup 的 `worldname/worldgroupname` |
| Entity Lump | `entitylumpname` 和 SpawnGroup Manifest |
| 地图资源依赖 | `game_session_manifest`、`spawngroupmanifest`、StringTables |
| 竞技模式 | `game_type=0`、`game_mode=1`；Session KV 通常为 `c_game_type=0`、`c_game_mode=1` |
| 地图组和轮换 | Session KV `mapgroup`、`nextlevel_changed.mapgroup` |
| 阵营模型 | `ct_arms`、`t_arms`、`ct_models`、`t_models` |

## 10. 不会作为固定字段写入的内容

以下内容没有独立、稳定的 Demo 字段：

- Workshop 页面标题、作者、描述和标签。
- 预览图 URL、点赞数、收藏数和订阅数。
- 发布时间和更新时间。
- `publish_data.txt` 原文件。
- `CS2_HOST_WORKSHOP_MAP` 环境变量名。
- `host_workshop_map` 命令文本。
- 完整 Workshop VPK。
- 完整 `.vmap_c`、材质、模型和导航文件。
- 固定的 `workshop_collection_id` 字段。

## 11. 推荐解析顺序

```text
1. CDemoFileHeader.map_name + addons
2. CNETMsg_SignonState.map_name + addons
3. CSVCMsg_ServerInfo.map_name + addon_name
4. GameSessionConfiguration.s1_mapname + data
5. 主世界 SpawnGroup.worldname + worldgroupname
6. GameEvent.server_spawn / game_newmap / nextlevel_changed
```

如果头部为空或字段之间不一致，应以实际会话的 `ServerInfo`、主世界 SpawnGroup 和实体加载关系交叉验证，而不是使用 Demo 文件名或 Workshop 页面标题。

## 12. 资料来源

- [SteamTracking demo.proto](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/demo.proto)
- [SteamTracking networkbasetypes.proto](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/networkbasetypes.proto)
- [SteamTracking netmessages.proto](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/netmessages.proto)
- [SteamTracking core.gameevents](https://github.com/SteamTracking/GameTracking-CS2/blob/master/game/core/pak01_dir/resource/core.gameevents)
- [SteamTracking mod.gameevents](https://github.com/SteamTracking/GameTracking-CS2/blob/master/game/csgo/pak01_dir/resource/mod.gameevents)
- [SteamTracking gameinfo.gi](https://github.com/SteamTracking/GameTracking-CS2/blob/master/game/csgo/gameinfo.gi)
- `C:\code\CS2` 本地项目源码
