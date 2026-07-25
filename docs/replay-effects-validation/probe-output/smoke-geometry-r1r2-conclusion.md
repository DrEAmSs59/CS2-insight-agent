# Smoke geometry Round 1–2 verification (Anubis)

**Date:** 2026-07-25  
**Demo:** `C:\soft\cs2_demo_lib\liquid-vs-vitality-m1-anubis.dem`  
**Diag:** `data/smoke-diag-anubis.json` (40 occupancy snapshots, 1 entity sampled in CLI limits)

## Automated regression

- Backend: `test_smoke_voxel_diagnostics.py` + `test_smoke_voxel_decode.py` + `test_replay_effects.py` → **22 passed**
- Frontend `src/components/analysis/`: **43 passed** (includes smokeContour, smokeDebugGate, ReplayAreaEffectsCanvas)

## Center 16 vs 15.5

Across all 40 snapshots, mean |voxel-mean − detonation|:

| Anchor | Mean | Median | Closer count |
|--------|------|--------|--------------|
| center=16 | ~41.4 wu | ~41.4 | **40/40** |
| center=15.5 | ~49.1 wu | ~49.1 | 0/40 |

**Do not switch production center to 15.5** without new evidence. Residual ~2 voxel mean offset is expected for asymmetric occupancy; not a reason to change the decoder default.

## State bytes

Aggregated `state0` over snapshots: mostly `5` (1520) with some `0` (240). Other bytes not used for density in production beyond this coarse mapping — no change recommended from this pass.

## Raw grid shape (largest span sample, tick 23971)

Unique XY span `dx=7`, `dy=5` (24 cells). Occupancy is a **2D irregular cluster**, not a single horizontal line and not a perfect diagonal strip. Example cells include columns 11–18 with y mostly 16/18 plus scattered neighbors — consistent with sparse seed voxels, not a decode that “flattened” a diagonal into a horizontal bar.

## Failure-case conclusion (plan §5.3)

**Primary historical failure: Case 1 — frontend render.**  
Production previously used circular bloom + distance cull, which erased diagonal/irregular edges. Round 2 replaced that with density-mask + marching-squares contours and active→next sample crossfade.

**Not indicated this pass:** Case 3 (raw_grid already wrong as a flat line). Raw grids show 2D extent.

**Deferred (Round 3 map unify):** residual player/radar transform and Nuke CSS zoom issues are out of Round 1–2 scope. Use `?smokeDebug=1` + `radar_cells` vs contour `final_render` for visual A/B on Anubis B door in the app.

## Manual UI (operator)

1. Load Anubis demo → 2D replay → seek B-door smoke.  
2. `?smokeDebug=1` → compare `radar_cells` squares vs contour fill.  
3. Confirm molotov/inferno still uses soft radial cells.
