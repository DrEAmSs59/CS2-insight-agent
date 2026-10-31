/** @vitest-environment jsdom */
import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import API from "../../api/api";
import { useDemoAnalysisWorkflows } from "./useDemoAnalysisWorkflows";
vi.mock("../../api/api", () => ({ default: { post: vi.fn() } }));
const t = (key) => key;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const player = (id) => ({ clips: [{ clip_id: id, start_tick: 10, end_tick: 20 }], match_meta: {} });
function useHarness() {
  const [demos, setDemos] = useState([{ filename: "match.dem", path: "A/match.dem" }]);
  const [parsed, setParsed] = useState([{ players: { same: player("A") } }]);
  const [rounds, setRounds] = useState({});
  const [progress, setProgress] = useState("");
  const flow = useDemoAnalysisWorkflows({
    t, uploadedDemos: demos, setUploadedDemos: setDemos, parsedMatches: parsed, setParsedMatches: setParsed,
    currentMatchIndex: 0, selectedPlayers: { 0: ["same"] }, aiMode: true,
    freezeToDeathRoundsByMatch: rounds, setFreezeToDeathRoundsByMatch: setRounds,
    libraryDemoIdsByIndex: {}, setProgressText: setProgress, setSelectedClientClipUids: vi.fn(),
    autoParseLoadedDemosRef: { current: null }, setBatchLoadError: vi.fn(),
  });
  return { ...flow, parsed, progress, switchDemo: () => {
    setDemos([{ filename: "match.dem", path: "B/match.dem" }]);
    setParsed([{ players: { same: player("B") } }]);
  }};
}
beforeEach(() => vi.clearAllMocks());
it("ignores old parse results and cleanup after switching to another same-named demo", async () => {
  const a = deferred(), b = deferred(); API.post.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const { result } = renderHook(useHarness);
  let old, current;
  act(() => { old = result.current.handleParse(); });
  act(() => result.current.switchDemo());
  act(() => { current = result.current.handleParse(); });
  await act(async () => { a.resolve({ data: { players: { same: player("old-A") } } }); await old; });
  expect(result.current.parsed[0].players.same.clips[0].clip_id).toBe("B");
  expect(result.current.parsingByIndex[0]).toBe(true);
  await act(async () => { b.resolve({ data: { players: { same: player("new-B") } } }); await current; });
  expect(result.current.parsed[0].players.same.clips[0].clip_id).toBe("new-B");
  expect(result.current.parsingByIndex[0]).toBeUndefined();
});
it("does not overwrite a new player's AI review with the old same-name response", async () => {
  const a = deferred(), b = deferred(); API.post.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const { result } = renderHook(useHarness); let old, current;
  act(() => { old = result.current.ensurePlayerAiReview("same"); });
  act(() => result.current.switchDemo());
  act(() => { current = result.current.ensurePlayerAiReview("same"); });
  await act(async () => { b.resolve({ data: { clips: [{ clip_id: "review-B", ai_score: 9 }] } }); await current; });
  await act(async () => { a.resolve({ data: { clips: [{ clip_id: "review-A", ai_score: 1 }] } }); await old; });
  expect(result.current.parsed[0].players.same.clips[0].clip_id).toBe("review-B");
  expect(result.current.parsed[0].players.same.ai_reviewed).toBe(true);
});
it("ignores errors from requests invalidated by reset", async () => {
  const a = deferred(); API.post.mockReturnValue(a.promise);
  const { result } = renderHook(useHarness); let pending;
  act(() => { pending = result.current.handleParse(); });
  act(() => result.current.resetAnalysisWorkflow());
  await act(async () => { a.reject(new Error("late failure")); await pending; });
  expect(result.current.analysisInlineProgress).toBeNull();
  expect(result.current.progress).toBe("");
  expect(result.current.parsingByIndex).toEqual({});
});
