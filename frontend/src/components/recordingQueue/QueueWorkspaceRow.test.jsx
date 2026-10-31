import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { useLocaleStore } from "../../i18n/localeStore.js";
import QueueWorkspaceRow from "./QueueWorkspaceRow.jsx";

function renderRow(demoHasPlayerKeyboardInput) {
  return render(
    <QueueWorkspaceRow
      item={{
        demoFilename: "match.dem",
        demoPath: "C:/demos/match.dem",
        demoHasPlayerKeyboardInput,
        targetPlayer: "alpha",
        clipData: {
          category: "highlight",
          clip_id: "clip-1",
          map_name: "de_mirage",
          round: 12,
        },
      }}
      priorityIndex={1}
      selected={false}
      onSelect={() => {}}
      onRemove={() => {}}
      globalPacing={{}}
    />,
  );
}

describe("QueueWorkspaceRow in-game input HUD warning", () => {
  beforeEach(() => {
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
  });

  test("flags missing input data with a compact warning icon", () => {
    const missing = renderRow(false);
    const warning = screen.getByTestId("queue-input-hud-warning");
    expect(warning.getAttribute("aria-label")).toBe("该 Demo 缺少玩家键鼠数据");
    expect(warning.getAttribute("title")).toContain("无法显示键鼠可视化");
    expect(screen.getByText("第 12 回合", { exact: false })).toBeTruthy();
    missing.unmount();

    renderRow(null);
    expect(screen.queryByTestId("queue-input-hud-warning")).toBeNull();
  });
});
