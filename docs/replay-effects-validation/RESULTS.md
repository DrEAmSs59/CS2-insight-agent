# Dynamic Replay Effects Validation Results

> 探针输出：`probe-output/run-001/`（`probe-summary.json` + `probe-log.txt`）
> 结论摘要：**烟雾 = PARSER_EXPORT_REQUIRED（路线 B），燃烧弹 = PARSER_ENTITY_EXPORT_REQUIRED（路线 B）。**
> Demo 数据流中确认存在全部目标字段；当前 demoparser2 Python API 无法导出体素字节与 CInferno 实体状态。
> 下一步允许的实现是扩展 demoparser2 lean fork（`packaging/demoparser-lean/`），不是前端实现。

## Environment

- CS2 Insight Agent commit: `391496ca6fa3b7d9d69ecfa72655cdace35a723f`（分支 `feat/replay-effects-validation`，基于 `develop`）
- demoparser2 version: `0.41.4+cs2insight1`（项目 lean fork wheel，内置运行时 `python/`）
- Python version: 3.12.7 (Windows x64)
- Demo source: `C:\soft\cs2_demo_lib\og-vs-spirit-m1-cache.dem`（BLAST.tv Premier，SourceTV，259 MB）
- Map: `de_cache`
- Tick rate: 64
- 事件规模：`smokegrenade_detonate` 116 次、`inferno_startburn` 71 次、`hegrenade_detonate` 58 次

## Inferno

- CInferno entity accessible: **no**（Python API 无任何入口）
- Actual property names（`list_updated_fields()` 确认存在于 demo 数据流）:
  - `Grenade.m_firePositions`
  - `Grenade.m_fireParentPositions`
  - `Grenade.m_bFireIsBurning`
  - `Grenade.m_fireCount`
  - `Grenade.m_nFireEffectTickBegin`
  - `Grenade.m_nFireLifetime`
  - `Grenade.m_nInfernoType`
  - 注意：`m_extent` **不在**数据流中（`updated-fields[extent]` 为空），实现时不能依赖它
- 尝试过的读取路径（全部失败）：
  - `parse_grenades(extra=[...])`：签名为 `(*, extra=None, grenades=True)`，接受这些属性名但返回列中**完全不出现**（CInferno 不在 parse_grenades 跟踪的实体类里；grenade_type 枚举中无 CInferno）
  - `parse_ticks([...])`：接受属性名但**静默丢弃**，返回帧只有 `tick / steamid / name`（该 API 面向玩家实体）
- Position mode: unknown（拿不到数据，无法做 I3 世界/局部坐标判定）
- Active cell count range: 无法测量
- Terrain-shaped distribution confirmed: 无法测量
- **Decision: `PARSER_ENTITY_EXPORT_REQUIRED`**

## Smoke

- Projectile entity accessible: **yes** — `parse_grenades()` 返回 `CSmokeGrenadeProjectile` 188,842 行（84 个实体生命周期，含 `grenade_entity_id / tick / x / y / z`）
- m_nVoxelUpdate accessible: **yes** — `parse_grenades(extra=["m_nVoxelUpdate"])`，float64，全部非空，实测 0 → 202 递增
- m_nVoxelFrameDataSize accessible: **yes** — 同路径，float64，实测 0 → 3023 字节随烟雾发展增长
- m_VoxelFrameData accessible: **no（关键缺口）** — 列会出现，但 `CUtlVector<uint8>` 被坍缩成**单个 float64 标量**（样本值 0/1/3/51/240/255…，疑似数组中某单个元素），无法还原字节数组
- m_vSmokeDetonationPos accessible: yes（`list[float]×3`，正常的 Vector 导出——证明数组型 Variant 在该 API 中可以工作，缺的只是 `Vec<u8>` 支持）
- m_bExplodeFromInferno: 不导出（列缺失）
- Python value type: 元数据 float64 / bool；`m_VoxelFrameData` = float64 标量（错误形态）；`m_vSmokeDetonationPos` = list
- Actual/declaration size relation: 无法验证（拿不到字节内容）；declared size 序列自身一致、单调合理
- Update number correlated with hash changes: **partial（用 size 替代 hash 验证）** — 探测窗口内 84 个实体共 **19,175 次 `m_nVoxelUpdate` 变化，每一次都伴随 `m_nVoxelFrameDataSize` 变化，0 次例外**。体素数据是真实、持续演化的，不是常量占位
- HE interaction observable: unknown（需拿到字节内容后，用专用样本 demo 按 §S4 验证）
- Shot interaction observable: unknown（同上）
- **Decision: `PARSER_EXPORT_REQUIRED`**

## Performance

- Probe duration: 14.8 s（整个 259 MB demo；`parse_grenades` 全量 1,930,285 行，单次约 3–5 s）
- Peak output size: `probe-summary.json` ≈ 110 KB

## Blocking Issues

1. **demoparser2 缺少 `Vec<u8>`（`CUtlVector<uint8>`）Variant 支持**：`m_VoxelFrameData` 被坍缩成单个标量。需要在 lean fork 中按方案 §9.2 增加 `U8Vec(Vec<u8>)` 值类型并导出为 `bytes`。
2. **demoparser2 没有 CInferno 实体入口**：`parse_grenades` 的实体类过滤不含 CInferno，`parse_ticks` 面向玩家。需要按方案 §9.3 增加 `parse_infernos()`（或通用 `parse_entities`）。
3. 两条扩展都应走现有 lean fork 流水线（`packaging/demoparser-lean/demoparser2-v0.41.4.patch` + `build-wheel.ps1`），不改 site-packages，Windows 打包可复现。
4. 本次用的是职业比赛 demo，缺少方案 §5.1 的专用受控场景（贴墙烟 / 门洞烟 / HE 炸烟对照录屏）。字节可读后仍需录制专用样本完成 S3/S4 与 I3/I4。

## Next Allowed Implementation Step

- **Commit 3（方案 §9）：扩展 demoparser2 lean fork**：
  1. Rust 侧新增 `Vec<u8>` Variant，`m_VoxelFrameData` 导出为 `bytes`（保留空数组与缺失字段的区别；单元测试覆盖 0 / 1 / 255 / 长数组）；
  2. 新增 CInferno 实体导出（`parse_infernos(start_tick, end_tick)` 至少含 `tick / entity_id / m_vecOrigin 或 x,y,z / m_fireCount / m_firePositions / m_bFireIsBurning / m_nFireEffectTickBegin / m_nFireLifetime`）。
- 在此之前，**禁止**进入烟雾体素解码、`/demo/replay` sidecar、前端 Canvas 实现。
- 字节可读后：先跑 `backend/scripts/analyze_smoke_voxel_frames.py`（阶段 S-A，待建）完成格式研究，再按 §S5 重新判定。
