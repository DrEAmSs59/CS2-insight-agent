/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ExperimentalNrPanel from "./ExperimentalNrPanel.jsx";

vi.mock("../../i18n/useT.js", () => ({
  useT: () => (key) => key,
}));

const plan = { demoPath: "D:/demo/a.dem", demoFile: "a.dem", startTick: 141365, endTick: 141941 };

describe("ExperimentalNrPanel", () => {
  it("只渲染标题与开关，关闭时不展开细节", () => {
    render(<ExperimentalNrPanel enabled={false} onToggle={vi.fn()} status={{ state: "idle" }} />);

    expect(screen.getByTestId("recording-experimental-nr-panel")).toBeTruthy();
    expect(screen.getByText("queue.expTitle")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("recording-experimental-nr-check")).toBeNull();
  });

  it("打开后展示环境状态、采集窗口与操作按钮", () => {
    const onToggle = vi.fn();
    render(
      <ExperimentalNrPanel
        enabled
        onToggle={onToggle}
        status={{ state: "ready", data: { gpus: ["AMD Radeon RX 9070 XT"], log_dir: "data/logs" } }}
        plan={plan}
        planStatus="ready"
        onCheck={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByText("queue.expStatusReady")).toBeTruthy();
    expect(screen.getByText(/AMD Radeon RX 9070 XT/)).toBeTruthy();
    expect(screen.getByText(/9\.00s/)).toBeTruthy(); // (141941-141365)/64 = 9.00s 窗口
    expect(screen.getByTestId("recording-experimental-nr-run").disabled).toBe(false);

    fireEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("环境不可用时展示缺失项并禁用开始按钮", () => {
    render(
      <ExperimentalNrPanel
        enabled
        onToggle={vi.fn()}
        status={{ state: "unsupported", data: { missing: ["queue.expMissingProAgent"] } }}
        plan={null}
        planStatus="missing"
        onCheck={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByText("queue.expStatusUnsupported")).toBeTruthy();
    expect(screen.getByText(/queue.expMissingProAgent/)).toBeTruthy();
    expect(screen.getByTestId("recording-experimental-nr-run").disabled).toBe(true);
    expect(screen.getByText("queue.expNeedReady")).toBeTruthy();
  });

  it("运行中显示耗时与禁用开关，完成后展示输出路径", () => {
    const startedAt = Date.now() - 65_000;
    const { rerender } = render(
      <ExperimentalNrPanel
        enabled
        onToggle={vi.fn()}
        status={{ state: "ready", data: { gpus: ["AMD Radeon RX 9070 XT"] } }}
        plan={plan}
        planStatus="ready"
        running
        startedAt={startedAt}
        onCheck={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getAllByText("queue.expRunning").length).toBeGreaterThan(0);
    expect(screen.getByText(/1:0[0-9]/)).toBeTruthy();
    expect(screen.getByRole("switch").disabled).toBe(true);

    rerender(
      <ExperimentalNrPanel
        enabled
        onToggle={vi.fn()}
        status={{ state: "ready", data: { gpus: ["AMD Radeon RX 9070 XT"] } }}
        plan={plan}
        planStatus="ready"
        result={{ ok: true, finalOutput: "D:/out/final.mp4", logPath: "data/logs/x.log" }}
        onCheck={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    const result = screen.getByTestId("recording-experimental-nr-result");
    expect(result.textContent).toContain("D:/out/final.mp4");
    expect(result.textContent).toContain("data/logs/x.log");
  });
});
