/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import Cs2LaunchConsoleFields from "./Cs2LaunchConsoleFields.jsx";

function Harness() {
  const [launchArgs, setLaunchArgs] = useState("-fullscreen\n-high");
  const [consoleLines, setConsoleLines] = useState("fps_max 0\ncl_demo_predict 0\nengine_no_focus_sleep 0");

  return (
    <div className="@container/params">
      <Cs2LaunchConsoleFields
        cs2ExtraLaunchArgs={launchArgs}
        onCs2ExtraLaunchArgsChange={setLaunchArgs}
        recordInjectConsoleLines={consoleLines}
        onRecordInjectConsoleLinesChange={setConsoleLines}
      />
    </div>
  );
}

describe("Cs2LaunchConsoleFields command manager", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  it("shows counts, filters each command list, and removes the original matched item", () => {
    render(<Harness />);

    expect(screen.getByText("5 条内置 · 2 条自定义")).toBeTruthy();
    expect(screen.getByText("3 条命令")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索启动参数…"), { target: { value: "high" } });
    expect(screen.getByText("-high")).toBeTruthy();
    expect(screen.queryByText("-fullscreen")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "移除启动项 -high" }));
    expect(screen.getByText("5 条内置 · 1 条自定义")).toBeTruthy();
    expect(screen.getByText("没有匹配的命令")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("搜索控制台命令…"), { target: { value: "predict" } });
    expect(screen.getByText("cl_demo_predict 0")).toBeTruthy();
    expect(screen.queryByText("fps_max 0")).toBeNull();
  });
});
