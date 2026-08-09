import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import API from "../api/api";
import { getObsConfigStatus } from "../api/obsConfigCenter";
import { useLocaleStore } from "../i18n/localeStore.js";
import GuidePage from "./GuidePage";

const useAppShellMock = vi.hoisted(() => vi.fn());

vi.mock("../api/api", () => ({
  default: { get: vi.fn() },
}));

vi.mock("../api/obsConfigCenter", () => ({
  getObsConfigStatus: vi.fn(),
}));

vi.mock("../context/AppShellContext", () => ({
  useAppShell: useAppShellMock,
}));

const staleStatus = {
  obs_configured: false,
  cs2_path_ok: true,
  ffmpeg_ok: false,
  ai_key_ok: false,
};

const freshStatus = {
  ...staleStatus,
  obs_configured: true,
};

function renderGuide() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <GuidePage />
    </MemoryRouter>,
  );
}

function obsSetupCard() {
  return screen.getByText("OBS 配置已验证").closest(".rounded-xl");
}

describe("GuidePage setup checklist refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
    useAppShellMock.mockReturnValue({ initialQuickCheckStatus: staleStatus });
    getObsConfigStatus.mockResolvedValue({ obs_connected: false });
  });

  test("checks the latest status on entry and does not show a stale failure while loading", async () => {
    let resolveQuickCheck;
    API.get.mockReturnValue(new Promise((resolve) => {
      resolveQuickCheck = resolve;
    }));

    renderGuide();

    await waitFor(() => expect(API.get).toHaveBeenCalledWith("/config/quick-check"));
    expect(obsSetupCard().className).toContain("bg-cs2-bg-card");
    expect(obsSetupCard().className).not.toContain("bg-cs2-red-surface");

    await act(async () => {
      resolveQuickCheck({ data: freshStatus });
    });

    await waitFor(() => {
      expect(obsSetupCard().className).toContain("bg-cs2-emerald-surface");
    });
  });

  test("checks again whenever the guide page is entered again", async () => {
    API.get.mockResolvedValue({ data: freshStatus });

    const firstVisit = renderGuide();
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(1));
    firstVisit.unmount();

    renderGuide();
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(2));
  });

  test("keeps both optional tags solid and theme-independent", async () => {
    API.get.mockResolvedValue({ data: freshStatus });

    renderGuide();
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(1));

    const optionalTags = screen.getAllByText("可选");
    expect(optionalTags).toHaveLength(2);
    optionalTags.forEach((tag) => {
      expect(tag.className).toContain("bg-cs2-neutral-tone");
      expect(tag.className).toContain("text-white");
    });
  });

  test("uses solid orange for required tags, quick-start numbers, and feature icons", async () => {
    API.get.mockResolvedValue({ data: freshStatus });

    renderGuide();
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(1));

    const requiredTags = screen.getAllByText("必需");
    expect(requiredTags).toHaveLength(2);
    requiredTags.forEach((tag) => {
      expect(tag.className).toContain("bg-cs2-accent");
      expect(tag.className).toContain("text-white");
    });

    ["1", "2", "3", "4"].forEach((step) => {
      const marker = screen.getByText(step, { selector: "div" });
      expect(marker.className).toContain("bg-cs2-accent");
      expect(marker.className).toContain("text-white");
    });

    const featureSection = screen.getByText("功能入口").closest("section");
    const featureIcons = featureSection.querySelectorAll("a > div:first-child");
    expect(featureIcons).toHaveLength(7);
    featureIcons.forEach((icon) => {
      expect(icon.className).toContain("bg-cs2-accent");
      expect(icon.className).toContain("text-white");
    });
  });
});
