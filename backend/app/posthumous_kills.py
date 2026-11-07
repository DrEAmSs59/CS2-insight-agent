"""Weapon-independent dead-attacker events. Never infer death from a weapon name."""
from bisect import bisect_left, bisect_right
from functools import lru_cache
from pathlib import Path


def records(value):
    if hasattr(value, "to_dict"):
        return value.to_dict(orient="records")
    return [dict(zip(value, row)) for row in zip(*value.values())]


def classify_posthumous_kills(deaths, spawns):
    """A strictly earlier death, with no subsequent spawn, identifies a dead attacker.

    Same-tick trades are deliberately not classified: event order inside a tick
    is insufficient evidence that the projectile was a post-death kill.
    SteamIDs, rather than display names, survive renames and duplicate nicknames.
    """
    dead, born = {}, {}
    for rows, target in ((deaths, dead), (spawns, born)):
        for row in rows:
            sid = str(row.get("user_steamid") or "")
            if sid and sid != "0":
                target.setdefault(sid, []).append(int(row["tick"]))
    for times in (*dead.values(), *born.values()):
        times.sort()
    result = {}
    for row in deaths:
        sid, tick = str(row.get("attacker_steamid") or ""), int(row["tick"])
        times = dead.get(sid, [])
        i = bisect_left(times, tick) - 1
        if i < 0:
            continue
        death_tick = times[i]
        births = born.get(sid, [])
        j = bisect_right(births, tick) - 1
        if j >= 0 and births[j] >= death_tick:
            continue
        fact = {
            "tick": tick, "attacker_death_tick": death_tick,
            "attacker_steamid": sid, "attacker_name": str(row.get("attacker_name") or "").strip(),
            "victim_steamid": str(row.get("user_steamid") or ""),
            "victim_name": str(row.get("user_name") or "").strip(),
            "weapon": str(row.get("weapon") or ""),
        }
        previous = result.get((sid, tick))
        if previous is None:
            result[(sid, tick)] = fact
        else:
            previous.setdefault("same_tick_kills", [dict(previous)]).append(fact)
    return result


def kills_at_tick(fact):
    return fact.get("same_tick_kills") or [fact]


@lru_cache(maxsize=8)
def _read(path, size, mtime_ns):
    from demoparser2 import DemoParser
    parser = DemoParser(path)
    result = classify_posthumous_kills(records(parser.parse_event("player_death")),
                                       records(parser.parse_event("player_spawn")))
    # A dead human controlling a living BOT still has a valid playable body.
    if result:
        flag = "CCSPlayerController.m_bControllingBot"
        for row in records(parser.parse_ticks([flag], ticks=sorted({k[1] for k in result}))):
            if row.get(flag):
                result.pop((str(row.get("steamid") or ""), int(row["tick"])), None)
    return result


def read_posthumous_kills(path):
    source = Path(path).resolve()
    stat = source.stat()
    return _read(str(source), stat.st_size, stat.st_mtime_ns)


@lru_cache(maxsize=8)
def _read_isolated(path, size, mtime_ns):
    from .demo_parse_isolation import run_parse_worker
    return run_parse_worker("posthumous_kills", dem_path=path)


def read_posthumous_kills_isolated(path):
    source = Path(path).resolve()
    stat = source.stat()
    return _read_isolated(str(source), stat.st_size, stat.st_mtime_ns)


def annotate_analysis_clips(clips, facts, target_sid, *, map_name, tick_rate=64):
    """Keep stats intact; split posthumous highlights without corrupting parallel arrays."""
    from dataclasses import replace
    from .features.demo_analysis.models import Clip
    target = {tick: dict(row) for (sid, tick), row in facts.items() if sid == str(target_sid)}
    output, covered = [], set()
    arrays = ("kill_ticks", "victims", "victim_steamid64s", "kill_spec_slots", "victim_spec_slots",
              "kill_weapons", "kill_headshots", "kill_tag_lists", "shots_to_kill")
    for clip in clips:
        relevant = [row for t in dict.fromkeys(clip.kill_ticks) if t in target for row in kills_at_tick(target[t])]
        if clip.category == "compilation" and clip.compilation_kind not in {"all_deaths", "nemesis_deaths", "freeze_to_death"}:
            clip.posthumous_kills = relevant
        if clip.category != "highlight" or not relevant:
            output.append(clip)
            continue
        normal = [i for i, tick in enumerate(clip.kill_ticks) if tick not in target]
        if normal:
            updates = {key: [getattr(clip, key)[i] for i in normal if i < len(getattr(clip, key))] for key in arrays}
            updates.update(kill_count=len(normal), posthumous_kills=[],
                           context_tags=[t for t in clip.context_tags if t not in {"双杀", "三杀", "四杀", "五杀 (ACE)"}],
                           end_tick=min(clip.end_tick, min(r["attacker_death_tick"] for r in relevant)))
            output.append(replace(clip, **updates))
        for row in relevant:
            tick = row["tick"]
            identity = (tick, row["victim_steamid"])
            if identity in covered:
                continue
            covered.add(identity)
            output.append(replace(clip, clip_id=f"{clip.clip_id}_post_{tick}_{row['victim_steamid']}", kill_count=1,
                kill_ticks=[tick], victims=[row["victim_name"]], victim_steamid64s=[row["victim_steamid"]],
                kill_spec_slots=[], victim_spec_slots=[], kill_weapons=[row["weapon"]],
                kill_headshots=[], kill_tag_lists=[], shots_to_kill=[], context_tags=["死后击杀"],
                weapon_used=row["weapon"], start_tick=max(0,tick-3*tick_rate), end_tick=tick+2*tick_rate,
                posthumous_kills=[row], ai_score=None, ai_commentary=None))
    # Even a single posthumous kill which did not meet the highlight score is visible.
    for tick, row in [(tick, row) for tick, fact in target.items() for row in kills_at_tick(fact)]:
        if (tick, row["victim_steamid"]) in covered:
            continue
        containing = next((c for c in clips if tick in c.kill_ticks and c.category == "compilation"), None)
        rnd = 0
        if containing:
            idx = containing.kill_ticks.index(tick)
            rnd = containing.source_rounds[idx] if idx < len(containing.source_rounds) else containing.round
        output.append(Clip(clip_id=f"post_{target_sid}_{tick}_{row['victim_steamid']}", map_name=map_name, round=rnd,
            category="highlight", weapon_used=row["weapon"], kill_count=1,
            start_tick=max(0,tick-3*tick_rate), end_tick=tick+2*tick_rate,
            context_tags=["死后击杀"], kill_ticks=[tick], victims=[row["victim_name"]],
            victim_steamid64s=[row["victim_steamid"]], posthumous_kills=[row]))
    return sorted(output, key=lambda c:(c.round,c.start_tick))


def annotate_timeline(value, facts, scope=""):
    if isinstance(value, list):
        for item in value:
            annotate_timeline(item, facts, scope)
    elif isinstance(value, dict):
        row = facts.get((str(value.get("attacker_steamid") or ""), value.get("tick")))
        if row:
            value.update(posthumous=True, attacker_death_tick=row["attacker_death_tick"],
                         posthumous_choice_key=f"{scope}:{row['attacker_steamid']}:{row['tick']}:{value.get('victim_steamid', '')}")
        for child in list(value.values()):
            if isinstance(child, (list, dict)):
                annotate_timeline(child, facts, scope)
