import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import CommonParamsModal from "./CommonParamsModal.jsx";

vi.mock("../api/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

function setDesktopLayout(matches) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function renderPresetPage() {
  return render(
    <CommonParamsModal
      variant="page"
      open
      onClose={() => {}}
      batchRecording={false}
      configReady
    />,
  );
}

function directSectionTitles(container) {
  return Array.from(container.children).map((section) =>
    within(section).getByRole("heading", { level: 3 }).textContent,
  );
}

describe("CommonParamsModal recording preset layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockReturnValue(new Promise(() => {}));
    useLocaleStore.getState().hydrate("zh");
  });

  it("keeps the two preset-only sections on top and matches warmup order below", () => {
    setDesktopLayout(false);
    renderPresetPage();

    expect(directSectionTitles(screen.getByTestId("recording-preset-top-grid"))).toEqual([
      "时间与多段节奏",
      "回看视角预设",
    ]);
    expect(directSectionTitles(screen.getByTestId("recording-preset-grid"))).toEqual([
      "OBS 转场",
      "观战画面与调试",
      "镜头与持枪",
      "录制实验性功能",
      "录制画布",
      "启动参数与控制台",
    ]);
    expect(screen.queryByTestId("player-aliases-section")).toBeNull();
    const cameraSection = screen.getByRole("heading", { name: "镜头与持枪" }).closest("section");
    const experimentalSection = screen
      .getByRole("heading", { name: "录制实验性功能" })
      .closest("section");
    expect(cameraSection).not.toBe(experimentalSection);
    expect(experimentalSection.className).toContain("bg-cs2-amber-surface");
    expect(experimentalSection.className).not.toContain("bg-cs2-bg-card");
    expect(within(experimentalSection).getByText(/^POV 是实验性功能，仅用于本地 Demo 回放录制/))
      .toBeTruthy();
    expect(within(experimentalSection).queryByTestId("experimental-pov-disclaimer")).toBeNull();
    expect(screen.queryByText(/恢复数值类节奏为后端内置默认/)).toBeNull();
  });

  it("uses the same left and right groups as recording warmup on desktop", () => {
    setDesktopLayout(true);
    renderPresetPage();

    expect(directSectionTitles(screen.getByTestId("recording-preset-column-left"))).toEqual([
      "OBS 转场",
      "观战画面与调试",
      "镜头与持枪",
      "启动参数与控制台",
    ]);
    expect(directSectionTitles(screen.getByTestId("recording-preset-column-right"))).toEqual([
      "录制实验性功能",
      "录制画布",
    ]);
  });
});
