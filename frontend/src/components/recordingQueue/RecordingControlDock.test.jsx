/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RecordingControlDock from "./RecordingControlDock.jsx";

vi.mock("../../i18n/useT.js", () => ({
  useT: () => (key) => key,
}));

describe("RecordingControlDock", () => {
  it("keeps the status tray while leaving the action buttons unbacked", () => {
    render(
      <RecordingControlDock
        queueLength={7}
        totalEstimateSec={60}
        batchRecording={false}
        onStart={vi.fn()}
        onAbort={vi.fn()}
        onClear={vi.fn()}
        disabledStart={false}
        obsConfigured
      />,
    );

    const dock = screen.getByTestId("recording-control-dock");
    const statusTray = screen.getByTestId("recording-control-status-tray");
    const actionTray = screen.getByTestId("recording-control-action-tray");
    const startButton = screen.getByRole("button", { name: "queue.btnStartRecording" });

    expect(dock.className).not.toContain("border-t");
    expect(statusTray.className).toContain("rounded-lg");
    expect(statusTray.className).toContain("border-cs2-border");
    expect(statusTray.className).toContain("bg-cs2-bg-card");
    expect(actionTray.className).not.toContain("rounded-lg");
    expect(actionTray.className).not.toContain("border-cs2-border");
    expect(actionTray.className).not.toContain("bg-cs2-bg-card");
    expect(actionTray.className).not.toContain("shadow");
    expect(actionTray.className).toContain("min-w-[300px]");
    expect(startButton.className).not.toContain("shadow");
    expect(startButton.querySelector("svg").getAttribute("class")).toContain("h-3.5 w-3.5");
    expect(screen.getByRole("button", { name: "queue.btnStop" }).querySelector("svg").getAttribute("class")).toContain("h-3.5 w-3.5");
    expect(screen.getByRole("button", { name: "queue.btnClear" }).querySelector("svg").getAttribute("class")).toContain("h-3.5 w-3.5");
  });
});
