# 2D Replay Gap-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close remaining 2D replay gaps (`stable_origin`, utility clip, `content_rect` Fit, scene camera, C4 visuals/timeline, playback clock cleanup) without redoing landed smoke axis/contour/cache work.

**Architecture:** Keep existing 8Hz → density contour → `replayStore` pipeline. Lock each smoke lifecycle to a first-valid `stable_origin`; render smoke/fire into masks then `destination-in` with radar-derived utility clip masks (error allowed); fit maps via `content_*` metadata into a single `replay-scene` under camera (`fitScale * userZoom`); differentiate planted vs dropped C4 and add plant timeline markers; delete duplicate frame-index interpolators in favor of `replayPlayback.js`.

**Tech Stack:** Python 3.12 / pytest · React 19 / Vitest / Zustand · Canvas 2D · bundled awpy radar PNGs under `backend/assets/bundled_radar_maps`

**Spec:** `docs/design/2026-07-25-2d-replay-gap-fill-design.md`

## Global Constraints

- Scope = gap-fill only; do not rewrite global voxel axis, density contour core, CInferno raw cells, `replayStore` single-flight, or frames/effects disk cache mechanics.
- No `if map_name === "de_xxx"` smoke axis/offset/rotation patches.
- Backend sampling stays 8Hz; do not raise fps to hide jitter.
- Utility masks may be approximate (radar luminance); outermost ring must be black.
- Soften/blur then clip again (`destination-in`).
- Nuke and other maps: no special CSS scale; differences only via transform / content_rect / layer PNGs / masks.
- Work on a feature branch off `develop` (current HEAD includes design commit `9481250` or later). Do not commit to `main`.
- Prefer TDD: failing test → implement → pass → commit per task.
- Bump `backend/app/parser/replay_effects_cache.py` `CACHE_VERSION` from `5` → `6` when smoke track shape changes; bump `frontend/src/stores/replayStore.js` `REPLAY_STORE_CACHE_VERSION` from `10` → `11` when client assumptions change; set API `transform_version` from map metadata (default `3` once content_rect lands).

---

## File map

| File | Responsibility |
|------|----------------|
| `backend/app/parser/replay_effects.py` | Smoke lifecycle id + `stable_origin`; decode with fixed origin |
| `backend/app/parser/replay_effects_cache.py` | `CACHE_VERSION = 6` |
| `backend/scripts/generate_radar_derived_assets.py` | Generate utility masks + estimate `content_*` from radar PNGs |
| `backend/assets/bundled_radar_maps/*_utility_mask.png` | Clip assets |
| `backend/assets/bundled_radar_maps/map-data.json` | `content_*` + `transform_version` |
| `backend/app/main.py` | Pass `transform_version` from map metadata into frames cache key / response |
| `frontend/src/utils/replayCamera.js` | fit/zoom/pan math (pure) |
| `frontend/src/utils/replayRadarTransform.js` | Optional Fit helpers if needed; keep world mapping |
| `frontend/src/components/analysis/ReplayCameraControls.jsx` | UI controls |
| `frontend/src/components/analysis/ReplayAreaEffectsCanvas.jsx` | Fire mask + utility clip |
| `frontend/src/components/analysis/ReplayBombMarker.jsx` | Dropped vs planted visuals |
| `frontend/src/components/analysis/ReplaySceneCanvas.jsx` | `replay-scene` camera root; bomb marker; remove local interp dupes |
| `frontend/src/components/analysis/Demo2DReplayPreview.jsx` | Plant markers; wire camera; remove local interp dupes |
| `frontend/src/stores/replayStore.js` | Optional per-map camera; version bump |

---

### Task 1: Branch + smoke `stable_origin` / lifecycle id

**Files:**
- Modify: `backend/app/parser/replay_effects.py`
- Modify: `backend/app/parser/replay_effects_cache.py` (`CACHE_VERSION = 6`)
- Modify: `backend/tests/test_replay_effects.py`
- Test: `backend/tests/test_replay_effects.py`

**Interfaces:**
- Consumes: existing `build_smoke_tracks_from_rows(rows, start_tick, end_tick, tick_rate, *, round_number=0)` (add optional `round_number: int = 0` if missing)
- Produces: each smoke track includes:
  - `id: str` shaped `smoke:{round}:{entity_id}:{effect_start_tick}`
  - `stable_origin: list[float]` length 3
  - samples decoded with that origin only

