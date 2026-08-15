/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MontageWorkbenchDrawer from "./MontageWorkbenchDrawer.jsx";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  consoleProps: null,
  draftPanelProps: null,
  materialProps: null,
  translate: (key) => key,
}));

const desktopBridgeMock = vi.hoisted(() => ({
  chooseDirectory: vi.fn(),
}));

vi.mock("../api/api", () => ({
  default: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
  },
  API_BASE_URL: "http://127.0.0.1:8000/api",
}));

vi.mock("../i18n/useT.js", () => ({
  useT: () => mocks.translate,
}));

vi.mock("../desktop/desktopBridge.js", () => ({
  desktopBridge: desktopBridgeMock,
  isDesktopApp: true,
}));

vi.mock("./FfmpegRequiredDialog", () => ({ default: () => null }));
vi.mock("./montage/MontageHistoryPanel", () => ({ default: () => null }));
vi.mock("./montage/MontageDraftPanel", () => ({
  default: (props) => {
    mocks.draftPanelProps = props;
    return null;
  },
}));
vi.mock("./montage/MontageStyleConsole", () => ({
  MontageStyleConsole: (props) => {
    mocks.consoleProps = props;
    return null;
  },
}));
vi.mock("./montage/MontageWorkbenchPanels", () => ({
  MontageWorkbenchToolbar: () => null,
  MontageOrchestrationTimeline: () => null,
  MontageMaterialPoolCard: (props) => {
    mocks.materialProps = props;
    return null;
  },
}));

