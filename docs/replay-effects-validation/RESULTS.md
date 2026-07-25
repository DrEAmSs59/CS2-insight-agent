# Dynamic Replay Effects Validation Results

> 探针输出：`probe-output/run-002/`（`probe-summary.json` + `probe-log.txt`）  
> 对照基线：`probe-output/run-001/`（`0.41.4+cs2insight1`，导出缺口阶段）  
> 结论摘要：**烟雾 = FORMAT_RESEARCH_REQUIRED（路线 C）；燃烧弹 = INFERNO_CELLS_READY（路线 A）。**  
> demoparser2 lean fork 已升级到 `0.41.4+cs2insight2`：`m_VoxelFrameData` → 真实 `bytes`；新增 `parse_infernos()` 导出火焰单元。  
> 下一步允许：烟雾体素**格式研究**（S-A / `analyze_smoke_voxel_frames`）；燃烧区域可进入 sidecar / 回放实现闸门评估。**仍禁止**在未完成格式研究前做烟雾 Canvas 视觉近似。

## Environment

- CS2 Insight Agent commit: `d87627f91fd8f74272d01a390f4c04975e94121b`（分支 `feat/demoparser-effects-export`，基于 `develop` 验证合并点）
- demoparser2 version: `0.41.4+cs2insight2`（lean fork；`parse_infernos` 已出现在 `DemoParser` 方法列表）
- Python version: 3.12.7 (Windows x64，内置运行时 `python/`)
- Demo source: `C:\soft\cs2_demo_lib\og-vs-spirit-m1-cache.dem`（BLAST.tv Premier，SourceTV，259 MB）
- Map: `de_cache`
- Tick rate: 64
- 事件规模：`smokegrenade_detonate` 116 次、`inferno_startburn` 71 次、`hegrenade_detonate` 58 次
- 探针耗时：约 27.4 s

## Inferno

- CInferno entity accessible: **yes** — `parse_infernos()` 返回 **89,562** 行，全部 `grenade_type=CInferno`
- Actual property names（API 已导出）:
  - `m_firePositions` — `list` of XYZ（array_like）
  - `m_fireParentPositions` — 同上
  - `m_bFireIsBurning` — `list` of bool
  - `m_fireCount` — int64，实测 **1 → 16**（mean ≈ 15.0）
  - `m_nFireEffectTickBegin` / `m_nFireLifetime`
- 仍不导出 / 不在流中：`m_extent`、`m_vecOrigin`、`m_bWasCreatedInSmoke`；行上无 `x/y/z` 实体原点列（火焰世界坐标在 `m_firePositions` 单元格内）
- 对照：`parse_grenades(extra=[...])` **仍不**导出上述列（CInferno 不在 grenade 轨迹实体类）；必须用 `parse_infernos`
- Position mode: **world**（样本首格为地图量级坐标，如 `[895.98, 602.66, 1817.32]`；后续槽位常为 `[0,0,0]`，与固定容量数组 + `m_fireCount` 截断一致）
- Active cell count range: **1–16**
- Terrain-shaped distribution confirmed: **partial**（职业比赛 demo 可见不规则铺火；专用贴墙/门洞样本仍建议按方案 §I3/I4 补录）
- **Decision: `INFERNO_CELLS_READY`**

## Smoke

- Projectile entity accessible: **yes** — `parse_grenades()` / `extra=` 路径，`CSmokeGrenadeProjectile` 188,842 行
- m_nVoxelUpdate accessible: **yes**（float64，随生命周期递增）
- m_nVoxelFrameDataSize accessible: **yes**（float64，随烟雾发展变化）
- m_VoxelFrameData accessible: **yes（关键缺口已关闭）** — Python 类型 **`bytes`**，`array_like=true`；样本长度常见 **3072**
- m_vSmokeDetonationPos accessible: yes（`list[float]×3`）
- m_bExplodeFromInferno: 仍不导出（列缺失）
- Actual/declaration size relation: **不一致** — `declared_size_matches_actual=false`（声明尺寸与 `len(bytes)` 常不等；疑似容量缓冲 vs 有效载荷，或不同计量单位）。**不得**在未搞清布局前按声明尺寸盲目切片渲染
- S-A 初跑（`probe-output/smoke-sa-001/`，8/94 实体）：**全部帧 length=3072**，`declared_match_ratio=0.0`；同实体相邻 update 有真实字节 diff（熵均值约 1.7）。进一步支持「定长 3072 容量 + `m_nVoxelFrameDataSize` 描述有效载荷」假说，尚不能解码网格
- Update number correlated with hash changes: **yes**（S2 抽样窗口：`update_change_with_hash_change=431`，无「update 变但 hash 不变」）
- HE / shot interaction: unknown（需专用样本 + 格式研究后按 §S4）
- **Decision: `FORMAT_RESEARCH_REQUIRED`**

## Performance

- Probe duration: 27.43 s
- Peak output size: `probe-summary.json` 含体素抽样哈希，体积明显大于 run-001

## Blocking Issues

1. **烟雾体素布局未知** — 字节可读且随 `m_nVoxelUpdate` 演化，但网格/编码/与 `m_nVoxelFrameDataSize` 的关系未解析 → 禁止前端烟雾体素绘制。
2. **声明尺寸 ≠ 实际 bytes 长度** — 格式研究必须先解释该差异（有效长度字段？定长 3072 槽？压缩？）。
3. Inferno 行缺实体原点 `x/y/z` — 实现侧应以 `m_firePositions[:m_fireCount]` 为权威几何；勿依赖 `m_extent`。
4. 职业比赛 demo 仍非方案 §5.1 受控样本；贴墙烟 / HE 炸烟对照录屏建议后续补齐。

## Next Allowed Implementation Step

1. **烟雾（S-A 已开工）**：`backend/scripts/analyze_smoke_voxel_frames.py` 可对真实 `bytes` 做长度/熵/diff/声明尺寸对照。跑完专用样本并确认布局后，再按 §S5 争取 `REAL_VOXEL_READY`。在此之前禁止烟雾 Canvas / sidecar 视觉实现。
2. **燃烧**：闸门已开 `INFERNO_CELLS_READY`；可进入方案后续的 inferno sidecar / 2D 回放单元格渲染设计与实现（仍须用 `parse_infernos` 真数据，禁止假圆近似）。
3. 打包：使用 `packaging/demoparser-lean/` 的 `0.41.4+cs2insight2` patch + `demoparser-runtime.json` 重建 wheel；运行时需带上含 `parse_infernos` 的模块。