- [ ] **Step 1: Write failing tests**

Add to `TestSmokeTracks` in `backend/tests/test_replay_effects.py`:

```python
def test_stable_origin_ignores_later_detonation_drift(self):
    blob = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
    origin_a = [100.0, 200.0, 50.0]
    origin_b = [1000.0, 2000.0, 50.0]  # > 1 cell drift
    rows = [
        {
            "tick": 10,
            "grenade_entity_id": 3,
            "grenade_type": "CSmokeGrenadeProjectile",
            "m_nVoxelUpdate": 1,
            "m_VoxelFrameData": blob,
            "m_nVoxelFrameDataSize": len(blob),
            "m_vSmokeDetonationPos": origin_a,
        },
        {
            "tick": 20,
            "grenade_entity_id": 3,
            "grenade_type": "CSmokeGrenadeProjectile",
            "m_nVoxelUpdate": 2,
            "m_VoxelFrameData": blob,
            "m_nVoxelFrameDataSize": len(blob),
            "m_vSmokeDetonationPos": origin_b,
        },
    ]
    tracks = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=1000, tick_rate=64, round_number=12)
    assert len(tracks) == 1
    assert tracks[0]["stable_origin"] == origin_a
    assert tracks[0]["id"].startswith("smoke:12:3:")
    # All sample cell XY near origin_a, not origin_b
    for sample in tracks[0]["samples"]:
        for cell in sample["cells"]:
            assert abs(cell[0] - origin_a[0]) < 40
            assert abs(cell[1] - origin_a[1]) < 40


def test_entity_reuse_gets_distinct_lifecycle_ids(self):
    blob = _make_journal([(1, _occ_payload([(16, 16, 16)]))])
    rows = [
        {
            "tick": 10,
            "grenade_entity_id": 9,
            "grenade_type": "CSmokeGrenadeProjectile",
            "m_nVoxelUpdate": 1,
            "m_VoxelFrameData": blob,
            "m_nVoxelFrameDataSize": len(blob),
            "m_vSmokeDetonationPos": [1.0, 2.0, 3.0],
        },
        {
            "tick": 5000,
            "grenade_entity_id": 9,
            "grenade_type": "CSmokeGrenadeProjectile",
            "m_nVoxelUpdate": 1,
            "m_VoxelFrameData": blob,
            "m_nVoxelFrameDataSize": len(blob),
            "m_vSmokeDetonationPos": [50.0, 60.0, 70.0],
        },
    ]
    tracks = build_smoke_tracks_from_rows(rows, start_tick=0, end_tick=10000, tick_rate=64, round_number=0)
    assert len(tracks) == 2
    assert tracks[0]["id"] != tracks[1]["id"]
    assert tracks[0]["stable_origin"] == [1.0, 2.0, 3.0]
    assert tracks[1]["stable_origin"] == [50.0, 60.0, 70.0]
```

Update any existing assertions that expected id format `smoke:0:{start}:{entity_id}` to the new shape.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend
python -m pytest tests/test_replay_effects.py::TestSmokeTracks::test_stable_origin_ignores_later_detonation_drift tests/test_replay_effects.py::TestSmokeTracks::test_entity_reuse_gets_distinct_lifecycle_ids -v
```

Expected: FAIL (missing `stable_origin` and/or old id format / cells near drifted origin).

- [ ] **Step 3: Implement**

In `build_smoke_tracks_from_rows`:

1. Add `round_number: int = 0` kw-only arg; thread from `extract_dynamic_effect_tracks` if round is known, else `0`.
2. For each lifecycle `group`, compute:

```python
stable_origin = None
for row in group:
    origin = row.get("m_vSmokeDetonationPos")
    if isinstance(origin, (list, tuple)) and len(origin) >= 3:
        try:
            stable_origin = [float(origin[0]), float(origin[1]), float(origin[2])]
            break
        except (TypeError, ValueError):
            continue
if stable_origin is None:
    continue
