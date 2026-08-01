# demoparser sticker attribute overlay

Replaces demoparser's fixed-offset `weapon_stickers` decode with
**attribute-definition indexed** sticker extraction.

Logic ported from [unicbm/demotracer](https://github.com/unicbm/demotracer)
(`stickers_from_attributes` / `find_weapon_econ_attributes_and_stickers`)
with the author's permission to reuse.

Applied by `build-wheel.ps1` after `demoparser2-v0.41.4.patch`.
