/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LiteCutProjectStartPage from "./LiteCutProjectStartPage.jsx";
import { useLocaleStore } from "../../../i18n/localeStore.js";

describe("LiteCutProjectStartPage", () => {
  beforeEach(() => useLocaleStore.getState().hydrate("zh"));
  it("opens an existing project only after the user chooses it", async () => {
    const onOpenProject = vi.fn();
    render(
      <LiteCutProjectStartPage
        projects={[{ id: 12, name: "Dust2 highlights", updated_at: "2026-07-05T10:00:00Z" }]}
        onOpenProject={onOpenProject}
      />,
    );

    expect(onOpenProject).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Dust2 highlights/ })));
    expect(onOpenProject).toHaveBeenCalledWith(12);
  });

  it("opens the project settings dialog instead of creating immediately", () => {
    const onNewProject = vi.fn();
    render(<LiteCutProjectStartPage projects={[]} onNewProject={onNewProject} />);

    fireEvent.click(screen.getByRole("button", { name: /新建工程/ }));
    expect(screen.getByRole("dialog", { name: "新建 LiteCut 工程" })).toBeTruthy();
    expect(onNewProject).not.toHaveBeenCalled();
  });
});
