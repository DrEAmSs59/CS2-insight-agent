# Demo 入库跳过兼容修复

**日期**: 2026-07-24  
**状态**: 已实现  
**范围**: 加快 Demo 库「确认入库」单文件耗时；不改变入库后卡片可见的元数据。

## 背景

Demo 库批量入库（`POST /api/demos/batch-ingest`）对每个 pending demo 当前顺序执行：

1. `ensure_demo_compatible` — 首次几乎整文件扫描/就地修复，有指纹缓存命中时才便宜  
2. `inspect_demo`（经 `_inspect_demo_meta`）— 地图、时长、名单 K/D、比分等轻量元数据  
3. `update_lightweight_meta` + `index_demo_player_stats` — 落库  

用户反馈：哪怕只入库 1～2 个 demo 也明显偏慢。经确认：

- 痛点是**单文件路径成本**（不是批量并发）  
- 产品取舍上更希望先加速，且接受「方案 B」：只去掉入库时的兼容修复，**保留现有 inspect**（名单/比分仍立刻可用）

兼容修复对「展示库卡片」不是必需；播放、解析、录制前仍需要。

## 目标

- 入库关键路径不再调用 `ensure_demo_compatible`，降低单文件首次入库耗时  
- 入库后库列表卡片仍立即具备现有 inspect 结果（地图、时长、来源、名单、比分等）  
- 兼容修复仍在真正需要读写/回放 demo 的入口执行，行为与今日一致（含缓存）

## 非目标

- 不提高 `CS2_INSIGHT_DEMO_INSPECT_CONCURRENCY` / 不改 inspect 实现  
- 不把名单/比分改成后台补全（那是方案 A，已否决）  
- 不改前端 IngestModal / 入库 UX  
- 不改变 `ensure_demo_compatible` 本身的修复逻辑或缓存格式

## 设计

### 入库路径

在 `batch_ingest_demos` 的 `_inspect_candidate` 中：

- **删除** `await asyncio.to_thread(ensure_demo_compatible, dem_path)`  
- **保留** `ensure_demo_compatible` 语义上的前置文件存在性检查（已有 `Path.is_file()`）  
- **保留** `_inspect_demo_meta` → 写 meta → `index_demo_player_stats(..., precomputed_players=...)`

入库不再修改 demo 字节内容，也不写入兼容指纹缓存。

### 兼容修复仍保留的入口（不改调用）

以下路径继续在需要时调用 `ensure_demo_compatible`（现状保持）：

| 入口 | 位置 |
|------|------|
| 上传落盘 | `main.py` upload 相关 |
| 库内拉取玩家 / analyze | `GET /api/demos/{id}/players`、`POST /api/demos/{id}/analyze` 等 |
| 直接播放 | `demo_playback_service` |
| 录制前 | `recording/api.py` |

因此：先入库再播放/解析的 demo，会在**首次播放或解析**时完成兼容修复（若缓存未命中），而不是在确认入库时。

### 风险与说明

- **首次播放/解析**可能比「入库时已修过」略慢一次；这是刻意把成本挪到真正使用点。  
- 若某 demo 在 inspect 阶段因未修复而解析失败：与今日「先 compat 再 inspect」相比，极少数损坏/需修补文件可能从「入库成功」变成「入库失败」。可接受：入库本就不保证可播放；用户可在播放/解析前仍走修复路径。若实测出现可修文件在 inspect 失败，再考虑「inspect 失败时按需 compat 一次后重试」作为后续增量（本 spec 不包含）。  
- 测试里对 `batch_ingest` mock 了 `ensure_demo_compatible` 的用例需改为断言**未被调用**。

## 测试计划

- [ ] 更新 `backend/tests/test_demo_roster_cache.py` 中 `test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters`（及同类）：入库不再依赖 / 不再调用 `ensure_demo_compatible`  
- [ ] 现有 compat / playback / upload 测试仍通过  
- [ ] 手工：从未进过兼容缓存的 `.dem` 入库明显快于改前；卡片仍有地图/时长/名单；首次播放或库内解析时兼容修复仍生效

## 实现提示

- 改动面预期极小：主要是 `backend/app/main.py` 的 `batch_ingest_demos` + 对应单测  
- 无需迁移、无需配置项、无需 API 契约变更
