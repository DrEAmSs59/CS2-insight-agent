import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { useLocaleStore } from "../../i18n/localeStore.js";
import { useRecordingQueue } from "../../stores/recordingQueueStore.js";
import QueueInspectorPanel from "./QueueInspectorPanel.jsx";

const highlight = {
  id: "q1",
  demoFilename: "match.dem",
  targetPlayer: "alpha",
  clipData: {
    category: "highlight",
    title: "三杀",
    map_name: "de_mirage",
    round: 12,
    score_own: 7,
    score_opp: 5,
    victims: ["s1mple", "NiKo", "ZywOo"],
    kill_ticks: [1000, 1300, 1700],
  },
};

const fail = {
  id: "q2",
  demoFilename: "match.dem",
  targetPlayer: "alpha",
  clipData: { category: "fail", killer_name: "donk", round: 4, death_tick: 5000 },
};

function renderEditor(id) {
  const item = () => useRecordingQueue.getState().queue.find((q) => q.id === id);
  const view = render(<QueueInspectorPanel selectedItem={item()} />);
  return { ...view, rerenderLatest: () => view.rerender(<QueueInspectorPanel selectedItem={item()} />) };
}

describe("QueueInspectorPanel", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
    useRecordingQueue.setState({ queue: [highlight, fail], globalPacing: { pre_first_sec: 2 } });
  });

  test("marks per-clip pacing overrides and resets them to the defaults", () => {
    const view = renderEditor("q1");
    expect(screen.getByText("第 12 回合 · 7:5", { exact: false })).toBeTruthy();
    const pre = screen.getByRole("spinbutton", { name: "片段前留白" });
    expect(pre.value).toBe("2");
    expect(screen.getAllByText("跟随默认")).toHaveLength(3);

    fireEvent.change(pre, { target: { value: "3.5" } });
    expect(useRecordingQueue.getState().queue[0].pacing_override.pre_first_sec).toBe(3.5);
    view.rerenderLatest();
    expect(screen.getByText("已调整 · 默认 2 秒")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(useRecordingQueue.getState().queue[0].pacing_override).not.toHaveProperty("pre_first_sec");
    view.rerenderLatest();
    expect(screen.getAllByText("跟随默认")).toHaveLength(3);
  });

  test("accepts a 150-second merge gap without replacing the first digit", () => {
    const view = renderEditor("q1");
    const input = screen.getByRole("spinbutton", { name: "合并间隔" });
    expect(input.max).toBe("150");
    for (const value of ["", "1", "15", "150"]) {
      fireEvent.change(input, { target: { value } });
      view.rerenderLatest();
      expect(input.value).toBe(value);
    }
    fireEvent.blur(input);
    expect(useRecordingQueue.getState().queue[0].pacing_override.max_gap_sec).toBe(150);
  });

  test("restores cleared pacing to the inherited default and resets empty drafts when selecting another clip", () => {
    useRecordingQueue.setState({
      queue: [{ ...highlight, pacing_override: { pre_first_sec: 4 } }, fail],
      globalPacing: { pre_first_sec: 3 },
    });
    const view = renderEditor("q1");
    const input = screen.getByRole("spinbutton", { name: "片段前留白" });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(useRecordingQueue.getState().queue[0].pacing_override.pre_first_sec).toBe(4);
    fireEvent.blur(input);
    view.rerenderLatest();
    expect(input.value).toBe("3");
    expect(useRecordingQueue.getState().queue[0].pacing_override.pre_first_sec).toBe(3);

    fireEvent.change(input, { target: { value: "" } });
    view.rerender(<QueueInspectorPanel selectedItem={fail} />);
    expect(screen.getByRole("spinbutton", { name: "片段前留白" }).value).toBe("3");
    expect(useRecordingQueue.getState().queue[1].pacing_override).toBeUndefined();
  });

  test("turns on victim replays and shows them in the preview", () => {
    const view = renderEditor("q1");
    const pov = screen.getByTestId("queue-editor-pov");
    expect(within(pov).getByRole("switch", { name: "击杀者视角" }).disabled).toBe(true);
    expect(within(pov).getByText("只有下饭片段和死亡合集可以加入击杀者视角")).toBeTruthy();

    fireEvent.click(within(pov).getByRole("switch", { name: "受害者视角" }));
    view.rerenderLatest();
    expect(screen.getByText("先播放全部击杀，再依次播放 3 段受害者视角")).toBeTruthy();
    expect(within(screen.getByTestId("queue-plan-strip")).getByText("受害者视角 · NiKo")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "每次击杀后" }));
    expect(useRecordingQueue.getState().queue[0].pacing_override.pov_interleaved).toBe(true);
    view.rerenderLatest();
    expect(screen.getByText("每次击杀后立刻播放对应的受害者视角")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "AI 自动编排" })).toBeNull();
  });

  test("uses manual replay timing even when a restored item has the retired AI flag", () => {
    useRecordingQueue.setState({
      queue: [{ ...highlight, pacing_override: { ai_director: true, victim_pov: true } }],
    });
    const view = renderEditor("q1");
    expect(screen.getByText("先播放全部击杀，再依次播放 3 段受害者视角")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "AI 自动编排" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "每次击杀后" }));
    view.rerenderLatest();
    expect(screen.getByText("每次击杀后立刻播放对应的受害者视角")).toBeTruthy();
  });

  test("offers the killer replay for fail clips", () => {
    const view = renderEditor("q2");
    expect(screen.getByRole("switch", { name: "受害者视角" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "击杀者视角" }));
    view.rerenderLatest();
    expect(screen.getByText("先播放自己的死亡画面，再播放击杀者视角")).toBeTruthy();
    expect(within(screen.getByTestId("queue-plan-strip")).getByText("击杀者视角 · donk")).toBeTruthy();
  });
});
