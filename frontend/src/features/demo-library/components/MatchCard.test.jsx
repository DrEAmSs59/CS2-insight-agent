/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../../../i18n/localeStore.js";
import MatchCard, { MatchListRow } from "./MatchCard.jsx";

const demo = {
  id: 42,
  filename: "mirage.dem",
  map_name: "de_mirage",
  team_a_score: 13,
  team_b_score: 8,
  total_rounds: 21,
  duration_mins: 30,
  players: [],
  result: {},
};

function baseProps(onLoad) {
  return {
    demo,
    isSelected: false,
    onSelect: vi.fn(),
    onPlay: vi.fn(),
    onOpenFile: vi.fn(),
    onDelete: vi.fn(),
    onUpdateRemark: vi.fn(),
    onLoad,
  };
}

describe("Demo library card load shortcut", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  it("loads the grid card directly from the note row", () => {
    const onLoad = vi.fn();
    render(<MatchCard {...baseProps(onLoad)} />);

    fireEvent.click(screen.getByRole("button", { name: "载入选中" }));
    expect(onLoad).toHaveBeenCalledWith(42);
  });

  it("opens the grid card in Demo Analysis through the same load path", () => {
    const onLoad = vi.fn();
    const { container } = render(<MatchCard {...baseProps(onLoad)} />);

    fireEvent.click(container.querySelector(".match-card"));
    expect(onLoad).toHaveBeenCalledWith(42);
  });

  it("provides the same shortcut in list mode", () => {
    const onLoad = vi.fn();
    render(<MatchListRow {...baseProps(onLoad)} />);

    fireEvent.click(screen.getByRole("button", { name: "载入选中" }));
    expect(onLoad).toHaveBeenCalledWith(42);
  });

  it("opens the list row in Demo Analysis through the same load path", () => {
    const onLoad = vi.fn();
    const { container } = render(<MatchListRow {...baseProps(onLoad)} />);

    fireEvent.click(container.querySelector(".match-list-row"));
    expect(onLoad).toHaveBeenCalledWith(42);
  });

  it("shows card-local feedback and blocks duplicate loads while opening", () => {
    const onLoad = vi.fn();
    const { container } = render(
      <MatchCard {...baseProps(onLoad)} isLoading loadDisabled />,
    );

    const card = container.querySelector(".match-card");
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(card.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(card);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("shows complete player IDs in both grid and list views", () => {
    const longPlayerId = "CompletePlayerIdentifier_123456";
    const rosterDemo = {
      ...demo,
      players: [
        { name: longPlayerId, team_number: 2 },
        { name: "OpponentIdentifier_654321", team_number: 3 },
      ],
    };

    const grid = render(<MatchCard {...baseProps(vi.fn())} demo={rosterDemo} />);
    expect(screen.getByText(longPlayerId)).toBeTruthy();
    expect(grid.container.textContent).not.toContain(`${longPlayerId.slice(0, 8)}..`);
    grid.unmount();

    const list = render(<MatchListRow {...baseProps(vi.fn())} demo={rosterDemo} />);
    expect(screen.getByText(longPlayerId)).toBeTruthy();
    expect(list.container.textContent).not.toContain(`${longPlayerId.slice(0, 8)}..`);
  });
});