```

3. Pass `detonation_pos=stable_origin` into every `decode_smoke_occupancy_sequence` / `decode_smoke_cells` / `synthesize_formation_from_seeds` call for that group (not `row` origin).
4. If a later row origin distance to `stable_origin` > `VOXEL_CELL_SIZE_WORLD`, `logger.warning(...)` only.
5. Track dict:

```python
effect_start = int(samples[0]["tick"])  # after formation merge / dedupe, use final start
tracks.append({
    "id": f"smoke:{int(round_number)}:{_entity_id(entity_id)}:{effect_start}",
    "type": "smoke",
    "entity_id": _entity_id(entity_id),
    "start_tick": start,
    "end_tick": end,
    "stable_origin": stable_origin,
    "source": "smoke_voxels",
    "cell_size": cell_size,
    "samples": samples,
})
```

6. Set `CACHE_VERSION = 6` in `replay_effects_cache.py`.

- [ ] **Step 4: Run tests to verify pass**

```bash
cd backend
python -m pytest tests/test_replay_effects.py -v
```

Expected: PASS (fix any assertions broken by id rename).

- [ ] **Step 5: Commit**

```bash
git add backend/app/parser/replay_effects.py backend/app/parser/replay_effects_cache.py backend/tests/test_replay_effects.py
git commit -m "fix(replay): lock smoke tracks to stable_origin lifecycle anchors"
```

---

### Task 2: Radar-derived utility masks + content_rect metadata

**Files:**
- Create: `backend/scripts/generate_radar_derived_assets.py`
- Create: `backend/tests/test_generate_radar_derived_assets.py`
- Modify: `backend/assets/bundled_radar_maps/map-data.json`
- Create: mask PNGs for at least `de_inferno`, `de_anubis`, `de_mirage`, `de_nuke`, `de_nuke_lower`
- Modify: `backend/app/main.py` (use `transform.get("transform_version", 3)` in `frames_cache_key`)
- Modify: `backend/app/radar/radar_map_assets.py` if a small helper to resolve mask paths is useful

**Interfaces:**
- Produces:
  - `generate_utility_mask(radar_png: Path, out_png: Path, *, luminance_threshold: int = 18) -> None`
  - `estimate_content_rect(radar_png: Path, *, luminance_threshold: int = 18, pad: int = 8) -> dict` with keys `content_x, content_y, content_width, content_height`
  - map-data entries gain those keys + `"transform_version": 3`
  - mask path helper: `resolve_utility_mask_path(map_key: str, *, layer: str = "upper") -> Path | None`

- [ ] **Step 1: Write failing unit tests for pure helpers**

```python
# backend/tests/test_generate_radar_derived_assets.py
from pathlib import Path
from PIL import Image

from scripts.generate_radar_derived_assets import estimate_content_rect, generate_utility_mask


def test_estimate_content_rect_and_mask(tmp_path: Path):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 255))
    for y in range(16, 48):
        for x in range(10, 50):
            img.putpixel((x, y), (120, 120, 120, 255))
    src = tmp_path / "radar.png"
    img.save(src)
    rect = estimate_content_rect(src, luminance_threshold=18, pad=0)
    assert rect["content_x"] == 10
    assert rect["content_y"] == 16
    assert rect["content_width"] == 40
    assert rect["content_height"] == 32
    out = tmp_path / "mask.png"
    generate_utility_mask(src, out, luminance_threshold=18)
    mask = Image.open(out).convert("L")
    assert mask.getpixel((0, 0)) == 0  # outer forced black
    assert mask.getpixel((30, 30)) == 255
```

If importing `scripts.*` is awkward, put helpers in `backend/app/radar/radar_derived_assets.py` and have the script call them (preferred).

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd backend
python -m pytest tests/test_generate_radar_derived_assets.py -v
```

- [ ] **Step 3: Implement helpers + script**

Preferred layout:

- `backend/app/radar/radar_derived_assets.py` — pure functions + `resolve_utility_mask_path`
- `backend/scripts/generate_radar_derived_assets.py` — CLI that:
  1. For each `*.png` radar (skip `*_utility_mask.png`), write sibling `{stem}_utility_mask.png` (for `de_nuke_lower.png` → `de_nuke_lower_utility_mask.png`)
  2. Force border pixels black (1px)
  3. Update `map-data.json` content_* for maps that have an upper radar (use upper image for content_rect)
  4. Set `transform_version: 3` on touched maps

Core maps must be regenerated and committed as binary PNGs.

