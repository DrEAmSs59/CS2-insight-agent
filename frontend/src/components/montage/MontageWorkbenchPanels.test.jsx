/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MontageMaterialPoolCard, MontageWorkbenchToolbar } from "./MontageWorkbenchPanels.jsx";

const translate = (key, params = {}) => {
  if (key === "montage.toolbarSaveDraftDialogHint") return `fallback: ${params.name}`;
  return key;
};

vi.mock("../../i18n/useT.js", () => ({ useT: () => translate }));

function renderToolbar(onSaveDraft, onDrafts = vi.fn()) {
  render(
    <MontageWorkbenchToolbar
      isPage
      montageTitle="montage_20260809_2108"
      subtitle="subtitle"
      autosaveLabel="ready"
      poolSelectedCount={2}
      poolStats={{ count: 5, totalLabel: "00:51", avgLabel: "10.2s" }}
      onAutoSort={vi.fn()}
      onTimelineSort={vi.fn()}
      onRhythmSort={vi.fn()}
      onRandomSort={vi.fn()}
      onReverseOrder={vi.fn()}
      onSaveDraft={onSaveDraft}
      savingDraft={false}
      saveDraftNameFallback="montage_20260809_2108"
      onHistory={vi.fn()}
      onDrafts={onDrafts}
    />,
  );
}

describe("MontageWorkbenchToolbar save dialog", () => {
  it("places a working drafts button after history", () => {
    const onDrafts = vi.fn();
    renderToolbar(vi.fn(), onDrafts);

    const historyButton = screen.getByRole("button", { name: "montage.toolbarHistoryBtn" });
    const draftsButton = screen.getByRole("button", { name: "montage.toolbarDraftsBtn" });
    expect(screen.getByTestId("montage-workbench-toolbar-card").className).toContain("rounded-lg");
    expect(screen.getByTestId("montage-workbench-toolbar-card").className).toContain("border-cs2-border");
    expect(screen.getByTestId("montage-workbench-toolbar-card").className).not.toContain("shadow-sm");
    expect(screen.getByTestId("montage-toolbar-pool-summary")).toBeTruthy();
    expect(screen.getByText("montage.poolSelectedCount")).toBeTruthy();
    const actionIcons = document.querySelectorAll("[data-toolbar-action-icon]");
    expect(actionIcons).toHaveLength(4);
    actionIcons.forEach((icon) => {
      expect(icon.getAttribute("class")).toContain("h-4");
      expect(icon.getAttribute("class")).toContain("w-4");
      expect(icon.getAttribute("class")).toContain("text-cs2-accent");
    });
    expect(historyButton.compareDocumentPosition(draftsButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(draftsButton);
    expect(onDrafts).toHaveBeenCalledTimes(1);
  });

  it("uses the current montage name when the optional name is left blank", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(true);
    renderToolbar(onSaveDraft);

    fireEvent.click(screen.getByRole("button", { name: "montage.toolbarSaveDraftBtn" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("fallback: montage_20260809_2108")).toBeTruthy();
    expect(screen.getByLabelText("montage.toolbarSaveDraftNameLabel").getAttribute("placeholder")).toBe(
      "montage_20260809_2108",
    );

    fireEvent.click(screen.getByRole("button", { name: "montage.toolbarSaveDraftConfirmBtn" }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith(""));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("passes an entered name to the shared save handler", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue(true);
    renderToolbar(onSaveDraft);

    fireEvent.click(screen.getByRole("button", { name: "montage.toolbarSaveDraftBtn" }));
    fireEvent.change(screen.getByLabelText("montage.toolbarSaveDraftNameLabel"), {
      target: { value: "Dust2 ACE 精选" },
    });
    fireEvent.click(screen.getByRole("button", { name: "montage.toolbarSaveDraftConfirmBtn" }));

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledWith("Dust2 ACE 精选"));
  });
});

describe("MontageMaterialPoolCard type tone", () => {
  it.each([
    ["highlight ace", { category: "highlight", kill_count: 5 }, "bg-cs2-fail", "text-white"],
    ["fail", { category: "fail", kill_count: 0 }, "bg-cs2-fail", "text-white"],
    ["compilation", { category: "compilation", kill_count: 0 }, "bg-cs2-compilation", "text-[#3b2e00]"],
    ["highlight", { category: "highlight", kill_count: 1 }, "bg-cs2-highlight", "text-white"],
  ])("uses one solid color for the %s badge and bar", (_name, clipPatch, colorClass, textClass) => {
    const { container } = render(
      <MontageMaterialPoolCard
        clip={{ id: `clip-${clipPatch.category}-${clipPatch.kill_count}`, player_name: "Player", context_tags: [], ...clipPatch }}
        onAdd={vi.fn()}
        onDelete={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onClickMulti={vi.fn()}
      />,
    );

    const card = container.querySelector("li");
    const bar = card.firstElementChild;
    const badge = screen.getByText(
      clipPatch.category === "fail" ? "montage.clipTypeFail" : clipPatch.category === "compilation" ? "montage.clipTypeCompilation" : "montage.clipTypeHighlight",
    );
    expect(bar.className).toContain(colorClass);
    expect(badge.className).toContain(colorClass);
    expect(badge.className).toContain(textClass);
  });
});
