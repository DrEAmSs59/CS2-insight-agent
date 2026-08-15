# demoparser sticker attribute overlay

Replaces demoparser's fixed-offset `weapon_stickers` decode with
**attribute-definition indexed** sticker extraction.

It also preserves the decoded length of `Vector<Serializer<CEconItemAttribute>>`
per entity and vector field path. When an instance delta shortens that vector,
the entity patch removes the flattened definition/raw-value tail, advances the
cosmetic revision, and constrains sticker collection to the current length.

Logic ported from [unicbm/demotracer](https://github.com/unicbm/demotracer)
(`stickers_from_attributes` / `find_weapon_econ_attributes_and_stickers`)
with the author's permission to reuse.

Applied by `build-wheel.ps1` after `demoparser2-v0.41.4.patch`.
`entity-vector-length.patch` is applied after the three overlay source files.
