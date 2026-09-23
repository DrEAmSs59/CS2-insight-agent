import { existsSync } from "node:fs";
import { join } from "node:path";

/** Include every pinned map build so packaged clients also work after rollback. */
export function collectRainRuntimePaths(maps, payloadRoot) {
  const keep = new Set(["manifest.json"]);
  for (const [mapName, profile] of Object.entries(maps)) {
    const variants = profile?.source_variants ?? [];
    if (!Array.isArray(variants)) {
      throw new Error(`Invalid rain source variants: ${mapName}`);
    }
    for (const sourceProfile of [profile, ...variants]) {
      const replacements = sourceProfile?.loose_outer_replacements;
      if (!Array.isArray(replacements) || replacements.length === 0) {
        throw new Error(`Final rain profile has no runtime payloads: ${mapName}`);
      }
      for (const replacement of replacements) {
        const relativePath = String(replacement?.payload_relative_path || "")
          .replaceAll("\\", "/");
        if (!relativePath || relativePath.includes(":")
          || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
          throw new Error(`Invalid final rain payload path for ${mapName}`);
        }
        const source = join(payloadRoot, ...relativePath.split("/"));
        if (!existsSync(source)) throw new Error(`Missing final rain payload: ${source}`);
        keep.add(relativePath.toLowerCase());
      }
    }
  }
  return keep;
}
