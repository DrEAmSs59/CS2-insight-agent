import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import DemoInfoModal from "./DemoInfoModal";

vi.mock("../api/api", () => ({
  default: { get: vi.fn() },
}));

vi.mock("../hooks/useDemoPlaybackDialog.jsx", () => ({
  useDemoPlaybackDialog: () => ({
    requestPlayDemo: vi.fn(),
    DemoPlaybackUi: () => null,
  }),
}));

describe("DemoInfoModal player identity labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  test("shows the player nickname instead of the SteamID-backed result key", async () => {
    const steamId = "76561198981861845";
    const playerKey = `steamid:${steamId}`;
    API.get.mockResolvedValue({
      data: {
        id: 6,
        filename: "9215528484859195404_0.dem",
        map_name: "de_dust2",
        total_rounds: 20,
        team_a_score: 13,
        team_b_score: 7,
        players: [{ name: "Hhippo", steam_id64: steamId, team: 2 }],
        result: {
          players: {
            [playerKey]: {
              clips: [],
              match_meta: { target_player: "Hhippo", target_steam_id: steamId },
            },
          },
        },
      },
    });

    render(
      <DemoInfoModal
        open
        demoId={6}
        onClose={vi.fn()}
        onAddToQueue={vi.fn()}
      />,
    );

    const actionBar = await screen.findByTestId("clip-selection-action-bar");
    await waitFor(() => expect(within(actionBar).getAllByText(/Hhippo/).length).toBeGreaterThan(0));
    expect(actionBar.textContent).not.toContain("steamid:");
    expect(actionBar.textContent).not.toContain(steamId);
  });
});
