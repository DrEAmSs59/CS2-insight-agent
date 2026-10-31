/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useLiteCutExportController } from "./useLiteCutExportController";
import { startLiteCutExport } from "../state/exportUtils";
vi.mock("../state/exportUtils", () => ({
  listLiteCutExports: vi.fn(async () => ({ items: [] })), startLiteCutExport: vi.fn(),
  getLiteCutExportStatus: vi.fn(), cancelLiteCutExport: vi.fn(), defaultLiteCutFilename: () => "out.mp4",
}));
vi.mock("../state/editorStore", () => ({ useLiteCutEditorStore: { getState: () => ({ body: { output: { width: 1920, height: 1080 } } }) } }));
it("does not start an export against old persisted data after save fails", async () => {
  const saveProject = vi.fn(async () => ({ ok: false }));
  const { result } = renderHook(() => useLiteCutExportController({
    body: { output: {} }, dirty: true, exportableClipCount: 1, outputDir: "C:/exports", outputDirHint: "",
    outputFilename: "out.mp4", projectId: 1, projectName: "project", saveProject, patchOutput: vi.fn(), t: key => key,
  }));
  await act(async () => { await result.current.handleExport(); });
  expect(saveProject).toHaveBeenCalledOnce();
  expect(startLiteCutExport).not.toHaveBeenCalled();
  expect(result.current.exporting).toBe(false);
  expect(result.current.exportError).toContain("保存失败");
});
