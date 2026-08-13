/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DemoPagination from "./DemoPagination.jsx";

vi.mock("../../../i18n/useT.js", () => ({
  useT: () => (key, params = {}) => {
    if (key === "library.paginationPageOf") return `${params.page}/${params.total}`;
    if (key === "library.paginationPerPage") return "每页";
    if (key === "library.paginationPerPageUnit") return "条";
    if (key === "library.paginationJump") return "跳转";
    if (key === "library.paginationGo") return "前往";
    return key;
  },
}));

describe("DemoPagination", () => {
  it("renders borderless controls for the list's integrated pagination region", () => {
    render(
      <DemoPagination
        libraryPage={1}
        libraryTotalPages={1}
        libraryHasNextPage={false}
        libraryPageSize={12}
        onPageSizeChange={vi.fn()}
        libraryJumpDraft=""
        onPageChange={vi.fn()}
        onJumpDraftChange={vi.fn()}
        onJumpSubmit={vi.fn()}
      />,
    );

    const tray = screen.getByTestId("demo-library-pagination-tray");
    expect(tray.className).not.toContain("rounded-lg");
    expect(tray.className).not.toContain("border-cs2-border");
    expect(tray.className).not.toContain("bg-cs2-bg-card");
    expect(tray.className).not.toContain("shadow");
    expect(tray.className).not.toContain("border-t");
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText("每页")).toBeTruthy();
    expect(screen.getByText("跳转")).toBeTruthy();
    expect(screen.getByRole("button", { name: "前往" })).toBeTruthy();
  });
});