Mask naming (match frontend/backend resolver):

- upper: `de_inferno_utility_mask.png`
- lower: `de_nuke_lower_utility_mask.png`

- [ ] **Step 4: Wire `transform_version` into replay API cache key**

In `backend/app/main.py` where `frames_cache_key(..., transform_version=1)` is called:

```python
transform = lookup_map_data(map_key) if map_key not in {"unknown", ""} else {}
# (keep existing try/except pattern if lookup can throw)
tv = int(transform.get("transform_version") or 3)
cache_key = frames_cache_key(..., transform_version=tv)
```

Ensure response still returns full `map_transform` including `content_*`.

- [ ] **Step 5: Run tests + generate assets**

```bash
cd backend
python -m pytest tests/test_generate_radar_derived_assets.py -v
python scripts/generate_radar_derived_assets.py
```

Expected: masks on disk; map-data updated; tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/radar/radar_derived_assets.py backend/scripts/generate_radar_derived_assets.py backend/tests/test_generate_radar_derived_assets.py backend/assets/bundled_radar_maps/ backend/app/main.py
git commit -m "feat(replay): add radar-derived utility masks and content_rect metadata"
```

---

### Task 3: Frontend fire mask + utility clip

**Files:**
- Modify: `frontend/src/components/analysis/ReplayAreaEffectsCanvas.jsx`
- Modify: `frontend/src/components/analysis/ReplayAreaEffectsCanvas.test.jsx` (create if missing coverage)
- Create or modify: helper to resolve mask URL — e.g. reuse radar URL pattern under `/api/...` or static path matching how `getDemoRadarMapUrl` works
- Test: `frontend/src/components/analysis/ReplayAreaEffectsCanvas.test.jsx`

**Interfaces:**
- Consumes: `resolve_utility_mask` URL for `(mapName, mapLayer)`; smoke contour already present
- Produces: after drawing smoke/fire soft layers, apply clip; fire no longer uses large radial bloom as final geometry

Find how radar images are served (`getDemoRadarMapUrl`) and mirror for masks, e.g. `/api/radar-maps/de_inferno_utility_mask.png` or bundled static. If API only serves radar stems, extend backend static route **minimally** to also serve `*_utility_mask.png` from the same directory.

- [ ] **Step 1: Write failing clip test**

```js
import { applyUtilityClip } from "./ReplayAreaEffectsCanvas";
// or export a small pure helper from smokeContour / new utilityClip.js

