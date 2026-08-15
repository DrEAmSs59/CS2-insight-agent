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

describe("QueueWorkspaceRow keyboard input warning", () => {
  beforeEach(() => {
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
  });

  test("shows the warning only when input data is confirmed missing", () => {
    const missing = renderRow(false);
    const warning = screen.getByTestId("queue-keyboard-input-warning");
    expect(screen.getByText("该 Demo 中缺失玩家键盘输入数据")).toBeTruthy();
    expect(screen.getByText("无法正常显示 OBS 虚拟键盘 Overlay")).toBeTruthy();
    expect(warning.className).toContain("w-fit");
    expect(warning.className).toContain("max-w-[290px]");
    missing.unmount();

    renderRow(null);
    expect(screen.queryByTestId("queue-keyboard-input-warning")).toBeNull();
  });
});
