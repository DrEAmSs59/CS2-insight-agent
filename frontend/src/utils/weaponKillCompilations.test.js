import { describe, expect, it } from "vitest";
import {
  buildWeaponKillCompilationClipData,
  groupTimelineKillsByWeapon,
  summarizeWeaponKills,
} from "./weaponKillCompilations.js";
import { buildDtoFromQueueItem } from "../recording/buildDtoFromQueueItem.js";
import { buildTimelineEventClipData } from "./timelineQueue.js";

const roundTimeline = [
  {
    round_number: 1,
    events: [
      {
        id: "ak-1",
        type: "kill",
        record_type: "kill",
        tick: 1000,
        weapon_key: "ak47",
        weapon_name: "AK-47",
        attacker_spec_slot: 3,
        victim_name: "one",
        victim_steamid: "11",
        victim_spec_slot: 4,
        is_headshot: true,
        start_tick: 700,
        end_tick: 1250,
      },
      {
        id: "awp-1",
        type: "kill",
        tick: 1400,
        weapon_key: "awp",
        weapon_name: "AWP",
        victim_name: "two",
        start_tick: 1100,
        end_tick: 1650,
      },
    ],
  },
  {
    round_number: 2,
    events: [
      {
        id: "ak-2",
        record_type: "kill",
        tick: 3000,
        weapon_key: "5e_match_ak47",
        weapon_name: "AK-47",
        victim_name: "three",
        victim_steamid: "33",
        start_tick: 2700,
        end_tick: 3250,
      },
      { id: "death", type: "death", tick: 3500, weapon_key: "ak47" },
    ],
  },
];

describe("weapon kill compilations", () => {
  it("groups only kill events by normalized weapon key", () => {
    const groups = groupTimelineKillsByWeapon(roundTimeline, "en");
    expect(groups.map((group) => [group.weaponKey, group.killCount])).toEqual([
      ["ak47", 2],
      ["awp", 1],
    ]);
    expect(groups[0].roundCount).toBe(2);
    expect(summarizeWeaponKills(roundTimeline)).toEqual({ groupCount: 2, killCount: 3 });
  });

  it("builds the existing kill-compilation recording contract", () => {
    const [akGroup] = groupTimelineKillsByWeapon(roundTimeline, "en");
    const clipData = buildWeaponKillCompilationClipData({
      events: akGroup.events,
      weaponKey: akGroup.weaponKey,
      weaponName: akGroup.weaponName,
      mapName: "de_mirage",
      targetPlayer: "target",
      demoFilename: "match.dem",
      locale: "en",
    });

    expect(clipData.compilation_kind).toBe("weapon_kills");
    expect(clipData.kill_ticks).toEqual([1000, 3000]);
    expect(clipData.source_rounds).toEqual([1, 2]);
    expect(clipData.victims).toEqual(["one", "three"]);
    expect(clipData.client_clip_uid).toContain("weapon_kills:match.dem:target:ak47");

    const dto = buildDtoFromQueueItem(
      {
        id: "queue-1",
        demoPath: "C:/demos/match.dem",
        demoFilename: "match.dem",
        targetPlayer: "target",
        targetSteamId: "7656119",
        clipData,
      },
      { total_rounds: 2, map_name: "de_mirage", all_players: [] },
    );

    expect(dto.request_type).toBe("kill_compilation");
    expect(dto.source_ref.group_id).toBe("weapon_kills");
    expect(dto.events).toHaveLength(2);
    expect(dto.events.map((event) => event.round)).toEqual([1, 2]);
    expect(dto.events[0].victim.spec_slot).toBe(4);
  });

  it("keeps individual weapon rows on the timeline-kill path with one victim POV", () => {
    const event = roundTimeline[0].events[0];
    const clipData = buildTimelineEventClipData({
      event,
      mapName: "de_mirage",
      targetPlayer: "target",
      round: 1,
      locale: "en",
    });
    const dto = buildDtoFromQueueItem(
      {
        id: "single-kill",
        demoPath: "C:/demos/match.dem",
        demoFilename: "match.dem",
        targetPlayer: "target",
        targetSteamId: "7656119",
        clipData,
        pacing_override: { victim_pov: true },
      },
      { total_rounds: 2, map_name: "de_mirage", all_players: [] },
    );

    expect(dto.request_type).toBe("timeline_kill");
    expect(dto.events).toHaveLength(1);
    expect(dto.events[0].victim.name).toBe("one");
    expect(dto.events[0].victim.spec_slot).toBe(4);
    expect(dto.options.enable_victim_pov).toBe(true);
  });
});
