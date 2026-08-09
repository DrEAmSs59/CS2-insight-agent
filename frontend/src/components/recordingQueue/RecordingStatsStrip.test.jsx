import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useLocaleStore } from "../../i18n/localeStore.js";
import RecordingStatsStrip from "./RecordingStatsStrip";

function renderStats(obsConfigured) {
  return render(
    <MemoryRouter>
      <RecordingStatsStrip
        pendingCount={1}
        totalEstimateSec={60}
        povSegmentCount={0}
        demoCount={1}
        queueStatusLabel="待开始"
        obsConfigured={obsConfigured}
        obsEndpointLabel="localhost:4455"
        obsConfigHasIssues={false}
      />
    </MemoryRouter>,
  );
}

describe("RecordingStatsStrip status badges", () => {
  beforeEach(() => {
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
  });

  test("uses solid orange and red badges while OBS is not configured", () => {
    renderStats(false);

    expect(screen.getByText("待开始").className).toContain("bg-cs2-accent");
    expect(screen.getByText("待开始").className).toContain("text-white");
    expect(screen.getByText("待开始").className).toContain("px-3");
    expect(screen.getByText("待开始").className).toContain("py-1");
    expect(screen.getByText("待开始").className).toContain("text-[11px]");
    expect(screen.getByText("OBS · 未配置").className).toContain("bg-cs2-fail");
    expect(screen.getByText("OBS · 未配置").className).toContain("text-white");
  });

  test("uses a solid green badge while OBS is configured", () => {
    renderStats(true);

    expect(screen.getByText("OBS · 已配置").className).toContain("bg-cs2-highlight");
    expect(screen.getByText("OBS · 已配置").className).toContain("text-white");
  });
});
