/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../api/api.js";
import { projectBodyFromTemplate } from "../components/liteCut/editor/projectTemplates.js";
import { normalizeLiteCutBody, useLiteCutEditorStore } from "./liteCutEditorStore.js";

describe("normalizeLiteCutBody", () => {
  beforeEach(() => {
    useLiteCutEditorStore.setState({
      projectId: null,
      projectName: "Untitled",
      body: null,
      dirty: false,
      loading: false,
      saving: false,
      error: null,
      mediaCache: {},
      projectList: [],
      projectListLoading: false,
      projectUpdatedAt: null,
      recoveryCandidate: null,
    });
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps portable project data while restoring required editor defaults", () => {
    const { body, changed } = normalizeLiteCutBody({
      tracks: [
        {
          id: "v1",
          type: "video",
          label: "V1",
          clips: [{ id: "layer", transform: { x: 0.7, y: 0.3, width: 0.5, scale: 1.2 } }],
        },
      ],
      markers: [{ id: "m1", time_sec: 2.5, label: "clutch", color: "#22d3ee" }],
      audio: { master_volume: 1.5, bgm: { path: "C:/music/theme.mp3", volume: 0.4 } },
      output: { width: 1920, height: 1080, fps: 60 },
    });

    expect(changed).toBe(true);
    expect(body.tracks.find((track) => track.id === "v1").clips[0].transform).toMatchObject({ x: 0.7, width: 0.5 });
    expect(body.tracks.some((track) => track.type === "audio")).toBe(true);
    expect(body.markers).toEqual([{ id: "m1", time_sec: 2.5, label: "clutch", color: "#22d3ee" }]);
    expect(body.audio).toMatchObject({ master_volume: 1.5, bgm: { path: "C:/music/theme.mp3", volume: 0.4 } });
    expect(body.overlays).toEqual([]);
    expect(body.output.encoder).toBe("auto");
  });

  it("keeps a supported per-project export encoder", () => {
    const { body, changed } = normalizeLiteCutBody({
      tracks: [{ id: "v1", type: "video", clips: [] }],
      output: { width: 1920, height: 1080, fps: 60, encoder: "h264_nvenc" },
    });

    expect(body.output.encoder).toBe("h264_nvenc");
    expect(changed).toBe(true);
  });

  it("does not inject a duplicate video track when v1 was renamed away", () => {
    const { body } = normalizeLiteCutBody({
      tracks: [
        { id: "v-abc123", type: "video", label: "V1", clips: [{ id: "clip-a" }] },
        { id: "a1", type: "audio", label: "A1", clips: [] },
      ],
      output: { width: 1920, height: 1080, fps: 60 },
    });

    const videoTracks = body.tracks.filter((track) => track.type === "video");
    expect(videoTracks).toHaveLength(1);
    expect(videoTracks[0]).toMatchObject({ id: "v-abc123", label: "V1" });
  });

  it("dedupes duplicate video track labels left by older builds", () => {
    const { body, changed } = normalizeLiteCutBody({
      tracks: [
        { id: "v1", type: "video", label: "V1", clips: [] },
        { id: "v-abc123", type: "video", label: "V1", clips: [{ id: "clip-a" }] },
        { id: "a1", type: "audio", label: "A1", clips: [] },
      ],
      output: { width: 1920, height: 1080, fps: 60 },
    });

    expect(changed).toBe(true);
    expect(body.tracks.filter((track) => track.type === "video").map((track) => track.label)).toEqual(["V1", "V2"]);
  });

  it("still injects a v1 track when the project has no video tracks", () => {
    const { body } = normalizeLiteCutBody({
      tracks: [{ id: "a1", type: "audio", label: "A1", clips: [] }],
      output: { width: 1920, height: 1080, fps: 60 },
    });

    expect(body.tracks.filter((track) => track.type === "video")).toHaveLength(1);
    expect(body.tracks[0]).toMatchObject({ id: "v1", type: "video", label: "V1" });
  });

  it("creates a project from a template body instead of discarding its layout", async () => {
    const template = projectBodyFromTemplate("shorts-9x16");
    vi.spyOn(API, "post").mockResolvedValue({
      data: { id: 42, name: "Shorts", body: template },
    });
    vi.spyOn(API, "get").mockResolvedValue({ data: { items: [] } });

    const result = await useLiteCutEditorStore.getState().createNewProject("Shorts", template);

    expect(result.ok).toBe(true);
    expect(API.post).toHaveBeenCalledWith("/lite-cut/projects", { name: "Shorts", body: template });
    expect(useLiteCutEditorStore.getState().body).toMatchObject({
      template_id: "shorts-9x16",
      output: { width: 1080, height: 1920 },
    });
  });

  it("shows the project chooser without silently creating a project", async () => {
    localStorage.setItem("liteCut:lastProjectId", "8");
    vi.spyOn(API, "get").mockResolvedValue({
      data: { items: [{ id: 8, name: "Existing project", updated_at: "2026-07-05T10:00:00Z" }] },
    });
    const post = vi.spyOn(API, "post");

    await useLiteCutEditorStore.getState().loadOrCreateProject();

    expect(post).not.toHaveBeenCalled();
    expect(API.get).toHaveBeenCalledWith("/lite-cut/projects", { params: { limit: 50, offset: 0 } });
    expect(useLiteCutEditorStore.getState()).toMatchObject({
      projectId: null,
      body: null,
      loading: false,
      projectList: [{ id: 8, name: "Existing project", updated_at: "2026-07-05T10:00:00Z" }],
    });
  });

  it("releases the current project media before requesting project deletion", async () => {
    const body = projectBodyFromTemplate("highlight-16x9");
    useLiteCutEditorStore.setState({
      projectId: 12,
      projectName: "Locked media",
      body,
      dirty: false,
      mediaCache: { source: "blob:test" },
    });
    sessionStorage.setItem("liteCut:projectId", "12");
    vi.spyOn(API, "delete").mockImplementation(async () => {
      expect(useLiteCutEditorStore.getState()).toMatchObject({
        projectId: null,
        body: null,
        mediaCache: {},
        loading: true,
      });
      return { data: {} };
    });
    vi.spyOn(API, "get").mockResolvedValue({ data: { items: [] } });

    const result = await useLiteCutEditorStore.getState().deleteProject(12);

    expect(result.ok).toBe(true);
    expect(sessionStorage.getItem("liteCut:projectId")).toBeNull();
  });

  it("restores the current project when deleting its files fails", async () => {
    const body = projectBodyFromTemplate("highlight-16x9");
    useLiteCutEditorStore.setState({
      projectId: 13,
      projectName: "Keep me",
      body,
      dirty: true,
      mediaCache: { source: "blob:test" },
    });
    sessionStorage.setItem("liteCut:projectId", "13");
    vi.spyOn(API, "delete").mockRejectedValue(new Error("file is in use"));

    const result = await useLiteCutEditorStore.getState().deleteProject(13);

    expect(result.ok).toBe(false);
    expect(useLiteCutEditorStore.getState()).toMatchObject({
      projectId: 13,
      projectName: "Keep me",
      body,
      dirty: true,
      mediaCache: { source: "blob:test" },
      loading: false,
    });
    expect(sessionStorage.getItem("liteCut:projectId")).toBe("13");
  });

  it("does not let a slow autosave overwrite edits made while saving", async () => {
    const firstBody = projectBodyFromTemplate("highlight-16x9");
    const nextBody = structuredClone(firstBody);
    nextBody.markers = [{ id: "new-marker", time_sec: 3, label: "New edit" }];
    useLiteCutEditorStore.setState({
      projectId: 21,
      projectName: "Autosave race",
      body: firstBody,
      dirty: true,
    });
    let releaseFirst;
    const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
    const patch = vi.spyOn(API, "patch")
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({ data: { id: 21, name: "Autosave race", body: nextBody } });
    vi.spyOn(API, "get").mockResolvedValue({ data: { items: [] } });

    const saving = useLiteCutEditorStore.getState().saveProject();
    useLiteCutEditorStore.setState({ body: nextBody, dirty: true });
    releaseFirst({ data: { id: 21, name: "Autosave race", body: firstBody } });

    expect((await saving).ok).toBe(true);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(useLiteCutEditorStore.getState().body.markers).toEqual([
      expect.objectContaining(nextBody.markers[0]),
    ]);
    expect(useLiteCutEditorStore.getState().dirty).toBe(false);
  });

  it("offers an emergency draft after a renderer or app crash", async () => {
    const savedBody = projectBodyFromTemplate("highlight-16x9");
    const crashedBody = structuredClone(savedBody);
    crashedBody.markers = [{ id: "unsaved", time_sec: 4, label: "Recovered" }];
    localStorage.setItem("liteCut:lastProjectId", "31");
    localStorage.setItem("liteCut:recovery:v1:31", JSON.stringify({
      version: 1, projectId: 31, projectName: "Recovered project", body: crashedBody, savedAt: Date.now(),
    }));
    vi.spyOn(API, "get").mockImplementation(async (url) => {
      if (url === "/lite-cut/projects/31") return { data: { id: 31, name: "Saved project", body: savedBody, updated_at: "2026-07-12T01:00:00Z" } };
      return { data: { items: [] } };
    });

    await useLiteCutEditorStore.getState().loadOrCreateProject();
    expect(useLiteCutEditorStore.getState().recoveryCandidate).toMatchObject({ projectId: 31, projectName: "Recovered project" });
    expect(useLiteCutEditorStore.getState().restoreRecoveryDraft()).toBe(true);
    expect(useLiteCutEditorStore.getState()).toMatchObject({ projectName: "Recovered project", dirty: true, recoveryCandidate: null });
    expect(useLiteCutEditorStore.getState().body.markers[0]).toMatchObject({ id: "unsaved", label: "Recovered" });
  });
});
