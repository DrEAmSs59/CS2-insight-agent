# Smoke geometry verification correction

**Corrected:** 2026-07-26

The 2026-07-25 conclusion in this file was wrong. It treated the type-3 seed
list as the complete render geometry and used seed-centroid distance to choose
an axis mapping. A centroid score is invariant under many planar rotations and
reflections, so it could not establish that the prior `zyx`, mirrored-X,
20-world-unit mapping was correct.

## Actual journal format

- Each journal record is `u16 sequence`, `u16 payload length`, then payload.
- Type 3 is a keyframe: phase, type, 8-byte XYZ seed entries, and Morton mask
  entries.
- Type 2 replaces Morton masks in the current grid state.
- Type 0 is a heartbeat and does not change geometry.
- Both Morton levels interleave X, Y, Z.
- The 32x32x32 cell grid uses 12 world units per cell and centre 15.5, with no
  planar mirror: `world = detonation + (grid - 15.5) * 12`.
- Mask bits describe the smoke shell. Boundary flood-fill reconstructs the
  enclosed volume before XY projection.

## Why the old preview was rotated and undersized

The decoder consumed only the roughly 44 initialization seeds, interpreted
their bytes as Z/Y/X, ignored all trailing mask data and all type-2 deltas, then
projected them at 20 units with mirrored world X. The Canvas therefore received
already-wrong sparse cells; its common world-to-radar transform was not the
source of this smoke-only fault.

## Real-demo check

On a local Mirage demo, the first smoke keyframe contains 44 seeds plus 36 mask
entries. The old path produced 15 unique XY columns. Reconstructing the keyframe
produces 619 occupied 3D cells and 190 unique XY columns; the emitted replay
sample spans 180 by 132 world units at a 12-unit cell size. The complete first
smoke lifecycle builds 14 changing samples with no decoder warnings.

An end-to-end geometry build over 17,787 smoke rows (92 lifecycles, 1,608
changing samples) completes in about 5.6 seconds on the development machine.
The equivalent per-voxel Python flood-fill took about 84.8 seconds, so the final
implementation performs the same boundary fill with NumPy array shifts.

The legacy axis-candidate script remains only as a coarse seed-corruption
diagnostic. It now enumerates all XYZ permutations and explicitly does not claim
that centroid ranking proves orientation.
