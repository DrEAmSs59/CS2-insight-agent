import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ClipCard from "./ClipCard";
import KillfeedEventRow from "../features/demo-analysis/workspaces/timeline/KillfeedEventRow";
import { usePosthumousChoices, withPosthumousChoice } from "../utils/posthumousKills";
import { buildHighlightRecordingRequest, buildTimelineKillRecordingRequest } from "../recording/recordingRequestFactory";
import { buildTimelineEventClipData } from "../utils/timelineQueue";
import { useLocaleStore } from "../i18n/localeStore";

const clip = { category:"highlight",client_clip_uid:"post-80077",round:16,weapon_used:"smokegrenade",
  kill_count:1,kill_ticks:[80077],victims:["sh0rl"],victim_steamid64s:["76561199090191861"],
  posthumous_kills:[{tick:80077,attacker_death_tick:79743}],context_tags:[] };

beforeEach(() => {
  usePosthumousChoices.setState({choices:{}});
  useLocaleStore.setState({locale:"zh",effectiveLocale:"zh",hydrated:true});
});

describe("posthumous selection", () => {
  it("keeps a smoke impact kill visible but blocks selection until victim POV is chosen", () => {
    render(<ClipCard clip={clip} selected={false} onToggle={vi.fn()} onEnqueue={vi.fn()} />);
    expect(screen.getByRole("checkbox").disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"victim"}});
    expect(screen.getByRole("checkbox").disabled).toBe(false);
    const chosen = withPosthumousChoice(clip,usePosthumousChoices.getState().choices);
    const dto = buildHighlightRecordingRequest(chosen,{targetPlayer:"C411M3RikkL",targetSteamId:"76561199134553751"},{});
    expect(dto.options.posthumous_mode).toBe("victim");
    expect(dto.events[0].victim.steamid64).toBe("76561199090191861");
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"skip"}});
    expect(screen.getByRole("checkbox").disabled).toBe(true);
  });

  it("lets normal events in a compilation remain selectable by default", () => {
    render(<ClipCard clip={{...clip,category:"compilation",kill_ticks:[79000,80077]}} selected={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("checkbox").disabled).toBe(false);
  });

  it("provides the same explicit victim choice on timeline rows and carries it to the DTO", () => {
    const event = {id:"event-80077",type:"kill",record_type:"kill",can_record:true,posthumous:true,
      tick:80077,attacker_death_tick:79743,attacker_name:"C411M3RikkL",victim_name:"sh0rl",
      victim_steamid:"76561199090191861",weapon_name:"flashbang",start_tick:79500,end_tick:80200};
    const onRowClick=vi.fn();
    render(<KillfeedEventRow event={event} onRowClick={onRowClick} />);
    fireEvent.change(screen.getByRole("combobox"),{target:{value:"victim"}});
    const cd=buildTimelineEventClipData({event,round:16,targetPlayer:"C411M3RikkL"});
    cd.posthumous_mode=usePosthumousChoices.getState().choices[event.id];
    const dto=buildTimelineKillRecordingRequest(cd,{targetPlayer:"C411M3RikkL",targetSteamId:"76561199134553751"},{});
    expect(dto.options.posthumous_mode).toBe("victim");
    expect(cd.posthumous_kills[0].tick).toBe(80077);
    expect(dto.events[0].victim.steamid64).toBe("76561199090191861");
  });
});
