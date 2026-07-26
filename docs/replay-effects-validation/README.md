# 2D 回放动态烟雾 / 燃烧区域 — 数据验证

本目录记录「动态烟雾与燃烧区域」功能的**验证阶段**产物。原则：

> 禁止先写视觉近似再反推数据；必须先证明 Demo 中有哪些真实数据可用，再决定实现路径。

## 探测目标

| 实体类 | 关键字段 | 用途 |
| --- | --- | --- |
| `CInferno` | `m_firePositions` / `m_bFireIsBurning` / `m_fireCount` / `m_nFireEffectTickBegin` / `m_nFireLifetime` / `m_extent` | 不规则铺火区域 |
| `CSmokeGrenadeProjectile` | `m_VoxelFrameData` / `m_nVoxelFrameDataSize` / `m_nVoxelUpdate` / `m_vSmokeDetonationPos` | 真实烟雾体素区域 |

## 运行探针

```bash
python backend/scripts/probe_replay_dynamic_effects.py \
  --demo "C:/soft/cs2_demo_lib/og-vs-spirit-m1-cache.dem" \
  --out "docs/replay-effects-validation/probe-output/run-002"
```

- `--start-tick` / `--end-tick` 可选；缺省时按 `smokegrenade_detonate` / `inferno_startburn` 事件自动推导探测窗口。
- 探针不会修改任何生产 API 或工作区缓存。
- 二进制数据只记录 SHA-256、长度和前 256 字节十六进制。
- 需要仓库锁定的 `demoparser2 0.41.4+cs2insight5`；烟雾走 `parse_grenades(extra=...)`，燃烧走 `parse_infernos(extra=...)`。

烟雾字节可读后的格式研究（阶段 S-A）：

```bash
python backend/scripts/analyze_smoke_voxel_frames.py \
  --demo "C:/soft/cs2_demo_lib/og-vs-spirit-m1-cache.dem" \
  --out "docs/replay-effects-validation/probe-output/smoke-sa-001"
```

输出：

```text
probe-output/run-XXX/
├── probe-summary.json   # 机器可读摘要（提交仓库）
└── probe-log.txt        # 人类可读日志（提交仓库）
```

**不要提交大型 `.dem` 文件**；只提交 manifest、探针输出摘要和必要的小型十六进制片段。

## 目录结构

```text
docs/replay-effects-validation/
├── README.md                     # 本文件
├── sample-manifest.example.json  # 专用样本 demo 的 manifest 模板
├── RESULTS.md                    # 实际验证结论（闸门文件；没有它不得进入实现阶段）
├── captures/                     # 对照录屏（不提交大文件）
└── probe-output/                 # 探针输出
```

## 判定路线

烟雾（S5）：

- `A. REAL_VOXEL_READY` — 能读取、能验证变化，可进入解码。
- `B. PARSER_EXPORT_REQUIRED` — Demo 疑似有数据，但 demoparser2 未导出字节数组。
- `C. FORMAT_RESEARCH_REQUIRED` — 字节可读，但布局未知，需先逆向格式。
- `D. DEMO_DATA_INSUFFICIENT` — 数据始终为空，不能做真实体素回放。

燃烧弹（I5）：

- `A. INFERNO_CELLS_READY`
- `B. PARSER_ENTITY_EXPORT_REQUIRED`
- `C. DEMO_DATA_INSUFFICIENT`

只有烟雾达到 `A`（或完成 `B`/`C` 的前置工作）、燃烧弹达到 `A`，才允许进入对应的正式实现。
