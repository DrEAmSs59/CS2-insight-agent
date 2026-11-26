import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { useLocaleStore } from "../../i18n/localeStore";
import QueuePlanStrip from "./QueuePlanStrip";

test.each([
  ["all_kills", "击杀", "killer", "victim", "受害者视角"],
  ["all_deaths", "死亡", "victim", "killer", "击杀者视角"],
])("%s shows every planned shot in playback order on expansion", (kind, action, main, replay, pov) => {
  useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh" });
  const item = {
    clipData: { category: "compilation", compilation_kind: kind },
    pacing_override: { victim_pov: true, killer_pov: true, group_victim_replays: true, group_killer_replays: true },
  };
  const shot = (round, perspective, ticks, name) => ({
    round, perspective, anchor_ticks: ticks, target_player_name: name,
    start_tick: ticks[0] - 64, end_tick: ticks.at(-1) + 64,
  });
  const segments = [
    shot(1, main, [1000, 1064], "me"), shot(2, main, [1300], "me"),
    shot(1, replay, [1000], "A"), shot(1, replay, [1064], "B"), shot(2, replay, [1300], "C"),
  ];
  for (let i = 0; i < 26; i += 1) {
    const tick = 3000 + i * 2000;
    segments.push(shot(i + 3, main, [tick], "me"), shot(i + 3, replay, [tick], `Player-${i}`));
  }
  const preview = (active_segments) => <QueuePlanStrip item={item} roundPlan={{
    status: "ready", plan: { tick_rate: 64, active_segments },
  }} />;
  const view = render(preview(segments));
  const labels = () => screen.getAllByRole("listitem").map((row) => row.title);
  const firstSix = [`${action} 1–2`, `${action} 3`, `${pov} · A`, `${pov} · B`, `${pov} · C`, `${action} 4`];
  expect(labels()).toEqual(firstSix);
  const button = screen.getByRole("button", { name: "展开余下 51 项" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(labels()).toHaveLength(57);
  expect(labels().slice(5)).toEqual(Array.from({ length: 26 }, (_, i) => [
    `${action} ${i + 4}`, `${pov} · Player-${i}`,
  ]).flat());
  fireEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(labels()).toEqual(firstSix);
  view.rerender(preview(segments.slice(0, 6)));
  expect(screen.queryByRole("button")).toBeNull();
});
