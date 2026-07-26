import { describe, expect, test, vi } from "vitest";
import { demoAnalysisSessionIdentity, resetDemoAnalysisDefaultView } from "./demoAnalysisSession";

describe("demoAnalysisSession", () => {
  test("resets a Demo-library re-entry to Highlights", () => {
    const storage = { removeItem: vi.fn() };
    const demo = { id: 7, path: "C:/demos/cached.dem" };

    resetDemoAnalysisDefaultView([demo], storage);

    expect(storage.removeItem).toHaveBeenCalledWith(
      `cs2-session-demo-analysis:${demoAnalysisSessionIdentity(demo)}:tab`,
    );
  });
});
