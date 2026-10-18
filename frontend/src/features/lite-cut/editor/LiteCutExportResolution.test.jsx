import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasPane, ExportPane } from "./LiteCutPropertyPanes.jsx";
import { getLiteCutResolutionError } from "../state/exportResolution.js";
import { startLiteCutExport } from "../state/exportUtils.js";
import { liteCutClient } from "../api/liteCutClient.js";
import { useLiteCutExportController } from "../controllers/useLiteCutExportController.js";
import { useLiteCutEditorStore } from "../state/editorStore.js";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import { formatMontageApiError } from "../../../utils/formatMontageApiError.js";

vi.mock("../api/liteCutClient.js", () => ({liteCutClient: {
  startExport: vi.fn(), listExports: vi.fn(),
}}));

beforeEach(() => {
  vi.clearAllMocks();
  useLocaleStore.getState().hydrate("zh");
  liteCutClient.listExports.mockResolvedValue({items:[]});
  useLiteCutEditorStore.setState({body:null});
});

describe("LiteCut resolution guard", () => {
  it.each([[1155,900], [1920,1081], [1155,901]])("blocks %i × %i and unlocks export after correction", (width, height) => {
    const onExport = vi.fn();
    const props = {outputDir:"D:\\exports", filename:"clip.mp4", clipCount:1, onExport};
    const {rerender} = render(<ExportPane {...props} width={width} height={height} />);
    expect(screen.getByRole("alert").textContent).toContain(`${width} × ${height}`);
    expect(screen.getByRole("alert").textContent).toContain("必须为正偶数");
    const button = screen.getByRole("button", {name:"使用 FFmpeg 导出"});
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onExport).not.toHaveBeenCalled();
    rerender(<ExportPane {...props} width={1156} height={900} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onExport).toHaveBeenCalledOnce();
  });

  it("warns while editing the canvas without silently changing an odd size", () => {
    const change = vi.fn();
    render(<CanvasPane width={1156} height={900} onOutputSettingsChange={change} />);
    fireEvent.change(screen.getByLabelText("画布宽度"), {target:{value:"1155"}});
    expect(screen.getByRole("alert").textContent).toContain("1155 × 900");
    expect(screen.getByLabelText("画布宽度").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("画布高度").getAttribute("aria-invalid")).toBe("false");
    fireEvent.blur(screen.getByLabelText("画布宽度"));
    expect(change).toHaveBeenCalledWith({width:1155});
  });

  it("rejects odd dimensions before any export API call", async () => {
    await expect(startLiteCutExport({body:{output:{width:1155,height:900}},
      outputDir:"D:\\exports", filename:"clip.mp4"})).rejects.toMatchObject({code:"LITECUT_EXPORT_RESOLUTION_INVALID"});
    expect(liteCutClient.startExport).not.toHaveBeenCalled();
  });

  it("checks the current store before saving or opening the progress dialog", async () => {
    const stale = {output:{width:1920,height:1080}};
    useLiteCutEditorStore.setState({body:{output:{width:1155,height:900}}});
    const saveProject = vi.fn(), onExportPhaseChange = vi.fn();
    const {result} = renderHook(() => useLiteCutExportController({body:stale, dirty:true,
      exportableClipCount:1, outputDir:"D:\\exports", outputDirHint:"", outputFilename:"clip.mp4",
      saveProject, onExportPhaseChange, t:(key)=>key}));
    await act(async () => {await result.current.handleExport();});
    expect(result.current.exporting).toBe(false);
    expect(result.current.exportError).toBe("liteCut.exportResolutionInvalid");
    expect(saveProject).not.toHaveBeenCalled();
    expect(onExportPhaseChange).not.toHaveBeenCalled();
    expect(liteCutClient.startExport).not.toHaveBeenCalled();
  });

  it("passes corrected dimensions unchanged and translates server validation", async () => {
    liteCutClient.startExport.mockResolvedValue({export_id:7});
    const body = {output:{width:1156,height:900}};
    await startLiteCutExport({body,outputDir:"D:\\exports",filename:"clip.mp4"});
    expect(liteCutClient.startExport).toHaveBeenCalledWith(expect.objectContaining({body}));
    expect(getLiteCutResolutionError({})).toBeNull();
    const t = vi.fn(()=>"resolution error");
    expect(formatMontageApiError({response:{data:{detail:{code:"LITECUT_EXPORT_RESOLUTION_INVALID",
      params:{width:1155,height:900}}}}},t)).toBe("resolution error");
    expect(t).toHaveBeenCalledWith("liteCut.exportResolutionInvalid",{width:1155,height:900});
  });
});
