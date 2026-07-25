import { describe, expect, it } from "vitest";

describe("overview presentational cards smoke imports", () => {
  it("imports all eight Task 5 components", async () => {
    const modules = await Promise.all([
      import("./MatchMainlineCard.jsx"),
      import("./MatchTrendCard.jsx"),
      import("./SidePerformanceCard.jsx"),
      import("./EconomyInsightCard.jsx"),
      import("./OpeningAdvantageCard.jsx"),
      import("./BombObjectiveCard.jsx"),
      import("./PlayerEventsCard.jsx"),
      import("./KeyRoundsTimeline.jsx"),
    ]);

    for (const mod of modules) {
      expect(typeof mod.default).toBe("function");
    }
  });
});
