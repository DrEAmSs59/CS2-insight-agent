import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import ClipCard from "./ClipCard.jsx";

describe("ClipCard primary metadata", () => {
  beforeEach(() => {
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
  });

  test("places the recording weapon beside the score instead of the detail row", () => {
    render(
      <ClipCard
        clip={{
          category: "highlight",
          client_clip_uid: "clip-1",
          round: 7,
          round_won: false,
          score_own: 2,
          score_opp: 4,
          weapon_used: "沙漠之鹰 / AK-47",
          context_tags: ["双杀"],
          start_tick: 37_009,
          end_tick: 38_590,
        }}
        selected={false}
        onToggle={() => {}}
      />,
    );

    const score = screen.getByTitle("本回合开局时比分（本方 : 对方）");
    const deagle = screen.getByText("沙漠之鹰");
    const ak47 = screen.getByText("AK-47");

    expect(deagle.parentElement).toBe(score.parentElement);
    expect(ak47.parentElement).toBe(score.parentElement);
    expect(deagle.className).toContain("border-cs2-accent/35");
  });
});