describe("MontageWorkbenchDrawer", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.put.mockReset();
    desktopBridgeMock.chooseDirectory.mockReset();
    mocks.consoleProps = null;
    mocks.draftPanelProps = null;
    mocks.materialProps = null;
    mocks.post.mockResolvedValue({ data: {} });
    mocks.put.mockResolvedValue({ data: { status: "ok" } });
  });

  it("renders the workbench as four independent rounded blocks", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "" } });
      if (url === "/recorded-clips") return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.queryByText("montage.ffmpegChecking")).toBeNull());
    const controlsToggle = screen.getByTestId("montage-pool-controls-toggle");
    expect(controlsToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("montage-pool-controls-body")).toBeNull();
    for (const testId of [
      "montage-pool-filters-card",
      "montage-pool-list-card",
      "montage-orchestration-card",
      "montage-console-card",
    ]) {
      const block = screen.getByTestId(testId);
      expect(block.className).toContain("rounded-[10px]");
      expect(block.className).toContain("border-cs2-border");
      expect(block.className).toContain("bg-cs2-bg-card");
    }
    expect(screen.getByTestId("montage-workbench-content-card").className).not.toContain("shadow-sm");
    fireEvent.click(controlsToggle);
    expect(controlsToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("montage-pool-controls-body")).toBeTruthy();
  });

  it("rechecks FFmpeg silently when the window regains focus", async () => {
    const gateResolvers = [];
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") {
        return new Promise((resolve) => gateResolvers.push(resolve));
      }
      if (url === "/recorded-clips") return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByText("montage.ffmpegChecking")).toBeTruthy();
    await waitFor(() => expect(gateResolvers).toHaveLength(1));

    await act(async () => {
      gateResolvers[0]({ data: { ok: true, framemeld_available: true } });
    });
    await waitFor(() => expect(screen.queryByText("montage.ffmpegChecking")).toBeNull());

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(gateResolvers).toHaveLength(2));

    expect(screen.queryByText("montage.ffmpegChecking")).toBeNull();

    await act(async () => {
      gateResolvers[1]({ data: { ok: true, framemeld_available: true } });
    });
  });

  it("restores and persists the montage export directory", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") {
        return Promise.resolve({ data: { ok: true, framemeld_available: true } });
      }
      if (url === "/config") {
        return Promise.resolve({ data: { montage_export_dir: "I:\\exports\\saved" } });
      }
      if (url === "/recorded-clips") return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.consoleProps?.outputDir).toBe("I:\\exports\\saved"));

    act(() => mocks.consoleProps.onOutputDirChange("D:\\montage\\next"));
    await waitFor(() => expect(mocks.consoleProps?.outputDir).toBe("D:\\montage\\next"));
    await act(async () => {
      await mocks.consoleProps.onOutputDirCommit();
    });

    expect(mocks.put).toHaveBeenCalledWith("/config", {
      montage_export_dir: "D:\\montage\\next",
    });
  });

  it("clears the persisted directory when returning to automatic mode", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") {
        return Promise.resolve({ data: { montage_export_dir: "I:\\exports\\saved" } });
      }
      if (url === "/recorded-clips") return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.consoleProps?.outputDir).toBe("I:\\exports\\saved"));
    act(() => mocks.consoleProps.onOutputDirClear());

    await waitFor(() => {
      expect(mocks.put).toHaveBeenCalledWith("/config", { montage_export_dir: "" });
    });
  });

  it("fills and persists the directory selected by the native folder picker", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "" } });
      if (url === "/recorded-clips") return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });
    desktopBridgeMock.chooseDirectory.mockResolvedValue("D:\\Videos\\Montage");

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.consoleProps).toBeTruthy());
    await act(async () => {
      await mocks.consoleProps.onOutputDirBrowse();
    });

    expect(desktopBridgeMock.chooseDirectory).toHaveBeenCalledWith(
      "",
      "montage.consoleExportDirBrowse",
    );
    await waitFor(() => expect(mocks.consoleProps.outputDir).toBe("D:\\Videos\\Montage"));
    expect(mocks.put).toHaveBeenCalledWith("/config", {
      montage_export_dir: "D:\\Videos\\Montage",
    });
  });

  it("restores a saved draft and skips source clips that no longer exist", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "" } });
      if (url === "/recorded-clips") {
        return Promise.resolve({
          data: {
            items: [
              { id: 5, output_path: "D:\\clips\\five.mp4", duration_sec: 4 },
              { id: 9, output_path: "D:\\clips\\nine.mp4", duration_sec: 6 },
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.draftPanelProps).toBeTruthy());
    await waitFor(() => expect(mocks.materialProps?.clip?.id).toBe(9));
    await act(async () => {
      await mocks.draftPanelProps.onOpenDraft({
        id: 12,
        name: "Saved ACE",
        updated_at: "2026-08-09T12:00:00Z",
        body: {
          recorded_clip_ids: [5, 99],
          bgm_path: "D:\\Music\\ace.mp3",
          bgm_volume: 0.85,
          output_filename: "saved_ace.mp4",
          transitions: { 5: { type: "fade", duration: 0.4 } },
          theme_id: "esports",
        },
      });
    });

    await waitFor(() => expect(mocks.consoleProps.outputFilename).toBe("saved_ace.mp4"));
    expect(mocks.consoleProps.bgmPath).toBe("D:\\Music\\ace.mp3");
    expect(mocks.consoleProps.bgmVolume).toBe(85);
    expect(mocks.consoleProps.clips.map((clip) => clip.id)).toEqual([5]);
    expect(screen.getByText("montage.draftsLoadedWithMissing")).toBeTruthy();
  });

  it("clears a stale FrameMeld draft setting and never exports mixed frame rates as enabled", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") {
        return Promise.resolve({ data: { ok: true, framemeld_available: true } });
      }
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "D:\\Exports" } });
      if (url === "/recorded-clips") {
        return Promise.resolve({
          data: {
            items: [
              { id: 5, output_path: "D:\\clips\\60fps.mp4", duration_sec: 4, fps: 60 },
              { id: 9, output_path: "D:\\clips\\120fps.mp4", duration_sec: 6, fps: 120 },
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    mocks.post.mockImplementation((url) => {
      if (url === "/montage/export") return Promise.resolve({ data: {} });
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.draftPanelProps).toBeTruthy());
    await waitFor(() => expect(mocks.materialProps?.clip?.id).toBe(9));
    await act(async () => {
      await mocks.draftPanelProps.onOpenDraft({
        id: 21,
        name: "Mixed FPS",
        body: {
          recorded_clip_ids: [5, 9],
          output_filename: "mixed.mp4",
          framemeld_enabled: true,
        },
      });
    });

    await waitFor(() => {
      expect(mocks.consoleProps.framemeldSourceSummary.hasMixedFrameRates).toBe(true);
      expect(mocks.consoleProps.framemeldEnabled).toBe(false);
    });
    await act(async () => {
      await mocks.consoleProps.onExport();
    });

    const exportCall = mocks.post.mock.calls.find(([url]) => url === "/montage/export");
    expect(exportCall).toBeTruthy();
    expect(exportCall[1].framemeld_enabled).toBe(false);
  });

  it("includes an intro video in the project FrameMeld boundary", async () => {
    const introPath = "D:\\clips\\intro-60fps.mp4";
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") {
        return Promise.resolve({ data: { ok: true, framemeld_available: true } });
      }
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "D:\\Exports" } });
      if (url === "/recorded-clips") {
        return Promise.resolve({
          data: { items: [{ id: 5, output_path: "D:\\clips\\120fps.mp4", duration_sec: 4, fps: 120 }] },
        });
      }
      return Promise.resolve({ data: {} });
    });
    mocks.post.mockImplementation((url, body) => {
      if (url === "/montage/media-fps") {
        return Promise.resolve({
          data: { items: [{ path: body.paths[0], kind: "video", fps: 60, status: "ok" }] },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.draftPanelProps).toBeTruthy());
    await waitFor(() => expect(mocks.materialProps?.clip?.id).toBe(5));
    await act(async () => {
      await mocks.draftPanelProps.onOpenDraft({
        id: 22,
        name: "Intro mismatch",
        body: {
          recorded_clip_ids: [5],
          intro_path: introPath,
          output_filename: "intro-mismatch.mp4",
          framemeld_enabled: true,
        },
      });
    });

    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith("/montage/media-fps", { paths: [introPath] });
      expect(mocks.consoleProps.framemeldSourceSummary.hasMixedFrameRates).toBe(true);
      expect(mocks.consoleProps.framemeldEnabled).toBe(false);
    });
  });

  it("requires a second confirmation before batch deleting selected materials", async () => {
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "" } });
      if (url === "/recorded-clips") {
        return Promise.resolve({
          data: {
            items: [{ id: 5, output_path: "D:\\clips\\five.mp4", duration_sec: 4 }],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    mocks.post.mockImplementation((url) => {
      if (url === "/recorded-clips/batch-delete") {
        return Promise.resolve({ data: { deleted: [{ id: 5 }], not_found: [] } });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.materialProps?.clip?.id).toBe(5));
    act(() => mocks.materialProps.onClickMulti({ ctrlKey: false, metaKey: false }, 5));
    fireEvent.click(screen.getByTestId("montage-pool-controls-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "montage.poolBatchDeleteBtn" }));

    expect(screen.getByRole("dialog", { name: "montage.batchDeleteTitle" })).toBeTruthy();
    expect(mocks.post).not.toHaveBeenCalledWith("/recorded-clips/batch-delete", { ids: [5] });

    fireEvent.click(screen.getByRole("button", { name: "montage.batchDeleteCancel" }));
    expect(screen.queryByRole("dialog", { name: "montage.batchDeleteTitle" })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalledWith("/recorded-clips/batch-delete", { ids: [5] });

    fireEvent.click(screen.getByRole("button", { name: "montage.poolBatchDeleteBtn" }));
    fireEvent.click(screen.getByRole("button", { name: "montage.batchDeleteConfirm" }));
    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith("/recorded-clips/batch-delete", { ids: [5] });
    });
  });

  it("opens the shared progress dialog and cancels a background montage export", async () => {
    let resolveStatus;
    mocks.get.mockImplementation((url) => {
      if (url === "config/ffmpeg-check") return Promise.resolve({ data: { ok: true } });
      if (url === "/config") return Promise.resolve({ data: { montage_export_dir: "D:\\Exports" } });
      if (url === "/recorded-clips") {
        return Promise.resolve({
          data: { items: [{ id: 5, output_path: "D:\\clips\\five.mp4", duration_sec: 4 }] },
        });
      }
      if (url === "/montage/exports/42") {
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      }
      return Promise.resolve({ data: {} });
    });
    mocks.post.mockImplementation((url) => {
      if (url === "/montage/export") {
        return Promise.resolve({
          data: {
            export_id: 42,
            status: "queued",
            stage: "queued",
            progress: 0,
            output_path: "D:\\Exports\\montage.mp4",
          },
        });
      }
      if (url === "/montage/exports/42/cancel") {
        return Promise.resolve({
          data: {
            export_id: 42,
            status: "cancelling",
            stage: "cancelling",
            progress: 0.2,
            output_path: "D:\\Exports\\montage.mp4",
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <MemoryRouter initialEntries={["/montage"]}>
        <MontageWorkbenchDrawer open layout="page" onClose={() => {}} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mocks.materialProps?.clip?.id).toBe(5));
    act(() => mocks.materialProps.onAdd(5));
    await waitFor(() => expect(mocks.consoleProps?.clipCount).toBe(1));
    await act(async () => {
      await mocks.consoleProps.onExport();
    });

    expect(screen.getByText("正在导出合辑…")).toBeTruthy();
    await waitFor(() => expect(typeof resolveStatus).toBe("function"));
    fireEvent.click(screen.getByRole("button", { name: "取消导出" }));
    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith("/montage/exports/42/cancel");
    });
    await act(async () => {
      resolveStatus({
        data: {
          export_id: 42,
          status: "cancelled",
          stage: "cancelled",
          progress: 0.2,
          output_path: "D:\\Exports\\montage.mp4",
        },
      });
    });

    await waitFor(() => expect(screen.getByText("导出已取消")).toBeTruthy());
    expect(mocks.get).toHaveBeenCalledWith("/montage/exports/42");
  });
});
