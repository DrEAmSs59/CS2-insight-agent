import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

test("preview and scene do not redefine interpolateReplayFrame", () => {
  for (const rel of [
    "src/features/demo-analysis/replay/Demo2DReplayPreview.jsx",
    "src/features/demo-analysis/replay/ReplaySceneCanvas.jsx",
  ]) {
    const text = fs.readFileSync(path.resolve(rel), "utf8");
    expect(text).not.toMatch(/function interpolateReplayFrame\s*\(/);
    expect(text).not.toMatch(/smoothstep/);
  }
});

test("64Hz interpolation stays isolated from stepped event and effect layers", () => {
  const preview = fs.readFileSync(
    path.resolve("src/features/demo-analysis/replay/Demo2DReplayPreview.jsx"),
    "utf8",
  );
  const scene = fs.readFileSync(
    path.resolve("src/features/demo-analysis/replay/ReplaySceneCanvas.jsx"),
    "utf8",
  );
  expect(preview).toContain("const interpolatedFrameDurationMs = 1000 / 64");
  expect(scene).toContain("interpolateReplayFrameAtPosition(frames, playhead.position)");
  expect(scene).toContain("const currentTick = Number(eventFrame.tick");
  expect(scene).not.toMatch(/const currentTick = Number\(visualFrame\.tick/);
});