test("applyUtilityClip zeros outside white mask", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(255,0,0,1)";
  ctx.fillRect(0, 0, 4, 4);
  const mask = document.createElement("canvas");
  mask.width = 4;
  mask.height = 4;
  const mctx = mask.getContext("2d");
  mctx.fillStyle = "#000";
  mctx.fillRect(0, 0, 4, 4);
  mctx.fillStyle = "#fff";
  mctx.fillRect(0, 0, 2, 2);
  applyUtilityClip(ctx, mask);
  const outside = ctx.getImageData(3, 3, 1, 1).data[3];
  const inside = ctx.getImageData(0, 0, 1, 1).data[3];
  expect(outside).toBe(0);
  expect(inside).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd frontend
npm test -- src/components/analysis/ReplayAreaEffectsCanvas.test.jsx
```

- [ ] **Step 3: Implement**

1. Export `applyUtilityClip(ctx, maskCanvasOrImage)`:

```js
export function applyUtilityClip(ctx, maskSource) {
  if (!maskSource) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskSource, 0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}
```

2. Load mask image when `mapName`/`mapLayer` changes; if 404, skip clip.
3. Draw smoke contours + fire mask onto offscreen canvas → optional light blur ≤ soft budget → `applyUtilityClip` → draw to visible canvas. **Clip again after blur.**
4. Replace inferno radial bloom loop with occupancy squares / small mask union similar to smoke density at fire cell positions (use `cell_size` ~36 world units as grid size for mask write only, not as painted circle radius). Keep orange coloring + alpha flicker without expanding geometry.

Pass `mapName` into `ReplayAreaEffectsCanvas` from `ReplaySceneCanvas`.

- [ ] **Step 4: Tests PASS**

```bash
cd frontend
npm test -- src/components/analysis/ReplayAreaEffectsCanvas.test.jsx src/components/analysis/smokeContour.test.js
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analysis/ReplayAreaEffectsCanvas.jsx frontend/src/components/analysis/ReplayAreaEffectsCanvas.test.jsx frontend/src/components/analysis/ReplaySceneCanvas.jsx
# plus any mask URL / API route files
git commit -m "feat(replay): clip smoke and fire with utility masks"
```

---

### Task 4: Camera math + controls on `replay-scene`

**Files:**
- Create: `frontend/src/utils/replayCamera.js`
- Create: `frontend/src/utils/replayCamera.test.js`
- Create: `frontend/src/components/analysis/ReplayCameraControls.jsx`
- Modify: `frontend/src/components/analysis/ReplaySceneCanvas.jsx`
- Modify: `frontend/src/components/analysis/Demo2DReplayPreview.jsx`
- Modify: `frontend/src/stores/replayStore.js` (optional `camerasByMap` + bump `REPLAY_STORE_CACHE_VERSION` to 11)

**Interfaces:**

```js
// replayCamera.js
export function computeFitScale(viewport, contentRect, { coverRatio = 0.88 } = {})
export function clampUserZoom(z) // 0.6..3
export function zoomAtPointer({ offsetX, offsetY, scale, pointerX, pointerY, nextScale })
  // returns { offsetX, offsetY, scale }
export function panBy(camera, dx, dy, viewport, sceneSize)
export function cameraCssTransform(camera) // `translate(ox,oy) scale(s)` with transform-origin 0 0
```

Camera state shape: `{ fitScale, userZoom, offsetX, offsetY }` with `finalScale = fitScale * userZoom`.

- [ ] **Step 1: Failing tests for zoom-at-pointer**

```js
import { zoomAtPointer, clampUserZoom, computeFitScale } from "./replayCamera";

test("zoomAtPointer keeps scene point under cursor", () => {
  const before = { offsetX: 10, offsetY: 20, scale: 1 };
  const pointer = { pointerX: 110, pointerY: 220 };
  const sceneX = (pointer.pointerX - before.offsetX) / before.scale;
  const sceneY = (pointer.pointerY - before.offsetY) / before.scale;
  const after = zoomAtPointer({ ...before, ...pointer, nextScale: 2 });
  expect(after.offsetX + sceneX * after.scale).toBeCloseTo(pointer.pointerX, 5);
  expect(after.offsetY + sceneY * after.scale).toBeCloseTo(pointer.pointerY, 5);
});

test("computeFitScale uses content rect", () => {
  const s = computeFitScale({ width: 880, height: 880 }, { width: 900, height: 790 }, { coverRatio: 0.88 });
  expect(s).toBeCloseTo(Math.min(880 / 900, 880 / 790) * 0.88, 5);
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd frontend
npm test -- src/utils/replayCamera.test.js
```

- [ ] **Step 3: Implement math + UI**

1. Implement `replayCamera.js` as specified.
2. `ReplayCameraControls`: buttons `−` / `${Math.round(userZoom*100)}%` / `+` / `适应`; step `userZoom *= 1.15` then clamp.
3. Restructure scene DOM in `ReplaySceneCanvas` (or parent):

```jsx
<div className="replay-viewport relative ..." ref={viewportRef} onWheel={...}>
  <div
    className="replay-scene absolute left-0 top-0"
    style={{
      width: 1024,
      height: 1024,
      transform: cameraCssTransform({
        offsetX: camera.offsetX,
        offsetY: camera.offsetY,
        scale: camera.fitScale * camera.userZoom,
      }),
      transformOrigin: "0 0",
    }}
  >
    {/* radar img + effects + svg + markers — NO separate CSS map scale */}
  </div>
  <ReplayCameraControls ... />
</div>
```

4. Wheel: `preventDefault`, `zoomAtPointer`.
5. Pan: middle mouse, or Space+LMB when `userZoom > 1`.
6. Fit on map change; preserve camera when round/layer changes same map; restore from store if present.
7. Remove any remaining Nuke/map-name CSS zoom if found.

World→percent mapping stays relative to the 1024 scene (content_rect already inside transform). Do not bake camera into `map_transform`.

- [ ] **Step 4: Tests PASS**

```bash
cd frontend
npm test -- src/utils/replayCamera.test.js src/utils/replayRadarTransform.test.js
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/replayCamera.js frontend/src/utils/replayCamera.test.js frontend/src/components/analysis/ReplayCameraControls.jsx frontend/src/components/analysis/ReplaySceneCanvas.jsx frontend/src/components/analysis/Demo2DReplayPreview.jsx frontend/src/stores/replayStore.js
git commit -m "feat(replay): add whole-scene camera zoom and pan controls"
```

---

### Task 5: C4 planted/dropped visuals + plant timeline markers

**Files:**
- Create: `frontend/src/components/analysis/ReplayBombMarker.jsx`
- Create: `frontend/src/components/analysis/ReplayBombMarker.test.jsx`
- Modify: `frontend/src/components/analysis/ReplaySceneCanvas.jsx`
- Modify: `frontend/src/components/analysis/Demo2DReplayPreview.jsx`
- Modify: `frontend/src/pages/DemoAnalysisPreviewPage.test.jsx` if it asserts C4 markup

**Interfaces:**
- Consumes: `computeBombState` → `{ status, position, site, ... }`
- Produces: distinct DOM for `dropped` vs `planted`; timeline includes `plant`

- [ ] **Step 1: Failing component tests**

```jsx
import { render, screen } from "@testing-library/react";
import ReplayBombMarker from "./ReplayBombMarker";

test("dropped has no pulse rings", () => {
  render(<ReplayBombMarker status="dropped" site="" />);
  expect(screen.getByTitle(/掉落/)).toBeInTheDocument();
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(0);
});

test("planted renders two pulse rings", () => {
  render(<ReplayBombMarker status="planted" site="A" />);
  expect(screen.getByTitle(/放置|安放|下包/)).toBeInTheDocument();
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(2);
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd frontend
npm test -- src/components/analysis/ReplayBombMarker.test.jsx
```

- [ ] **Step 3: Implement marker + timeline**

`ReplayBombMarker.jsx`:

- `dropped`: smaller dark-gold static chip
- `planted`: orange-red chip + two `.planted-c4-ring` with CSS:

```css
@keyframes planted-c4-pulse {
  0% { transform: scale(0.55); opacity: 0.85; }
  100% { transform: scale(2.5); opacity: 0; }
}
.planted-c4-ring { animation: planted-c4-pulse 1.2s linear infinite; }
.planted-c4-ring:nth-child(2) { animation-delay: 0.6s; }
```

- `defused` / `exploded`: no rings (opacity muted ok)

In `Demo2DReplayPreview.jsx`:

```js
const eventMarkers = roundEvents.filter((e) =>
  e.type === "kill" || e.type === "grenade" || e.type === "plant"
);
```

Style plant markers orange-red; onClick seek to `event.tick` (existing seek helper). Add legend entry「下包」.

Replace inline C4 chip in `ReplaySceneCanvas` with `<ReplayBombMarker status={bombState.status} ... />`.

- [ ] **Step 4: Tests PASS**

```bash
cd frontend
npm test -- src/components/analysis/ReplayBombMarker.test.jsx src/pages/DemoAnalysisPreviewPage.test.jsx
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analysis/ReplayBombMarker.jsx frontend/src/components/analysis/ReplayBombMarker.test.jsx frontend/src/components/analysis/ReplaySceneCanvas.jsx frontend/src/components/analysis/Demo2DReplayPreview.jsx frontend/src/pages/DemoAnalysisPreviewPage.test.jsx
git commit -m "feat(replay): distinguish planted C4 and mark plants on timeline"
```

---

### Task 6: Unify playback interpolators; time_sec as source of truth

**Files:**
- Modify: `frontend/src/components/analysis/Demo2DReplayPreview.jsx`
- Modify: `frontend/src/components/analysis/ReplaySceneCanvas.jsx`
- Modify: `frontend/src/utils/replayPlayback.test.js` (add regression if needed)

**Interfaces:**
- Consumes: `createReplayClock`, `interpolateReplayFrame`, `frameBracket`, `findPreviousFrameIndex` from `frontend/src/utils/replayPlayback.js`
- Produces: no local duplicate `interpolateReplayFrame` / smoothstep paths in the two components

- [ ] **Step 1: Write failing lint-style test (grep via vitest)**

```js
// frontend/src/utils/replayPlayback.dedupe.test.js
import fs from "node:fs";
import path from "node:path";

test("preview and scene do not redefine interpolateReplayFrame", () => {
  for (const rel of [
    "src/components/analysis/Demo2DReplayPreview.jsx",
    "src/components/analysis/ReplaySceneCanvas.jsx",
  ]) {
    const text = fs.readFileSync(path.resolve(rel), "utf8");
    expect(text).not.toMatch(/function interpolateReplayFrame\s*\(/);
    expect(text).not.toMatch(/smoothstep/);
  }
});
```

- [ ] **Step 2: Run — may FAIL if duplicates exist**

```bash
cd frontend
npm test -- src/utils/replayPlayback.dedupe.test.js
```

- [ ] **Step 3: Delete duplicates; import shared helpers**

- Remove local interpolate copies.
- Keep rAF loop: `playheadSeconds = clock.getPlayheadSeconds()` → `interpolateReplayFrame(frames, tick, playheadSeconds)` for scene.
- Scrubber may still bind a derived frame index for display, but seeking must `clock.seek(seconds)` from `frames[i].time_sec`.
- Confirm smoke/fire still use tick with crossfade (already in effects canvas).

- [ ] **Step 4: Full playback tests PASS**

```bash
cd frontend
npm test -- src/utils/replayPlayback.test.js src/utils/replayPlayback.dedupe.test.js
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analysis/Demo2DReplayPreview.jsx frontend/src/components/analysis/ReplaySceneCanvas.jsx frontend/src/utils/replayPlayback.dedupe.test.js
git commit -m "refactor(replay): use shared time_sec playback interpolation only"
```

---

### Task 7: End-to-end verification + acceptance checklist

**Files:** none required beyond fixes discovered during verification

- [ ] **Step 1: Run full backend + frontend tests**

```bash
cd backend
python -m pytest tests/test_replay_effects.py tests/test_replay_frames_cache.py tests/test_smoke_voxel_decode.py tests/test_generate_radar_derived_assets.py -v

cd ../frontend
npm test
```

Expected: all PASS.

- [ ] **Step 2: Manual checklist (dev server)**

```bash
# terminal 1
cd backend && uvicorn app.main:app --reload --port 8000
# terminal 2
cd frontend && npm run dev
```

Verify against design §11 / original plan §14 for available demos:

1. Smoke center stable; no map-name smoke patches in diff (`rg "de_anubis|de_nuke" backend/app/parser/smoke_voxel_decode.py` → no axis branches)
2. Smoke/fire do not paint deep into outer black radar void on Inferno tree / map edge (approx OK)
3. Maps Fit similarly; Nuke not specially CSS-scaled
4. Wheel / `+`/`−`/`适应` zoom whole scene including players & utility
5. Dropped vs planted C4 distinct; plant marker seeks
6. Leave 2D tab mid-load → return reuses store promise (existing); UI cache labels still honest
7. Backend still 8Hz request fps

- [ ] **Step 3: Fix any regressions found; commit if needed**

```bash
git commit -m "fix(replay): address gap-fill verification regressions"
```

- [ ] **Step 4: Summarize delivery**

Provide: changed file list, mask generation method (radar luminance), test commands + results, cache version bumps (`effects 6`, `replayStore 11`, `transform_version 3`).

---

## Spec coverage self-check

| Spec section | Task(s) |
|--------------|---------|
| §4 stable_origin / lifecycle | Task 1 |
| §5 utility clip + fire mask | Tasks 2–3 |
| §6 content_rect Fit | Tasks 2, 4 |
| §7 Camera | Task 4 |
| §8 C4 + timeline | Task 5 |
| §9 playback clock | Task 6 |
| §10 cache (already done; version bumps) | Tasks 1–2, 4 |
| §11 acceptance / no forbidden patches | Task 7 |

## Placeholder scan

No TBD/TODO left in task steps; mask URL serving must be resolved in Task 3 by mirroring existing `getDemoRadarMapUrl` / static radar route (inspect at implementation time, extend same route — do not invent a second asset root).

## Type consistency

- Track field: `stable_origin: number[3]`
- Camera: `{ fitScale, userZoom, offsetX, offsetY }`
- Content fields: `content_x|y|width|height` + `transform_version`
- Effects cache v6; frontend store v11; transform_version 3
