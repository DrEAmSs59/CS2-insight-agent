import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useLocaleStore } from "../../i18n/localeStore";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { buildRecordingQueueRequestsFromQueue } from "../../utils/recordingBatch";
import QueueInspectorPanel from "./QueueInspectorPanel";

const item = {
  id: "one", targetPlayer: "one", targetSteamId: "1", demoPath: "match.dem",
  matchMeta: { total_rounds: 1, demo_end_tick: 30000 },
  clipData: { category: "compilation", compilation_kind: "freeze_to_death", round_facts: [
    { round: 1, round_start_tick: 5000, freeze_end_tick: 6400, death_tick: 12800, round_end_tick: 20000 },
  ] },
};
function Inspector({ id = "one" }) {
  const selected = useRecordingQueue((s) => s.queue.find((q) => q.id === id));
  return <QueueInspectorPanel selectedId={id} selectedItem={selected} />;
}
beforeEach(() => {
  useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true });
  useRecordingQueue.setState({ queue: [item, { ...item, id: "two" }], globalPacing: {} });
});

test("round inspector edits only the selected compilation and reset restores 3 / 2 / 3", () => {
  const { rerender } = render(<Inspector />);
  const pre = screen.getByRole("spinbutton", { name: "冻结结束前预留（10-3秒）" });
  const post = screen.getByRole("spinbutton", { name: "死亡后保留（2-5秒）" });
  const alive = screen.getByRole("spinbutton", { name: "回合结束后保留（1-3秒）" });
  expect(pre.value).toBe("3");
  expect(post.value).toBe("2");
  expect(alive.value).toBe("3");
  fireEvent.change(pre, { target: { value: "5.5" } });
  fireEvent.change(post, { target: { value: "2.3" } });
  fireEvent.change(alive, { target: { value: "1.5" } });
  const requests = buildRecordingQueueRequestsFromQueue(useRecordingQueue.getState().queue, {}, [], [], []);
  expect(requests[0].options).toMatchObject({ round_freeze_preroll_sec: 5.5, round_death_post_sec: 2.3, round_alive_post_sec: 1.5 });
  expect(requests[1].options).toMatchObject({ round_freeze_preroll_sec: 3, round_death_post_sec: 2, round_alive_post_sec: 3 });
  rerender(<Inspector id="two" />);
  expect(screen.getByRole("spinbutton", { name: "冻结结束前预留（10-3秒）" }).value).toBe("3");
  rerender(<Inspector />);
  expect(screen.getByRole("spinbutton", { name: "冻结结束前预留（10-3秒）" }).value).toBe("5.5");
  expect(screen.getByRole("spinbutton", { name: "回合结束后保留（1-3秒）" }).value).toBe("1.5");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认：3 秒 / 2 秒 / 3 秒" }));
  expect(useRecordingQueue.getState().queue[0].pacing_override)
    .toMatchObject({ round_freeze_preroll_sec: 3, round_death_post_sec: 2, round_alive_post_sec: 3 });
});

test("surviving round tail accepts 1–3 seconds without a death warning and rejects out-of-range input", () => {
  render(<Inspector />);
  const input = screen.getByRole("spinbutton", { name: "回合结束后保留（1-3秒）" });
  expect(input.min).toBe("1");
  expect(input.max).toBe("3");
  for (const value of ["1", "2.5", "3"]) {
    fireEvent.change(input, { target: { value } });
    expect(useRecordingQueue.getState().queue[0].pacing_override.round_alive_post_sec).toBe(Number(value));
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  for (const value of ["0", "0.9", "3.1", ""]) {
    fireEvent.change(input, { target: { value } });
    expect(useRecordingQueue.getState().queue[0].pacing_override.round_alive_post_sec).toBe(3);
    fireEvent.blur(input);
    expect(input.value).toBe("3");
  }
});

test("freeze preroll is limited to 3–10 seconds and invalid values revert on blur", () => {
  render(<Inspector />);
  const input = screen.getByRole("spinbutton", { name: "冻结结束前预留（10-3秒）" });
  expect(input.min).toBe("3");
  expect(input.max).toBe("10");
  expect(screen.getByText("可按 0.1 秒调整")).toBeTruthy();
  for (const value of ["", "-1", "0", "2.9", "10.1"]) {
    fireEvent.change(input, { target: { value } });
    expect(useRecordingQueue.getState().queue[0].pacing_override).toBeUndefined();
    fireEvent.blur(input);
    expect(input.value).toBe("3");
  }
  fireEvent.change(input, { target: { value: "10" } });
  expect(useRecordingQueue.getState().queue[0].pacing_override.round_freeze_preroll_sec).toBe(10);
});

test("2.3 seconds needs no warning; extending past it waits for explicit confirmation", () => {
  render(<Inspector />);
  const input = screen.getByRole("spinbutton", { name: "死亡后保留（2-5秒）" });
  fireEvent.change(input, { target: { value: "2.3" } });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useRecordingQueue.getState().queue[0].pacing_override.round_death_post_sec).toBe(2.3);

  fireEvent.change(input, { target: { value: "2.4" } });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByText("超过 2.3 秒继续延长，可能录到其他人的视角。仍要延长吗？")).toBeTruthy();
  expect(buildRecordingQueueRequestsFromQueue(useRecordingQueue.getState().queue, {}, [], [], [])[0]
    .options.round_death_post_sec).toBe(2.3);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(input.value).toBe("2.3");
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "仍延长至 5 秒" }));
  expect(input.value).toBe("5");
  const requests = buildRecordingQueueRequestsFromQueue(useRecordingQueue.getState().queue, {}, [], [], []);
  expect(requests[0].options.round_death_post_sec).toBe(5);
  expect(requests[1].options.round_death_post_sec).toBe(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("reducing an accepted long tail needs no warning, but extending again warns", () => {
  useRecordingQueue.setState({ queue: [{ ...item, pacing_override: { round_death_post_sec: 5 } }] });
  render(<Inspector />);
  const input = screen.getByRole("spinbutton", { name: "死亡后保留（2-5秒）" });
  fireEvent.change(input, { target: { value: "4" } });
  expect(input.value).toBe("4");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.change(input, { target: { value: "4.1" } });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "取消" }), { key: "Escape" });
  expect(input.value).toBe("4");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("death tail rejects values outside 2–5 and switching items discards unconfirmed edits", () => {
  const { rerender } = render(<Inspector />);
  const input = screen.getByRole("spinbutton", { name: "死亡后保留（2-5秒）" });
  expect(input.max).toBe("5");
  expect(input.min).toBe("2");
  for (const value of ["0", "1.9", "5.1"]) {
    fireEvent.change(input, { target: { value } });
    expect(useRecordingQueue.getState().queue[0].pacing_override).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.blur(input);
    expect(input.value).toBe("2");
  }
  fireEvent.change(input, { target: { value: "5" } });
  expect(screen.getByRole("dialog")).toBeTruthy();
  rerender(<Inspector id="two" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useRecordingQueue.getState().queue.every((q) => !q.pacing_override)).toBe(true);
});
