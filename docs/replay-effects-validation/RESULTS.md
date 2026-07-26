# Dynamic Replay Effects Validation Results

> 探针输出：`probe-output/run-002/` + S-A `smoke-sa-001/`  
> 结论摘要：**烟雾 = REAL_VOXEL_READY；燃烧弹 = INFERNO_CELLS_READY。**  
> 解码器：`backend/app/parser/smoke_voxel_decode.py`（journal + 32³ occupancy；`world = sign*(grid-16)*20 + detonationPos`）。  
> 产品路径：`/api/demo/replay` sidecar `effect_tracks` + 前端 `ReplayAreaEffectsCanvas`。

## Environment

- demoparser2: `0.41.4+cs2insight2`
- Demo: `og-vs-spirit-m1-cache.dem`（de_cache）

## Inferno

- **Decision: `INFERNO_CELLS_READY`** — `parse_infernos()` 导出火点，已接入 `effect_tracks`。

## Smoke

- `m_VoxelFrameData`：真实 `bytes`；有效长度由 `m_nVoxelFrameDataSize` 截断（容量常 3072）。
- Journal：`u16 seq` + `u16 len` + payload；occupancy section 为 count×`[z,y,x,state×5]`。
- 实测解码：单帧常见 ~44 seed voxels → 投影十余个 2D cells。
- **Decision: `REAL_VOXEL_READY`**

## Next Allowed Implementation Step

- 已进入产品实现：`replay_effects` + Canvas。继续用真实比赛画面校准半径/透明度；禁止假圆形扩散替代体素。
