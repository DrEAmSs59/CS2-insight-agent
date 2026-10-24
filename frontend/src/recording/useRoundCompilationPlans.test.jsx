import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import API from "../api/api";
import { useRoundCompilationPlans } from "./useRoundCompilationPlans";
import { buildRecordingQueueRequestsFromQueue } from "../utils/recordingBatch";

vi.mock("../api/api", () => ({ default: { post: vi.fn() } }));
const item = {
  id: "rounds", targetPlayer: "one", targetSteamId: "1", demoPath: "match.dem",
  matchMeta: { total_rounds: 1, demo_end_tick: 30000 },
  clipData: { category: "compilation", compilation_kind: "freeze_to_death", round_facts: [
    { round: 1, round_start_tick: 5000, freeze_end_tick: 6400, death_tick: 12800, round_end_tick: 20000 },
  ] },
};
const plan = { active_segments: [{ round: 1, start_tick: 6208, end_tick: 12928 }], estimated_duration_sec: 105 };
beforeEach(() => vi.clearAllMocks());

test("preview uses the execution DTO and caches only for the same request", async () => {
  API.post.mockResolvedValue({ data: plan });
  const { result, rerender } = renderHook(({ queue }) => useRoundCompilationPlans(queue, {}, [], [], []), { initialProps: { queue: [item] } });
  expect(result.current.rounds.status).toBe("loading");
  await waitFor(() => expect(result.current.rounds.status).toBe("ready"));
  const [expected] = buildRecordingQueueRequestsFromQueue([item], {}, [], [], []);
  expect(API.post.mock.calls[0][1]).toEqual({ ...expected, request_id: "round-preview" });
  rerender({ queue: [{ ...item, targetPlayer: "two", targetSteamId: "2" }] });
  await waitFor(() => expect(API.post).toHaveBeenCalledTimes(2));
  rerender({ queue: [item] });
  await waitFor(() => expect(result.current.rounds.status).toBe("ready"));
  expect(API.post).toHaveBeenCalledTimes(2);
});

test("a failed preview can be retried, and incomplete analyses never call the API", async () => {
  API.post.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: plan });
  const { result, rerender } = renderHook(({ queue }) => useRoundCompilationPlans(queue, {}, [], [], []), { initialProps: { queue: [item] } });
  await waitFor(() => expect(result.current.rounds.status).toBe("error"));
  act(() => result.current.rounds.retry());
  await waitFor(() => expect(result.current.rounds.status).toBe("ready"));
  rerender({ queue: [{ ...item, clipData: { category: "compilation", compilation_kind: "freeze_to_death" } }] });
  expect(result.current.rounds.errorKey).toBe("ftd.errorNoWindows");
  rerender({ queue: [{ ...item, clipData: { category: "highlight" } }] });
  expect(result.current).toEqual({});
  expect(API.post).toHaveBeenCalledTimes(2);
});

test("timing edits invalidate the preview and send exactly the execution options", async () => {
  API.post.mockResolvedValue({ data: plan });
  const { result, rerender } = renderHook(({ queue }) => useRoundCompilationPlans(queue, {}, [], [], []), { initialProps: { queue: [item] } });
  await waitFor(() => expect(result.current.rounds.status).toBe("ready"));
  const changed = { ...item, pacing_override: { round_freeze_preroll_sec: 5.5, round_death_post_sec: 2.2 } };
  rerender({ queue: [changed] });
  await waitFor(() => expect(API.post).toHaveBeenCalledTimes(2));
  const [expected] = buildRecordingQueueRequestsFromQueue([changed], {}, [], [], []);
  expect(API.post.mock.calls[1][1]).toEqual({ ...expected, request_id: "round-preview" });
  expect(expected.options).toMatchObject({ round_freeze_preroll_sec: 5.5, round_death_post_sec: 2.2 });
  const aliveChanged = { ...changed, pacing_override: { ...changed.pacing_override, round_alive_post_sec: 1.5 } };
  rerender({ queue: [aliveChanged] });
  await waitFor(() => expect(API.post).toHaveBeenCalledTimes(3));
  const [aliveExpected] = buildRecordingQueueRequestsFromQueue([aliveChanged], {}, [], [], []);
  expect(API.post.mock.calls[2][1]).toEqual({ ...aliveExpected, request_id: "round-preview" });
  expect(aliveExpected.options.round_alive_post_sec).toBe(1.5);
});

test("late results from a removed player cannot replace the current plan", async () => {
  let finishOld;
  API.post.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ data: { ...plan, estimated_duration_sec: 12 } });
  const { result, rerender } = renderHook(({ queue }) => useRoundCompilationPlans(queue, {}, [], [], []), { initialProps: { queue: [item] } });
  rerender({ queue: [{ ...item, targetSteamId: "2" }] });
  await waitFor(() => expect(result.current.rounds.plan?.estimated_duration_sec).toBe(12));
  await act(async () => finishOld({ data: plan }));
  expect(result.current.rounds.plan.estimated_duration_sec).toBe(12);
});
