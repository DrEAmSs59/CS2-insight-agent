import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LiteCutMediaBin, { extractDroppedAssetPaths, LocalAssetCard } from "./LiteCutMediaBin.jsx";

const liteCutClientMock = vi.hoisted(() => ({
  linkAssets: vi.fn(),
  listAssets: vi.fn(),
  listRecordedClips: vi.fn(),
  patchRecordedClipDuration: vi.fn(),
  pickFiles: vi.fn(),
  validateAssets: vi.fn(),
}));

const desktopBridgeMock = vi.hoisted(() => ({
  onFileDragDrop: vi.fn(() => vi.fn()),
  resolveDroppedFilePaths: vi.fn(),
  showOpenDialog: vi.fn(),
}));

vi.mock("../../../i18n/useT.js", () => ({
  useT: () => (key) => key,
}));

vi.mock("../api/liteCutClient.js", () => ({
  getLiteCutAssetStreamUrl: (id) => `/stream/${id}`,
  getRecordedClipStreamUrl: (id) => `/recorded/${id}`,
  liteCutClient: liteCutClientMock,
}));

vi.mock("../../../desktop/desktopBridge.js", () => ({
  desktopBridge: desktopBridgeMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  desktopBridgeMock.onFileDragDrop.mockImplementation(() => vi.fn());
  desktopBridgeMock.resolveDroppedFilePaths.mockResolvedValue([]);
  desktopBridgeMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  liteCutClientMock.linkAssets.mockResolvedValue({ items: [] });
  liteCutClientMock.listAssets.mockResolvedValue({ items: [] });
  liteCutClientMock.listRecordedClips.mockResolvedValue({ items: [] });
  liteCutClientMock.patchRecordedClipDuration.mockResolvedValue({});
  liteCutClientMock.pickFiles.mockResolvedValue({ paths: [] });
  liteCutClientMock.validateAssets.mockResolvedValue({ items: [] });
});

function renderAsset(overrides = {}) {
  const onAddToTimeline = vi.fn();
  const onRelinkAsset = vi.fn();
  const result = render(
    <LocalAssetCard
      item={{
        id: 42,
        name: "match.mkv",
        kind: "video",
        asset_registered: true,
        source_status: "available",
        source_available: true,
        preview_proxy_version: "source-123",
        ...overrides,
      }}
      onAddToTimeline={onAddToTimeline}
      onRelinkAsset={onRelinkAsset}
    />,
  );
  return { ...result, onAddToTimeline, onRelinkAsset };
}

describe("LocalAssetCard linked-source behavior", () => {
  it("keeps an available linked source draggable and addable", () => {
    const { container, onAddToTimeline } = renderAsset();

    expect(container.querySelector('[draggable="true"]')).not.toBeNull();
    fireEvent.click(screen.getByTitle("liteCut.media.addToTimeline"));
    expect(onAddToTimeline).toHaveBeenCalledTimes(1);
  });

  it("blocks missing sources and offers relink instead", () => {
    const { container, onRelinkAsset } = renderAsset({
      source_status: "missing",
      source_available: false,
    });

    expect(container.querySelector('[draggable="true"]')).toBeNull();
    expect(screen.queryByTitle("liteCut.media.addToTimeline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.media.relink" }));
    expect(onRelinkAsset).toHaveBeenCalledTimes(1);
  });
});

describe("LiteCut local asset picker and drop zone", () => {
  function renderMediaBin() {
    return render(
      <LiteCutMediaBin
        projectId={7}
        projectBody={{ tracks: [], overlays: [], audio: {} }}
      />,
    );
  }

  it("opens the native multi-file picker and immediately links selected paths", async () => {
    desktopBridgeMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["C:\\media\\one.mp4", "D:\\audio\\two.wav"],
    });
    renderMediaBin();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.media.localUpload" }));

    fireEvent.click(await screen.findByRole("button", { name: /liteCut\.media\.selectOrDrop/ }));

    await waitFor(() => expect(liteCutClientMock.linkAssets).toHaveBeenCalledWith({
      paths: ["C:\\media\\one.mp4", "D:\\audio\\two.wav"],
      projectId: 7,
    }));
    await waitFor(() => expect(
      screen.getByRole("button", { name: /liteCut\.media\.selectOrDrop/ }).disabled,
    ).toBe(false));
    expect(screen.queryByText("liteCut.media.linkFailed")).toBeNull();
    expect(desktopBridgeMock.showOpenDialog.mock.calls[0][0].properties)
      .toEqual(["openFile", "multiSelections"]);
  });

  it("links absolute paths dropped from Windows without uploading File objects", async () => {
    renderMediaBin();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.media.localUpload" }));
    const dropZone = await screen.findByRole("button", { name: /liteCut\.media\.selectOrDrop/ });

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [{ name: "match.mkv", path: "C:\\captures\\match.mkv" }],
        getData: () => "",
        types: ["Files"],
      },
    });

    await waitFor(() => expect(liteCutClientMock.linkAssets).toHaveBeenCalledWith({
      paths: ["C:\\captures\\match.mkv"],
      projectId: 7,
    }));
  });

  it("resolves WebView-hidden drop paths and links the original files", async () => {
    const hiddenFile = new File(["video"], "hidden.mp4", { type: "video/mp4" });
    desktopBridgeMock.resolveDroppedFilePaths.mockResolvedValue([
      "E:\\captures\\hidden.mp4",
    ]);
    renderMediaBin();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.media.localUpload" }));
    const dropZone = await screen.findByRole("button", { name: /liteCut\.media\.selectOrDrop/ });

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [hiddenFile],
        getData: () => "",
        types: ["Files"],
      },
    });

    expect(desktopBridgeMock.resolveDroppedFilePaths).toHaveBeenCalledWith([hiddenFile]);
    await waitFor(() => expect(liteCutClientMock.linkAssets).toHaveBeenCalledWith({
      paths: ["E:\\captures\\hidden.mp4"],
      projectId: 7,
    }));
  });

  it("links paths from Tauri's native Windows drop event inside the drop zone", async () => {
    let nativeDropHandler = null;
    desktopBridgeMock.onFileDragDrop.mockImplementation((callback) => {
      nativeDropHandler = callback;
      return vi.fn();
    });
    renderMediaBin();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.media.localUpload" }));
    const dropZone = await screen.findByRole("button", { name: /liteCut\.media\.selectOrDrop/ });
    vi.spyOn(dropZone, "getBoundingClientRect").mockReturnValue({
      left: 10, right: 210, top: 20, bottom: 140, width: 200, height: 120, x: 10, y: 20,
      toJSON: () => ({}),
    });
    await waitFor(() => expect(nativeDropHandler).toBeTypeOf("function"));

    act(() => nativeDropHandler({
      type: "drop",
      paths: ["D:\\captures\\native.mp4"],
      position: { x: 100, y: 80 },
    }));

    await waitFor(() => expect(liteCutClientMock.linkAssets).toHaveBeenCalledWith({
      paths: ["D:\\captures\\native.mp4"],
      projectId: 7,
    }));
  });

  it("extracts file URIs but ignores browser File objects that hide absolute paths", () => {
    expect(extractDroppedAssetPaths({
      files: [new File(["video"], "hidden.mp4")],
      getData: (type) => type === "text/uri-list" ? "file:///C:/My%20Videos/match.mp4" : "",
    })).toEqual(["C:\\My Videos\\match.mp4"]);
    expect(extractDroppedAssetPaths({
      files: [new File(["video"], "hidden.mp4")],
      getData: () => "",
    })).toEqual([]);
  });
});
