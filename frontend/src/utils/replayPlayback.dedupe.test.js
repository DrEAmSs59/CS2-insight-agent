import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

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
