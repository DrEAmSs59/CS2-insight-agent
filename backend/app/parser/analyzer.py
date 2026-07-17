from __future__ import annotations

import logging
import os
import uuid
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Optional

import pandas as pd
from demoparser2 import DemoParser

from .models import MatchMeta, Clip, ParseResult, meme_series_badges_for_kd
from .weapons import (
    SNIPER_WEAPONS, _normalize_item, _translate_weapon, _highlight_weapon_used_label,
    _is_knife_highlight_weapon, DEAGLE_VARIANTS,
)
from .tag_constants import (
    TICK_RATE, BUFFER_SECONDS_BEFORE, BUFFER_SECONDS_AFTER,
    _dedup_context_tags, _EXTRA_EVENT_FIELDS, _PLAYER_DEATH_GAME_KEYS,
    _backstab_aim_sample_offsets_sec,
    _ZOMBIE_STEP_PRE_TICKS, _STROLL_PRE_TICKS,
    _SHOULDER_SAMPLE_INTERVAL, _FLYING_SNIPER_LOOKBACK_TICKS,
    _KEQIAO_WEAPONS,
    _FLASH_GOOD_DUR_SEC,
)
from .parse_utils import (
    _to_pandas_df, _safe_parse_event, safe_parse_events_batch,
    _DEMOPARSER_RE_RAISE, _bool, _int, _max_demo_tick,
    _duration_mins_from_tick_span, _get_match_start_tick,
    _count_team_wins_from_round_end_df, _infer_total_rounds_from_round_end,
    _pick_assister_column, win_panel_ceiling_from_match_tick,
)
from .round_economy import (
    build_round_economy, build_round_economy_shared, extract_player_team_maps,
    build_round_scores, build_round_scores_team_based,
    _scoreline_by_starting_roster, _extract_team_names_from_demo,
    build_group_side_by_round, round_target_team_map_from_groups,
    compute_team_identity_scoreline, _round_end_frame_usable,
)
from .player_roster import (
    build_player_name_to_user_id, build_player_name_to_steam_id,
    build_player_name_to_spec_player_slot_dict,
    _build_all_players_roster, _spec_player_slot_from_event_user_id,
    _lookup_user_id_for_name, _lookup_steam_id_for_name,
    lookup_spec_player_slot_for_name,
    build_steam_to_team_from_player_info, build_name_to_team_from_player_info,
    get_player_list,
)
from .spatial_analysis import (
    parse_spatial_snapshots, _victim_facing_attacker, is_jump_kill,
    detect_kill_action_tags, enrich_kill_action_tags_spatial,
    _spatial_snap_pre_kill, _alive_mates_and_enemies,
)
from .tag_detection import (
    build_highlight_tags, _extend_tags_unique,
)
from .clip_builder import (
    build_fail_clips, build_rival_compilations, detect_shoulder_clips,
    analyze_bomb_defuse_highlights, collect_target_defuse_ticks_for_spatial,
    match_metrics_from_round_scores, is_post_match_round,
    round_start_scores_for_target, is_mr12_regulation_decided_score,
)
from .spatial_analysis import count_shots_before

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class SharedDemoFacts:
    """Player-independent analysis facts materialized once per Demo.

    The native parser is intentionally kept out of the per-player finish path.
    Mutable values are treated as read-only; player-specific builders copy the
    small structures they need before applying any corrections.
    """

    match_summary: tuple[int, int, str, int, str, str]
    demo_max_tick: int
    name_to_uid: dict[str, int]
    observed_user_ids: tuple[int, ...]
    spec_slots: dict[str, int]
    name_to_sid: dict[str, int]
    all_players_roster: list[dict]
    server_name: str
    round_scores_by_round: dict[int, dict[int, int]]
    victim_blind_index: dict[str, list[tuple[int, float]]]
    grenade_detonate_points: list[tuple[int, float, float]]
    bomb_explode_tick_map: dict[int, int]
    round_end_tick_map: dict[int, int]
    timeline_event_positions_by_player: dict[str, tuple[int, ...]]

    def roster_snapshot(self) -> list[dict]:
        """Return an isolated roster for one ParseResult output."""
        return [dict(player) for player in self.all_players_roster]


@dataclass(slots=True)
class SharedPlayerIndexes:
    """Player-keyed Python indexes built once from shared event frames."""

    equip_by_player: dict[str, tuple[tuple[int, str], ...]]
    fire_by_player: dict[str, tuple[tuple[int, str], ...]]
    hurt_by_attacker: dict[str, tuple[tuple[int, str, int], ...]]
    defuse_windows_by_player: dict[str, dict[int, tuple[int, int]]]
    round_hurt_by_victim: dict[str, dict[int, tuple[tuple[int, int, str], ...]]]
    enemy_hurts: tuple[tuple[int, Any, str, str, int], ...]
    team_kills: dict[int, dict[Any, dict[str, int]]]


def _build_shared_player_indexes(
    *,
    events: pd.DataFrame,
    fire_df: pd.DataFrame,
    hurt_df: pd.DataFrame,
    equip_df: pd.DataFrame,
    begindefuse_df: pd.DataFrame,
    defused_df: pd.DataFrame,
    round_freeze_end_ticks: dict[int, int],
) -> SharedPlayerIndexes:
    equip_by_player: dict[str, list[tuple[int, str]]] = {}
    if not equip_df.empty and {"user_name", "tick"}.issubset(equip_df.columns):
        item_col = "item" if "item" in equip_df.columns else None
        if item_col is not None:
            for player, tick, item in equip_df[["user_name", "tick", item_col]].itertuples(
                index=False,
                name=None,
            ):
                if not isinstance(player, str):
                    continue
                equip_by_player.setdefault(player, []).append(
                    (_int(tick), _normalize_item(item))
                )

    fire_by_player: dict[str, list[tuple[int, str]]] = {}
    if not fire_df.empty and {"user_name", "tick"}.issubset(fire_df.columns):
        columns = ["user_name", "tick"]
        if "weapon" in fire_df.columns:
            columns.append("weapon")
        for values in fire_df[columns].itertuples(index=False, name=None):
            player, tick = values[0], values[1]
            if not isinstance(player, str):
                continue
            weapon = _normalize_item(values[2]) if len(values) > 2 else ""
            fire_by_player.setdefault(player, []).append((_int(tick), weapon))

    hurt_by_attacker: dict[str, list[tuple[int, str, int]]] = {}
    round_hurt_by_victim: dict[str, dict[int, list[tuple[int, int, str]]]] = {}
    enemy_hurts: list[tuple[int, Any, str, str, int]] = []
    if not hurt_df.empty and {"attacker_name", "user_name", "tick"}.issubset(hurt_df.columns):
        round_damage_col = next(
            (name for name in ("dmg_health", "damage", "health_damage") if name in hurt_df.columns),
            None,
        )
        columns = ["attacker_name", "user_name", "tick"]
        for optional_column in (
            round_damage_col,
            "weapon" if "weapon" in hurt_df.columns else None,
            "total_rounds_played" if "total_rounds_played" in hurt_df.columns else None,
            "attacker_team" if "attacker_team" in hurt_df.columns else None,
            "user_team" if "user_team" in hurt_df.columns else None,
        ):
            if optional_column and optional_column not in columns:
                columns.append(optional_column)
        positions = {name: index for index, name in enumerate(columns)}
        freeze_ticks_desc = sorted(
            ((int(tick), int(round_number)) for round_number, tick in round_freeze_end_ticks.items()),
            reverse=True,
        )
        has_team_columns = "attacker_team" in positions and "user_team" in positions
        for values in hurt_df[columns].itertuples(index=False, name=None):
            attacker_raw = values[positions["attacker_name"]]
            victim_raw = values[positions["user_name"]]
            attacker = str(attacker_raw or "").strip()
            victim = str(victim_raw or "").strip()
            tick = _int(values[positions["tick"]])
            round_damage = (
                _int(values[positions[round_damage_col]]) if round_damage_col else 0
            )
            weapon = (
                _normalize_item(values[positions["weapon"]])
                if "weapon" in positions
                else ""
            )
            # Keep build_hurt_index's legacy contract: fail-tag damage only
            # exists when demoparser supplied dmg_health specifically.
            if attacker and "dmg_health" in positions:
                hurt_by_attacker.setdefault(attacker, []).append(
                    (tick, victim, _int(values[positions["dmg_health"]]))
                )

            event_round_number = 0
            if "total_rounds_played" in positions:
                event_round_number = _int(values[positions["total_rounds_played"]]) + 1
            round_number = event_round_number
            if round_number <= 0 and tick > 0:
                round_number = next(
                    (rn for freeze_tick, rn in freeze_ticks_desc if tick >= freeze_tick),
                    0,
                )
            if victim and round_number > 0:
                round_hurt_by_victim.setdefault(victim, {}).setdefault(
                    round_number,
                    [],
                ).append((tick, round_damage, weapon))

            if not attacker or not victim or attacker == victim:
                continue
            attacker_team: Any = None
            if has_team_columns:
                raw_attacker_team = values[positions["attacker_team"]]
                raw_victim_team = values[positions["user_team"]]
                try:
                    if raw_attacker_team == raw_victim_team:
                        continue
                    attacker_team = raw_attacker_team
                except Exception:
                    attacker_team = None
            # The teammate filter historically used only the event's explicit
            # round field.  Do not feed its freeze-tick fallback into that path.
            enemy_hurts.append(
                (event_round_number, attacker_team, attacker, victim, tick)
            )

    begin_by_player: dict[str, dict[int, int]] = {}
    if (
        not begindefuse_df.empty
        and {"user_name", "tick", "total_rounds_played"}.issubset(begindefuse_df.columns)
    ):
        for player, tick, rounds_played in begindefuse_df[
            ["user_name", "tick", "total_rounds_played"]
        ].itertuples(index=False, name=None):
            player_name = str(player or "").strip()
            begin_tick = _int(tick)
            round_number = _int(rounds_played) + 1
            if player_name and begin_tick > 0 and round_number > 0:
                begin_by_player.setdefault(player_name, {}).setdefault(round_number, begin_tick)

    defuse_windows_by_player: dict[str, dict[int, tuple[int, int]]] = {}
    if not defused_df.empty and {"user_name", "tick"}.issubset(defused_df.columns):
        for player, tick in defused_df[["user_name", "tick"]].itertuples(
            index=False,
            name=None,
        ):
            player_name = str(player or "").strip()
            defuse_tick = _int(tick)
            player_begins = begin_by_player.get(player_name, {})
            player_windows = defuse_windows_by_player.setdefault(player_name, {})
            for round_number, begin_tick in player_begins.items():
                if 0 < begin_tick <= defuse_tick and round_number not in player_windows:
                    player_windows[round_number] = (begin_tick, defuse_tick)
                    break

    team_kills: dict[int, dict[Any, dict[str, int]]] = {}
    if not events.empty:
        required = {"attacker_name", "user_name", "total_rounds_played"}
        if required.issubset(events.columns):
            columns = ["attacker_name", "user_name", "total_rounds_played"]
            for optional_column in ("attackerteam", "userteam"):
                if optional_column in events.columns:
                    columns.append(optional_column)
            positions = {name: index for index, name in enumerate(columns)}
            for values in events[columns].itertuples(index=False, name=None):
                attacker = str(values[positions["attacker_name"]] or "").strip()
                victim = str(values[positions["user_name"]] or "").strip()
                if not attacker or attacker == victim:
                    continue
                attacker_team = values[positions["attackerteam"]] if "attackerteam" in positions else None
                victim_team = values[positions["userteam"]] if "userteam" in positions else None
                try:
                    if attacker_team is None or attacker_team == victim_team:
                        continue
                    hash(attacker_team)
                except Exception:
                    continue
                round_number = _int(values[positions["total_rounds_played"]]) + 1
                if round_number <= 0:
                    continue
                player_counts = team_kills.setdefault(round_number, {}).setdefault(
                    attacker_team,
                    {},
                )
                player_counts[attacker] = player_counts.get(attacker, 0) + 1

    for values_by_player in (equip_by_player, fire_by_player, hurt_by_attacker):
        for values in values_by_player.values():
            values.sort(key=lambda item: item[0])
    for by_round in round_hurt_by_victim.values():
        for values in by_round.values():
            values.sort()

    return SharedPlayerIndexes(
        equip_by_player={name: tuple(values) for name, values in equip_by_player.items()},
        fire_by_player={name: tuple(values) for name, values in fire_by_player.items()},
        hurt_by_attacker={name: tuple(values) for name, values in hurt_by_attacker.items()},
        defuse_windows_by_player=defuse_windows_by_player,
        round_hurt_by_victim={
            name: {round_number: tuple(values) for round_number, values in by_round.items()}
            for name, by_round in round_hurt_by_victim.items()
        },
        enemy_hurts=tuple(enemy_hurts),
        team_kills=team_kills,
    )


def _world_self_kill_cluster_c4_surrogate_keys(
    events: pd.DataFrame,
    match_start_tick: int,
) -> set[tuple[int, int]]:
    """C4 爆炸致死有时被记成 weapon=world 且 attacker==victim 多例，推断为包炸团灭。"""
    if events.empty or "tick" not in events.columns:
        return set()
    rows: list[tuple[int, int]] = []
    tcol = "tick"
    trc = "total_rounds_played" if "total_rounds_played" in events.columns else None
    if trc is None:
        return set()
    for _, row in events.iterrows():
        tick = _int(row.get(tcol))
        if match_start_tick > 0 and tick < match_start_tick:
            continue
        attacker = str(row.get("attacker_name", "") or "")
        victim = str(row.get("user_name", "") or "")
        if not attacker or attacker != victim:
            continue
        w = _normalize_item(row.get("weapon", ""))
        if w != "world":
            continue
        rnd = _int(row.get(trc)) + 1
        if rnd <= 0:
            continue
        rows.append((rnd, tick))
    if len(rows) < 2:
        return set()
    rows.sort(key=lambda x: (x[0], x[1]))
    gap = int(TICK_RATE * 4.0)
    out: set[tuple[int, int]] = set()
    i = 0
    n = len(rows)
    while i < n:
        rnd0, t0 = rows[i]
        cluster = [(rnd0, t0)]
        j = i + 1
        while j < n:
            rnd_j, t_j = rows[j]
            if rnd_j != rnd0:
                break
            if t_j - cluster[-1][1] > gap:
                break
            cluster.append((rnd_j, t_j))
            j += 1
        if len(cluster) >= 2:
            out.update(cluster)
        i = j
    return out


def _apply_c4_world_cluster_weapon_fixup(
    death_records: list[dict],
    surrogate_keys: set[tuple[int, int]],
) -> None:
    for d in death_records:
        key = (_int(d.get("round")), _int(d.get("tick")))
        if key not in surrogate_keys:
            continue
        if _normalize_item(d.get("weapon", "")) != "world":
            continue
        d["weapon"] = "planted_c4"


class DemoAnalyzer:
    """Parse a .dem file and extract highlight / fail clips for a target player."""

    def __init__(self, dem_path: str | Path):
        self.dem_path = Path(dem_path)
        self.parser = DemoParser(str(self.dem_path))

    def _detect_map(self) -> str:
        try:
            header = self.parser.parse_header()
            return header.get("map_name", "unknown")
        except Exception:
            return "unknown"

    def _build_match_summary(
        self,
        match_start_tick: int,
        *,
        death_events: Optional[pd.DataFrame] = None,
        round_end_df: Optional[pd.DataFrame] = None,
        header: Optional[dict] = None,
    ) -> tuple[int, int, str, int, str, str]:
        ta, tb, md, dm, _, tan, tbn = collect_match_summary_metrics(
            self.parser,
            self.dem_path,
            match_start_tick,
            death_events=death_events,
            round_end_df=round_end_df,
            header=header,
        )
        return ta, tb, md, dm, tan, tbn

    def _safe_parse_event(
        self, event_name: str, other: Optional[list[str]] = None,
    ) -> pd.DataFrame:
        try:
            if other:
                return _to_pandas_df(self.parser.parse_event(event_name, other=other))
            return _to_pandas_df(self.parser.parse_event(event_name))
        except Exception:
            return pd.DataFrame()

    def _parse_shared_events(self, match_start_tick: int) -> dict:
        """
        Parse all player-independent events once. Returns a dict with keys:
          events, fire_df, hurt_df, equip_df, pickup_df,
          planted_df, defused_df, bomb_exploded_df, begindefuse_df,
          nade_batch, re_df_cached
        All DataFrames are already warmup-filtered and name-stripped.
        """
        def _filter_ms(df: pd.DataFrame) -> pd.DataFrame:
            if df is None or df.empty or "tick" not in df.columns:
                return df
            if match_start_tick <= 0:
                return df
            return df.loc[
                pd.to_numeric(df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
            ].copy()

        _NAME_COLS = (
            "attacker_name", "user_name", "player_name", "assister_name",
            "defuser", "defuser_name",
        )

        # Bomb events batch
        _bomb_batch = safe_parse_events_batch(
            self.parser,
            ["bomb_planted", "bomb_defused", "bomb_exploded", "bomb_begindefuse"],
            other=["site", "total_rounds_played"],
            player=["steamid", "X", "Y", "Z", "last_place_name"],
        )
        planted_df    = _filter_ms(_bomb_batch["bomb_planted"])
        defused_df    = _filter_ms(_bomb_batch["bomb_defused"])
        bomb_exploded = _filter_ms(_bomb_batch["bomb_exploded"])
        begindefuse   = _filter_ms(_bomb_batch["bomb_begindefuse"])

        # Equipment batch
        _equip_batch = safe_parse_events_batch(
            self.parser,
            ["item_equip", "item_pickup"],
            player=["steamid", "name", "team_num"],
            other=["total_rounds_played"],
        )
        equip_df  = _filter_ms(_equip_batch["item_equip"])
        pickup_df = _filter_ms(_equip_batch["item_pickup"])

        # player_death (largest event) — player=["X","Y","Z"] 附带攻击者/受害者击杀瞬间坐标
        _death_other = list(dict.fromkeys(list(_EXTRA_EVENT_FIELDS) + list(_PLAYER_DEATH_GAME_KEYS)))
        events = _filter_ms(_to_pandas_df(self.parser.parse_event(
            "player_death", other=_death_other, player=["X", "Y", "Z", "user_id"],
        )))

        # weapon_fire + player_hurt — 合并为单次 demo 扫描
        _fire_hurt_batch = safe_parse_events_batch(
            self.parser,
            ["weapon_fire", "player_hurt"],
        )
        fire_df = _filter_ms(_fire_hurt_batch["weapon_fire"])
        hurt_df = _filter_ms(_fire_hurt_batch["player_hurt"])

        # Grenade batch
        nade_batch = safe_parse_events_batch(
            self.parser,
            [
                "hegrenade_detonate", "inferno_startburn", "molotov_detonate",
                "smokegrenade_detonate", "flashbang_detonate",
            ],
        )
        nade_batch = {k: _filter_ms(v) for k, v in nade_batch.items()}

        # round 边界事件合批（4 个事件一次 demo 扫描）
        _round_batch = safe_parse_events_batch(
            self.parser,
            ["round_end", "round_freeze_end", "round_start", "round_announce_match_start"],
            other=list(_EXTRA_EVENT_FIELDS) + ["winner", "reason"],
        )
        re_df           = _round_batch["round_end"]
        freeze_end_df   = _round_batch["round_freeze_end"]
        round_start_df  = _round_batch["round_start"]
        match_start_df  = _round_batch["round_announce_match_start"]

        # A failed batch parse is represented as empty frames. Empty critical
        # round data is not authoritative: retry the legacy single-event paths
        # so a transient/format-specific batch failure cannot erase scores,
        # round boundaries, or duration metadata.
        if not _round_end_frame_usable(re_df, match_start_tick):
            re_df = self._safe_parse_event(
                "round_end",
                other=list(_EXTRA_EVENT_FIELDS) + ["winner", "reason"],
            )
        if freeze_end_df.empty:
            freeze_end_df = self._safe_parse_event(
                "round_freeze_end",
                other=list(_EXTRA_EVENT_FIELDS),
            )
        if round_start_df.empty:
            round_start_df = self._safe_parse_event("round_start")
        if match_start_df.empty:
            match_start_df = self._safe_parse_event("round_announce_match_start")

        if match_start_tick > 0 and not re_df.empty and "tick" in re_df.columns:
            re_df = re_df.loc[
                pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
            ].copy()

        # player_blind — 单独解析以确保 blind_duration 字段可用（与其他事件混批时该字段会丢失）
        blind_df = _filter_ms(_to_pandas_df(
            self.parser.parse_event("player_blind", other=["blind_duration"])
        ))
        if not blind_df.empty and "user_name" in blind_df.columns:
            blind_df["user_name"] = blind_df["user_name"].astype(str).str.strip()

        # Round economy — reuse pre-parsed freeze_end + round_start from the batch above
        (
            economy_map_shared,
            round_freeze_end_ticks_shared,
            round_freeze_start_ticks_shared,
            tick_to_round_shared,
            economy_ticks_df,
        ) = build_round_economy_shared(
            self.parser,
            match_start_tick,
            freeze_end_df=freeze_end_df,
            round_start_df=round_start_df,
        )

        # 可靠的队伍身份（parse_player_info）+ 每回合阵营表：作为逐 tick team_num 失效
        # （部分国服 demo）时的兜底来源，用于队伍分组、胜负与比分。
        try:
            player_info_df = _to_pandas_df(self.parser.parse_player_info())
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            player_info_df = pd.DataFrame()
        steam_to_final_team_shared = build_steam_to_team_from_player_info(
            self.parser, player_info_df=player_info_df,
        )
        name_to_final_team_shared = build_name_to_team_from_player_info(
            self.parser, player_info_df=player_info_df,
        )
        group_side_by_round_shared = build_group_side_by_round(
            self.parser,
            round_freeze_end_ticks_shared,
            steam_to_final_team_shared,
            player_ticks_df=economy_ticks_df,
        )

        # Name strip on all relevant DataFrames
        for _df in (events, equip_df, fire_df, hurt_df, planted_df, defused_df, bomb_exploded, begindefuse):
            if _df is None or _df.empty:
                continue
            for _col in _NAME_COLS:
                if _col in _df.columns:
                    _df[_col] = _df[_col].astype(str).str.strip()

        # pickup_df user_name strip (needed separately)
        if not pickup_df.empty and "user_name" in pickup_df.columns:
            pickup_df["user_name"] = pickup_df["user_name"].astype(str).str.strip()

        # cs_win_panel_match — 比赛结算界面出现的 tick（全场一次；仅终局回合有意义）
        win_panel_match_tick = 0
        _wp_df = self._safe_parse_event("cs_win_panel_match")
        if _wp_df is not None and not _wp_df.empty and "tick" in _wp_df.columns:
            _wp_ticks = pd.to_numeric(_wp_df["tick"], errors="coerce").dropna().astype(int)
            if match_start_tick > 0:
                _wp_ticks = _wp_ticks[_wp_ticks > match_start_tick]
            if len(_wp_ticks) > 0:
                win_panel_match_tick = int(_wp_ticks.max())
        logger.info("[win_panel] cs_win_panel_match tick=%s", win_panel_match_tick)

        return {
            "events":                        events,
            "fire_df":                       fire_df,
            "hurt_df":                       hurt_df,
            "equip_df":                      equip_df,
            "pickup_df":                     pickup_df,
            "planted_df":                    planted_df,
            "defused_df":                    defused_df,
            "bomb_exploded_df":              bomb_exploded,
            "begindefuse_df":               begindefuse,
            "nade_batch":                    nade_batch,
            "re_df_cached":                  re_df,
            "win_panel_match_tick":          win_panel_match_tick,
            "blind_df":                      blind_df,
            "economy_map_shared":            economy_map_shared,
            "round_freeze_end_ticks_shared": round_freeze_end_ticks_shared,
            "round_freeze_start_ticks_shared": round_freeze_start_ticks_shared,
            "tick_to_round_shared":          tick_to_round_shared,
            "economy_ticks_df":              economy_ticks_df,
            "freeze_end_df":                 freeze_end_df,
            "round_start_df":                round_start_df,
            "match_start_df":                match_start_df,
            "steam_to_final_team_shared":    steam_to_final_team_shared,
            "name_to_final_team_shared":     name_to_final_team_shared,
            "group_side_by_round_shared":    group_side_by_round_shared,
            "player_info_df":                 player_info_df,
        }

    def _build_shared_demo_facts(
        self,
        *,
        match_start_tick: int,
        header: dict,
        shared_events: dict,
        expected_players: Optional[list[str]] = None,
    ) -> SharedDemoFacts:
        """Materialize native-parser and full-table facts once for all players."""
        events = shared_events["events"]
        re_df = shared_events["re_df_cached"]

        match_summary = self._build_match_summary(
            match_start_tick,
            death_events=events,
            round_end_df=re_df,
            header=header,
        )
        demo_max_tick = _max_demo_tick(
            self.parser,
            re_df,
            match_start_tick,
            death_df=events,
        )
        name_to_uid = build_player_name_to_user_id(
            self.parser,
            match_start_tick,
            death_events=events,
        )
        name_to_sid = build_player_name_to_steam_id(
            self.parser,
            match_start_tick,
            death_events=events,
        )
        roster_tick = (
            match_start_tick
            if match_start_tick > 0
            else max(
                1,
                _int(events["tick"].min())
                if events.shape[0] > 0 and "tick" in events.columns
                else 1,
            )
        )
        expected_roster_names = (
            set(expected_players or ())
            | set(name_to_uid)
            | set(name_to_sid)
            | set(shared_events.get("name_to_final_team_shared") or {})
        )
        roster_ticks_df = shared_events.get("economy_ticks_df")
        observed_user_ids = tuple(name_to_uid.values())
        spec_slots = build_player_name_to_spec_player_slot_dict(
            self.parser,
            roster_tick,
            self.dem_path,
            player_ticks_df=roster_ticks_df,
            expected_names=expected_roster_names,
        )
        all_players_roster = _build_all_players_roster(
            self.parser,
            match_start_tick,
            spec_slots,
            name_to_sid,
            name_to_team_pi=shared_events.get("name_to_final_team_shared") or {},
            player_ticks_df=roster_ticks_df,
            expected_names=expected_roster_names,
        )
        server_name = str(header.get("server_name") or "").strip()
        round_scores_by_round = build_round_scores(
            self.parser,
            match_start_tick,
            re_df=re_df,
        )

        victim_blind_index: dict[str, list[tuple[int, float]]] = {}
        blind_df = shared_events.get("blind_df")
        if blind_df is not None and not blind_df.empty:
            duration_col = next(
                (c for c in ("blind_duration", "duration") if c in blind_df.columns),
                None,
            )
            victim_col = "user_name" if "user_name" in blind_df.columns else None
            if duration_col and victim_col:
                for _, row in blind_df.iterrows():
                    name = str(row.get(victim_col) or "").strip()
                    tick = _int(row.get("tick"))
                    try:
                        duration = float(row.get(duration_col) or 0.0)
                    except (TypeError, ValueError):
                        duration = 0.0
                    if name and tick > 0:
                        victim_blind_index.setdefault(name, []).append((tick, duration))
                for name in victim_blind_index:
                    victim_blind_index[name].sort()

        grenade_detonate_points: list[tuple[int, float, float]] = []
        for grenade_df in shared_events["nade_batch"].values():
            if grenade_df.empty:
                continue
            xcol = "x" if "x" in grenade_df.columns else (
                "X" if "X" in grenade_df.columns else None
            )
            ycol = "y" if "y" in grenade_df.columns else (
                "Y" if "Y" in grenade_df.columns else None
            )
            if xcol is None or ycol is None:
                continue
            for _, row in grenade_df.iterrows():
                try:
                    grenade_detonate_points.append(
                        (_int(row.get("tick")), float(row.get(xcol)), float(row.get(ycol)))
                    )
                except (TypeError, ValueError):
                    pass
        grenade_detonate_points.sort()

        bomb_explode_tick_map: dict[int, int] = {}
        bomb_exploded_df = shared_events["bomb_exploded_df"]
        if (
            not bomb_exploded_df.empty
            and "tick" in bomb_exploded_df.columns
            and "total_rounds_played" in bomb_exploded_df.columns
        ):
            for _, row in bomb_exploded_df.iterrows():
                tick = _int(row.get("tick"))
                round_number = _int(row.get("total_rounds_played")) + 1
                if tick > 0 and round_number > 0 and round_number not in bomb_explode_tick_map:
                    bomb_explode_tick_map[round_number] = tick

        round_end_tick_map: dict[int, int] = {}
        if not re_df.empty and "tick" in re_df.columns:
            sequence = 0
            for _, row in re_df.sort_values("tick", kind="mergesort").iterrows():
                tick = _int(row.get("tick"))
                rounds_played = row.get("total_rounds_played")
                if rounds_played is not None and not (
                    isinstance(rounds_played, float) and pd.isna(rounds_played)
                ):
                    try:
                        round_number = int(float(rounds_played))
                    except (ValueError, TypeError):
                        sequence += 1
                        round_number = sequence
                else:
                    sequence += 1
                    round_number = sequence
                if tick > 0 and round_number > 0 and round_number not in round_end_tick_map:
                    round_end_tick_map[round_number] = tick

        timeline_positions: dict[str, list[int]] = {}
        assist_col = _pick_assister_column(events) if not events.empty else None
        for position, (_, row) in enumerate(events.iterrows()):
            attacker = str(row.get("attacker_name", "") or "").strip()
            victim = str(row.get("user_name", "") or "").strip()
            if not victim and "player_name" in row:
                victim = str(row.get("player_name", "") or "").strip()
            assister = ""
            if assist_col:
                raw_assister = row.get(assist_col, "")
                if not pd.isna(raw_assister):
                    assister = str(raw_assister).strip()
                    if assister.lower() in ("nan", "nat", "none"):
                        assister = ""
            for name in {attacker, victim, assister}:
                if name:
                    timeline_positions.setdefault(name, []).append(position)

        return SharedDemoFacts(
            match_summary=match_summary,
            demo_max_tick=demo_max_tick,
            name_to_uid=name_to_uid,
            observed_user_ids=observed_user_ids,
            spec_slots=spec_slots,
            name_to_sid=name_to_sid,
            all_players_roster=all_players_roster,
            server_name=server_name,
            round_scores_by_round=round_scores_by_round,
            victim_blind_index=victim_blind_index,
            grenade_detonate_points=grenade_detonate_points,
            bomb_explode_tick_map=bomb_explode_tick_map,
            round_end_tick_map=round_end_tick_map,
            timeline_event_positions_by_player={
                name: tuple(positions) for name, positions in timeline_positions.items()
            },
        )

    def analyze_multi_players(
        self,
        target_players: list[str],
        freeze_to_death_rounds: Optional[list[int]] = None,
    ) -> dict[str, ParseResult]:
        """
        Multi-player optimized analysis: parse events once, unify spatial ticks,
        call parse_ticks once. Returns {player_name: ParseResult}.
        ~10x fewer demo file scans vs calling analyze() per player.
        """
        if not target_players:
            return {}
        # Dedup + strip, preserve order
        seen: set[str] = set()
        players: list[str] = []
        for p in target_players:
            s = str(p or "").strip()
            if s and s not in seen:
                seen.add(s)
                players.append(s)
        if not players:
            return {}

        try:
            parsed_header = self.parser.parse_header()
            header = parsed_header if isinstance(parsed_header, dict) else {}
        except Exception:
            header = {}
        map_name = str(header.get("map_name") or "unknown")
        match_start_tick = _get_match_start_tick(self.parser)

        # Phase 1: Parse all shared events ONCE
        _shared = self._parse_shared_events(match_start_tick)
        shared_facts = self._build_shared_demo_facts(
            match_start_tick=match_start_tick,
            header=header,
            shared_events=_shared,
            expected_players=players,
        )

        # Phase 2: Per-player first pass (round economy + kill/death extraction, pure Python after events)
        aim_secs = _backstab_aim_sample_offsets_sec()
        all_spatial_ticks: set[int] = set()
        per_player_ctx: dict[str, dict] = {}

        # Build AWP indexes once — keyed by player name, shared across all players
        fire_df    = _shared["fire_df"]
        pickup_df  = _shared["pickup_df"]
        planted_df = _shared["planted_df"]
        defused_df = _shared["defused_df"]
        round_freeze_end_ticks_shared = _shared["round_freeze_end_ticks_shared"]

        shared_player_indexes = _build_shared_player_indexes(
            events=_shared["events"],
            fire_df=fire_df,
            hurt_df=_shared["hurt_df"],
            equip_df=_shared["equip_df"],
            begindefuse_df=_shared["begindefuse_df"],
            defused_df=defused_df,
            round_freeze_end_ticks=round_freeze_end_ticks_shared,
        )
        player_team_maps = extract_player_team_maps(
            _shared["economy_ticks_df"],
            _shared["tick_to_round_shared"],
            target_players=players,
        )

        _awp_fire_index: dict[str, list[int]] = {}
        if not fire_df.empty and "user_name" in fire_df.columns and "weapon" in fire_df.columns:
            for _, _fr in fire_df.iterrows():
                _fp = str(_fr.get("user_name", "")).strip()
                _fw = _normalize_item(str(_fr.get("weapon", "") or ""))
                if _fw == "awp":
                    _awp_fire_index.setdefault(_fp, []).append(_int(_fr["tick"]))

        _awp_pickup_index: dict[str, list[int]] = {}
        if not pickup_df.empty and "user_name" in pickup_df.columns and "item" in pickup_df.columns:
            for _, _pk in pickup_df.iterrows():
                _pp = str(_pk.get("user_name", "")).strip()
                _pi = _normalize_item(str(_pk.get("item", "") or ""))
                if _pi == "awp":
                    _awp_pickup_index.setdefault(_pp, []).append(_int(_pk["tick"]))

        # C4 world cluster keys — invariant across players
        events = _shared["events"]
        c4_world_cluster_keys = _world_self_kill_cluster_c4_surrogate_keys(events, match_start_tick)

        # ── 单遍预处理：按 attacker/victim 分桶，O(D) 替代 O(P×D) iterrows ──
        _bucket_kills: dict[str, list[dict]] = {}
        _bucket_deaths: dict[str, list[dict]] = {}
        _first_death_tick_shared: dict[int, int] = {}

        def _safe_coord_bucket(v) -> "Optional[float]":
            import math as _m
            try:
                f = float(v)
                return None if _m.isnan(f) else f
            except (TypeError, ValueError):
                return None

        for _, _brow in events.iterrows():
            _rn   = _int(_brow.get("total_rounds_played")) + 1
            _atk  = str(_brow.get("attacker_name", "") or "").strip()
            _vic  = str(_brow.get("user_name", "") or "").strip()
            _wpn  = _normalize_item(_brow.get("weapon", ""))
            _tick = _int(_brow.get("tick"))

            if _atk and _atk != _vic and _rn not in _first_death_tick_shared:
                _first_death_tick_shared[_rn] = _tick

            _evt: dict = {
                "round": _rn, "tick": _tick, "weapon": _wpn,
                "attacker": _atk, "victim": _vic,
                "headshot":        _bool(_brow.get("headshot")),
                "noscope":         _bool(_brow.get("noscope")),
                "penetrated":      _int(_brow.get("penetrated")),
                "thrusmoke":       _bool(_brow.get("thrusmoke")),
                "attackerblind":   _bool(_brow.get("attackerblind")),
                "assistedflash":   _bool(_brow.get("assistedflash")),
                "attacker_in_air": (_bool(_brow.get("attackerinair")) or
                                    _bool(_brow.get("attacker_in_air"))),
                "victim_in_air":   _bool(_brow.get("inair")),
                "penetrated_objs": _int(_brow.get("penetrated_objects")),
                "attacker_team":   _brow.get("attackerteam"),
                "victim_team":     _brow.get("userteam"),
                "attacker_steamid": str(_brow.get("attacker_steamid") or ""),
                "user_steamid":    str(_brow.get("user_steamid") or ""),
                "assister_name":   str(_brow.get("assister_name") or "").strip(),
                "atk_x": _safe_coord_bucket(_brow.get("attacker_X")),
                "atk_y": _safe_coord_bucket(_brow.get("attacker_Y")),
                "atk_z": _safe_coord_bucket(_brow.get("attacker_Z")),
                "vic_x": _safe_coord_bucket(_brow.get("user_X")),
                "vic_y": _safe_coord_bucket(_brow.get("user_Y")),
                "vic_z": _safe_coord_bucket(_brow.get("user_Z")),
            }
            if _atk and _atk != _vic:
                _bucket_kills.setdefault(_atk, []).append(_evt)
            if _vic:
                _bucket_deaths.setdefault(_vic, []).append(_evt)

        for target_player in players:
            round_economy_map      = _shared["economy_map_shared"]
            round_freeze_end_ticks = round_freeze_end_ticks_shared
            round_freeze_start_ticks = _shared["round_freeze_start_ticks_shared"]
            round_target_team_map = player_team_maps.get(target_player.lower(), {})
            # extract_target_team_map 依赖逐 tick team_num；坏数据 demo 上会近乎为空。
            # 覆盖率不足时改用 parse_player_info + 每回合阵营表重建目标逐回合阵营。
            _grp_side = _shared.get("group_side_by_round_shared") or {}
            _expected_rounds = len(_shared.get("round_freeze_end_ticks_shared") or {})
            if _grp_side and len(round_target_team_map) < max(1, _expected_rounds // 2):
                _tfinal = (_shared.get("name_to_final_team_shared") or {}).get(
                    target_player.strip().lower()
                )
                _rebuilt = round_target_team_map_from_groups(_grp_side, _tfinal)
                if _rebuilt:
                    round_target_team_map = _rebuilt

            round_team_score_map = build_round_scores_team_based(
                self.parser, round_target_team_map, match_start_tick,
                re_df=_shared["re_df_cached"],
            )
            round_result_map: dict[int, bool] = {}
            for rnd, (own_before, opp_before) in round_team_score_map.items():
                after = round_team_score_map.get(rnd + 1)
                if after is not None:
                    own_after, opp_after = after
                    if own_after > own_before:
                        round_result_map[rnd] = True
                    elif opp_after > opp_before:
                        round_result_map[rnd] = False

            _fire_index_full = shared_player_indexes.fire_by_player.get(target_player, ())

            teammate_kills_per_round: dict[int, int] = {}
            for round_number, team_counts in shared_player_indexes.team_kills.items():
                target_team = round_target_team_map.get(round_number)
                if target_team is None:
                    continue
                player_counts = team_counts.get(target_team, {})
                teammate_kills = sum(player_counts.values()) - player_counts.get(target_player, 0)
                if teammate_kills > 0:
                    teammate_kills_per_round[round_number] = teammate_kills

            teammate_hurt_victim_index: dict[str, list[int]] = {}
            for round_number, attacker_team, attacker, victim, hurt_tick in shared_player_indexes.enemy_hurts:
                if attacker == target_player:
                    continue
                target_team = round_target_team_map.get(round_number)
                if (
                    attacker_team is not None
                    and target_team is not None
                    and attacker_team != target_team
                ):
                    continue
                teammate_hurt_victim_index.setdefault(victim, []).append(hurt_tick)
            for victim_ticks in teammate_hurt_victim_index.values():
                victim_ticks.sort()

            # ── 从预算好的桶直接消费 ──
            round_kills: dict[int, list[dict]] = {}
            death_records: list[dict] = []
            target_total_kills = 0
            round_first_death_tick: dict[int, int] = dict(_first_death_tick_shared)

            for _evt in _bucket_kills.get(target_player, []):
                target_total_kills += 1
                per_kill_tags = detect_kill_action_tags(
                    weapon=_evt["weapon"], headshot=_evt["headshot"],
                    noscope=_evt["noscope"], penetrated=_evt["penetrated"],
                    thrusmoke=_evt["thrusmoke"], attackerblind=_evt["attackerblind"],
                    assistedflash=_evt["assistedflash"],
                    attacker_in_air=_evt["attacker_in_air"],
                    penetrated_objects=_evt["penetrated_objs"],
                )
                _rnd_lo = round_freeze_end_ticks.get(_evt["round"], 0)
                _awp_lo = max(_rnd_lo, _evt["tick"] - int(TICK_RATE * 5.0))
                _vic_str = _evt["victim"]
                shots_to_kill = count_shots_before(
                    _fire_index_full, _evt["tick"], _evt["weapon"],
                    window_ticks=int(TICK_RATE * 2.0),
                )
                _vic_fired  = any(_awp_lo <= _t <= _evt["tick"]
                                  for _t in _awp_fire_index.get(_vic_str, []))
                _vic_picked = any(_awp_lo <= _t <= _evt["tick"]
                                  for _t in _awp_pickup_index.get(_vic_str, []))
                round_kills.setdefault(_evt["round"], []).append({
                    "weapon": _evt["weapon"], "tick": _evt["tick"],
                    "headshot": _evt["headshot"], "noscope": _evt["noscope"],
                    "tags": per_kill_tags, "victim": _evt["victim"],
                    "victim_steamid": _evt["user_steamid"],
                    "thrusmoke": _evt["thrusmoke"], "penetrated": _evt["penetrated"],
                    "shots_to_kill": shots_to_kill,
                    "victim_had_awp": _vic_fired or _vic_picked,
                    "assistedflash": _evt["assistedflash"],
                    "flash_assister": _evt["assister_name"] if _evt["assistedflash"] else "",
                    "attacker_in_air": _evt["attacker_in_air"],
                    "penetrated_objects": _evt["penetrated_objs"],
                    "atk_x": _evt["atk_x"], "atk_y": _evt["atk_y"], "atk_z": _evt["atk_z"],
                    "vic_x": _evt["vic_x"], "vic_y": _evt["vic_y"], "vic_z": _evt["vic_z"],
                })

            for _evt in _bucket_deaths.get(target_player, []):
                death_records.append({
                    "round": _evt["round"], "tick": _evt["tick"],
                    "weapon": _evt["weapon"], "headshot": _evt["headshot"],
                    "attacker": _evt["attacker"],
                    "attacker_steamid": _evt["attacker_steamid"],
                    "attacker_team": _evt["attacker_team"],
                    "victim_team":   _evt["victim_team"],
                    "attackerblind": _evt["attackerblind"],
                    "assistedflash": _evt["assistedflash"],
                    "victim_in_air": _evt["victim_in_air"],
                })

            # C4 world cluster fixup（保持不变）
            _apply_c4_world_cluster_weapon_fixup(death_records, c4_world_cluster_keys)

            # Bomb round correction
            for _rn, _kills in list(round_kills.items()):
                if _rn <= 1 or _rn not in round_freeze_end_ticks:
                    continue
                _freeze_tick = _int(round_freeze_end_ticks.get(_rn))
                if _freeze_tick <= 0:
                    continue
                _kept: list[dict] = []
                for _k in _kills:
                    if _int(_k.get("tick")) < _freeze_tick:
                        round_kills.setdefault(_rn - 1, []).append(_k)
                    else:
                        _kept.append(_k)
                if _kept:
                    round_kills[_rn] = _kept
                else:
                    round_kills.pop(_rn, None)

            round_target_kill_ticks: dict[int, list[int]] = {
                rn: sorted({_int(k["tick"]) for k in ks})
                for rn, ks in round_kills.items()
            }

            # Collect spatial ticks needed for this player
            hs_ticks = [d["tick"] for d in death_records if d["headshot"]]
            backstab_ticks = [
                max(0, _int(d["tick"]) - int(TICK_RATE * float(sec)))
                for d in death_records for sec in aim_secs
            ]
            highlight_ticks = [
                _int(k["tick"])
                for kills in round_kills.values() for k in kills
            ]
            bomb_def_ticks = collect_target_defuse_ticks_for_spatial(
                planted_df, defused_df, target_player, match_start_tick,
            )
            flying_ticks: list[int] = []
            quickscope_ticks: list[int] = []
            for kills in round_kills.values():
                for k in kills:
                    w = str(k.get("weapon") or "")
                    if w not in SNIPER_WEAPONS:
                        continue
                    kt = _int(k.get("tick"))
                    # 甩狙需要 kt-24 / kt-32（jump_sample_ticks 只到 kt-16）
                    quickscope_ticks.extend([max(0, kt - off) for off in (24, 32)])
                    if not (_bool(k.get("noscope")) or "盲狙" in (k.get("tags") or [])):
                        continue
                    flying_ticks.extend([kt, max(0, kt - _FLYING_SNIPER_LOOKBACK_TICKS)])
            jump_sample_ticks = [
                max(0, _int(k["tick"]) - off)
                for kills in round_kills.values()
                for k in kills
                for off in (2, 8, 16, 64, 128)
            ]
            fail_lookback_ticks = [
                max(0, d["tick"] - off)
                for d in death_records if d["headshot"]
                for off in (_ZOMBIE_STEP_PRE_TICKS, _STROLL_PRE_TICKS)
            ]
            shoulder_ticks: list[int] = []
            if round_freeze_end_ticks:
                _sh_start = min(round_freeze_end_ticks.values())
                _sh_end   = max(round_freeze_end_ticks.values()) + int(150 * TICK_RATE)
                shoulder_ticks = list(range(_sh_start, _sh_end, _SHOULDER_SAMPLE_INTERVAL))

            all_spatial_ticks.update(
                hs_ticks + backstab_ticks + highlight_ticks + bomb_def_ticks
                + flying_ticks + quickscope_ticks + jump_sample_ticks
                + fail_lookback_ticks + shoulder_ticks
            )

            per_player_ctx[target_player] = {
                "round_economy_map":        round_economy_map,
                "round_target_team_map":    round_target_team_map,
                "round_freeze_end_ticks":   round_freeze_end_ticks,
                "round_freeze_start_ticks": round_freeze_start_ticks,
                "round_team_score_map":     round_team_score_map,
                "round_result_map":         round_result_map,
                "round_kills":              round_kills,
                "death_records":            death_records,
                "round_first_death_tick":   round_first_death_tick,
                "round_target_kill_ticks":  round_target_kill_ticks,
                "target_total_kills":       target_total_kills,
                "equip_timeline": shared_player_indexes.equip_by_player.get(target_player, ()),
                "fire_index": _fire_index_full,
                "hurt_index": shared_player_indexes.hurt_by_attacker.get(target_player, ()),
                "defuse_window_map": shared_player_indexes.defuse_windows_by_player.get(target_player, {}),
                "round_hurt_on_target_index": shared_player_indexes.round_hurt_by_victim.get(target_player, {}),
                "teammate_hurt_victim_index": teammate_hurt_victim_index,
                "teammate_kills_per_round": teammate_kills_per_round,
            }

        # Phase 3: Parse spatial ticks ONCE (union of all players)
        spatial_cache, alive_summary = parse_spatial_snapshots(self.parser, sorted(all_spatial_ticks))

        # Phase 4: Per-player second pass using shared spatial cache
        results: dict[str, ParseResult] = {}
        for target_player in players:
            ctx = per_player_ctx[target_player]
            results[target_player] = self._finish_single_player_analysis(
                target_player=target_player,
                map_name=map_name,
                match_start_tick=match_start_tick,
                round_economy_map=ctx["round_economy_map"],
                round_target_team_map=ctx["round_target_team_map"],
                round_freeze_end_ticks=ctx["round_freeze_end_ticks"],
                round_freeze_start_ticks=ctx["round_freeze_start_ticks"],
                round_team_score_map=ctx["round_team_score_map"],
                round_result_map=ctx["round_result_map"],
                round_kills=ctx["round_kills"],
                death_records=ctx["death_records"],
                round_first_death_tick=ctx["round_first_death_tick"],
                round_target_kill_ticks=ctx["round_target_kill_ticks"],
                target_total_kills=ctx["target_total_kills"],
                equip_timeline=ctx["equip_timeline"],
                fire_index=ctx["fire_index"],
                hurt_index=ctx["hurt_index"],
                defuse_window_map=ctx["defuse_window_map"],
                round_hurt_on_target_index=ctx["round_hurt_on_target_index"],
                teammate_hurt_victim_index=ctx["teammate_hurt_victim_index"],
                teammate_kills_per_round=ctx["teammate_kills_per_round"],
                spatial_cache=spatial_cache,
                alive_summary=alive_summary,
                events=_shared["events"],
                fire_df=_shared["fire_df"],
                hurt_df=_shared["hurt_df"],
                equip_df=_shared["equip_df"],
                planted_df=_shared["planted_df"],
                defused_df=_shared["defused_df"],
                bomb_exploded_df=_shared["bomb_exploded_df"],
                nade_batch=_shared["nade_batch"],
                re_df_cached=_shared["re_df_cached"],
                win_panel_match_tick=_shared["win_panel_match_tick"],
                blind_df=_shared["blind_df"],
                shared_facts=shared_facts,
                freeze_to_death_rounds=freeze_to_death_rounds,
            )

        return results

    def _finish_single_player_analysis(
        self,
        *,
        target_player: str,
        map_name: str,
        match_start_tick: int,
        round_economy_map: dict,
        round_target_team_map: dict,
        round_freeze_end_ticks: dict,
        round_freeze_start_ticks: dict,
        round_team_score_map: dict,
        round_result_map: dict,
        round_kills: dict,
        death_records: list,
        round_first_death_tick: dict,
        round_target_kill_ticks: dict,
        target_total_kills: int,
        equip_timeline: tuple[tuple[int, str], ...],
        fire_index: tuple[tuple[int, str], ...],
        hurt_index: tuple[tuple[int, str, int], ...],
        defuse_window_map: dict[int, tuple[int, int]],
        round_hurt_on_target_index: dict[int, tuple[tuple[int, int, str], ...]],
        teammate_hurt_victim_index: dict[str, list[int]],
        teammate_kills_per_round: dict[int, int],
        spatial_cache: dict,
        alive_summary: "Optional[dict[int, dict[int, frozenset]]]" = None,
        events: "pd.DataFrame",
        fire_df: "pd.DataFrame",
        hurt_df: "pd.DataFrame",
        equip_df: "pd.DataFrame",
        planted_df: "pd.DataFrame",
        defused_df: "pd.DataFrame",
        bomb_exploded_df: "pd.DataFrame",
        nade_batch: dict,
        re_df_cached: "pd.DataFrame",
        win_panel_match_tick: int = 0,
        blind_df: "Optional[pd.DataFrame]" = None,
        shared_facts: SharedDemoFacts,
        freeze_to_death_rounds: "Optional[list[int]]" = None,
    ) -> "ParseResult":
        bomb_highlights = analyze_bomb_defuse_highlights(
            planted_df, defused_df, target_player, match_start_tick, spatial_cache,
            round_freeze_end_ticks,
        )

        enrich_kill_action_tags_spatial(round_kills, spatial_cache, target_player)

        # 好闪配好人质量门控：从 blind_df 查受害者盲化时长，< 阈值则移除 tag
        _victim_blind_index = shared_facts.victim_blind_index

        _FLASH_WINDOW_TICKS = int(TICK_RATE * 3.0)
        for _kills in round_kills.values():
            for _k in _kills:
                if not _k.get("assistedflash") or "🤝 好闪配好人" not in _k.get("tags", []):
                    continue
                _vic = str(_k.get("victim") or "").strip()
                _kt = _int(_k.get("tick"))
                _arr = _victim_blind_index.get(_vic, [])
                if not _arr:
                    continue
                _ticks = [t for t, _ in _arr]
                _lo = bisect_left(_ticks, _kt - _FLASH_WINDOW_TICKS)
                _hi = bisect_right(_ticks, _kt)
                _best_dur = max(
                    (_arr[i][1] for i in range(_lo, _hi)),
                    default=0.0,
                )
                if _best_dur < _FLASH_GOOD_DUR_SEC:
                    _k["tags"] = [t for t in _k["tags"] if t != "🤝 好闪配好人"]

        # ── 额外辅助事件 ──

        # player_blind — use pre-parsed shared DataFrame (already warmup-filtered, user_name stripped)
        flash_on_target_index = list(_victim_blind_index.get(target_player, ()))

        grenade_detonate_points = shared_facts.grenade_detonate_points

        bomb_explode_tick_map = shared_facts.bomb_explode_tick_map

        round_end_tick_map = shared_facts.round_end_tick_map

        # 回合末刀杀分离
        _transition_knife_highlight_kills: list[dict] = []
        for _rn, _kills in list(round_kills.items()):
            _round_end_tick = _int(round_end_tick_map.get(_rn))
            if _round_end_tick <= 0:
                continue
            _has_prior_valid_kill = any(_int(_k.get("tick")) < _round_end_tick for _k in _kills)
            _kept_kills: list[dict] = []
            for _k in _kills:
                _kt = _int(_k.get("tick"))
                _weapon = str(_k.get("weapon") or "")
                _is_end_tick_transition_knife = (
                    _kt == _round_end_tick
                    and _has_prior_valid_kill
                    and _is_knife_highlight_weapon(_weapon)
                )
                if _is_end_tick_transition_knife:
                    _knife_k = dict(_k)
                    _knife_k["_round"] = _rn
                    _transition_knife_highlight_kills.append(_knife_k)
                    continue
                _kept_kills.append(_k)
            if _kept_kills:
                round_kills[_rn] = _kept_kills
            else:
                round_kills.pop(_rn, None)
        if _transition_knife_highlight_kills:
            logger.info(
                "Detached round-end knife kills from multi-kill aggregation target=%r kills=%s",
                target_player,
                [(_int(k.get("_round")), _int(k.get("tick")), str(k.get("victim") or ""), str(k.get("weapon") or "")) for k in _transition_knife_highlight_kills],
            )
        if _transition_knife_highlight_kills:
            round_target_kill_ticks = {
                rn: sorted({_int(k["tick"]) for k in ks})
                for rn, ks in round_kills.items()
            }

        # prev_round_killers_of_target
        prev_round_killers_of_target: dict[int, set[str]] = {}
        round_death_tick_map: dict[int, int] = {}
        for _dr in death_records:
            _rn = _int(_dr.get("round"))
            _atk = str(_dr.get("attacker") or "").strip()
            _dt = _int(_dr.get("tick"))
            if _rn > 0 and _atk and _atk != target_player:
                prev_round_killers_of_target.setdefault(_rn, set()).add(_atk)
            if _rn > 0 and _dt > 0:
                round_death_tick_map[_rn] = _dt

        # ── 构建下饭片段 ──
        fail_clips, fail_death_keys = build_fail_clips(
            target_player, death_records, equip_df, fire_df, hurt_df,
            spatial_cache, round_target_kill_ticks, round_team_score_map,
            round_result_map, round_freeze_end_ticks,
            map_name=map_name, grenade_detonate_points=grenade_detonate_points,
            precomputed_equip_timeline=equip_timeline,
            precomputed_fire_index=fire_index,
            precomputed_hurt_index=hurt_index,
        )
        target_total_deaths = len(death_records)

        # ── 高光片段 ──
        highlight_clips: list[Clip] = []
        for rnd, kills in round_kills.items():
            if len(kills) < 2:
                continue
            kills_sorted = sorted(kills, key=lambda k: k["tick"])
            first_tick = kills_sorted[0]["tick"]
            last_tick = kills_sorted[-1]["tick"]
            tags = build_highlight_tags(
                kills_sorted, first_tick, last_tick, rnd,
                round_first_death_tick, spatial_cache, target_player,
                round_economy_map, round_target_team_map.get(rnd),
                round_team_score_map.get(rnd),
                round_won=round_result_map.get(rnd),
                round_end_tick_map=round_end_tick_map,
                bomb_explode_tick_map=bomb_explode_tick_map,
                prev_round_killers_of_target=prev_round_killers_of_target,
                teammate_hurt_victim_index=teammate_hurt_victim_index,
                teammate_kills_per_round=teammate_kills_per_round,
                round_hurt_on_target_index=round_hurt_on_target_index,
                round_death_tick_map=round_death_tick_map,
                defuse_window_map=defuse_window_map,
                alive_summary=alive_summary,
            )

            if round_result_map.get(rnd) is False:
                _WIN_ONLY_TAGS = frozenset({
                    "💸 ECO翻盘", "🛡️ 赛点救世主", "命悬一线",
                    "📈 绝地追分", "拒绝下班", "🗡️ 赛点终结者", "一锤定音",
                    "⚔️ 加时生死战", "大心脏", "🔥 3v5 绝地反击",
                })
                _WIN_ONLY_PREFIXES = ("🔥 1v", "🔥 2v")
                tags = [
                    t for t in tags
                    if t not in _WIN_ONLY_TAGS
                    and not any(t.startswith(p) for p in _WIN_ONLY_PREFIXES)
                ]

            if len(kills_sorted) == 2:
                boring_tags = {
                    "双杀", "爆头", "枪枪爆头", "⚔️ 破局首杀",
                    "🔥 顺风局战神", "无情碾压",
                }
                if all(t in boring_tags for t in tags):
                    continue

            victims_list = [str(k.get("victim") or "") for k in kills_sorted]
            victim_steamids_list = [str(k.get("victim_steamid") or "") for k in kills_sorted]
            kill_ticks_sorted = [_int(k["tick"]) for k in kills_sorted]
            flash_assisters_list = list(dict.fromkeys(
                k["flash_assister"] for k in kills_sorted
                if k.get("assistedflash") and k.get("flash_assister")
            ))
            so, se = round_start_scores_for_target(rnd, round_team_score_map)

            _rnd_death_tick = round_death_tick_map.get(rnd)
            _clip_end_tick = last_tick + BUFFER_SECONDS_AFTER * TICK_RATE
            _NICE_TRY_TAGS_SET = frozenset({
                "😤 1v2 饮恨", "💸 ECO反击", "🛡️ 赛点失守",
                "📉 绝地追分未果", "⛰️ 天王山饮恨",
            })
            _has_nice_try = any(t in _NICE_TRY_TAGS_SET or t.startswith("💀 1v") for t in tags)
            if (_rnd_death_tick is not None
                    and _rnd_death_tick > last_tick
                    and round_result_map.get(rnd) is False
                    and _has_nice_try):
                _clip_end_tick = max(_clip_end_tick, _rnd_death_tick + int(3.0 * TICK_RATE))

            highlight_clips.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                map_name=map_name,
                round=rnd,
                category="highlight",
                weapon_used=_highlight_weapon_used_label(kills_sorted),
                kill_count=len(kills_sorted),
                start_tick=max(0, first_tick - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=_clip_end_tick,
                context_tags=_dedup_context_tags(tags),
                victims=victims_list,
                victim_steamid64s=victim_steamids_list,
                kill_ticks=kill_ticks_sorted,
                score_own=so,
                score_opp=se,
                round_won=round_result_map.get(rnd),
                clip_min_tick=round_freeze_end_ticks.get(rnd),
                death_tick=_rnd_death_tick,
                flash_assisters=flash_assisters_list,
            ))

        # 刀杀单杀
        for rnd, kills in round_kills.items():
            if len(kills) >= 2:
                continue
            for k in kills:
                if not _is_knife_highlight_weapon(str(k.get("weapon") or "")):
                    continue
                kt = _int(k.get("tick"))
                vic = str(k.get("victim") or "")
                wpn = str(k.get("weapon") or "")
                so, se = round_start_scores_for_target(rnd, round_team_score_map)
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    map_name=map_name, round=rnd, category="highlight",
                    weapon_used=_translate_weapon(wpn), kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                    context_tags=["🔪 刀杀"], victims=[vic] if vic else [],
                    kill_ticks=[kt], score_own=so, score_opp=se,
                    round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd),
                ))
        for k in _transition_knife_highlight_kills:
            rnd = _int(k.get("_round"))
            if rnd <= 0:
                continue
            kt = _int(k.get("tick"))
            vic = str(k.get("victim") or "")
            wpn = str(k.get("weapon") or "")
            so, se = round_start_scores_for_target(rnd, round_team_score_map)
            highlight_clips.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                map_name=map_name, round=rnd, category="highlight",
                weapon_used=_translate_weapon(wpn), kill_count=1,
                start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                context_tags=["🔪 刀杀"], victims=[vic] if vic else [],
                kill_ticks=[kt], score_own=so, score_opp=se,
                round_won=round_result_map.get(rnd),
                clip_min_tick=round_freeze_end_ticks.get(rnd),
            ))

        # 跳杀单杀
        _single_clip_rounds = {c.round for c in highlight_clips}
        for rnd, kills in round_kills.items():
            if len(kills) >= 2 or rnd in _single_clip_rounds:
                continue
            for k in kills:
                kt = _int(k.get("tick"))
                if not is_jump_kill(spatial_cache, kt, target_player):
                    continue
                wpn = str(k.get("weapon") or "")
                vic = str(k.get("victim") or "")
                _jump_ctx: list[str] = ["🪂 跳杀"]
                for _t in k.get("tags", []):
                    if _t != "爆头" and _t not in _jump_ctx:
                        _jump_ctx.append(_t)
                if k.get("headshot"):
                    _jump_ctx.append("爆头")
                _jk_w = str(k.get("weapon") or "").strip()
                _jk_shots = _int(k.get("shots_to_kill"), 0)
                if (_bool(k.get("headshot")) and _jk_w in _KEQIAO_WEAPONS
                        and (_jk_shots == 1 or (_jk_shots == 0 and _jk_w in DEAGLE_VARIANTS))):
                    _jump_ctx.append("💥 颗秒")
                    if _bool(k.get("victim_had_awp")) and _victim_facing_attacker(
                        spatial_cache.get(kt), target_player, vic,
                    ):
                        _jump_ctx.append("🔪 手撕大狙")
                so, se = round_start_scores_for_target(rnd, round_team_score_map)
                _rnd_dt = round_death_tick_map.get(rnd)
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    map_name=map_name, round=rnd, category="highlight",
                    weapon_used=_translate_weapon(wpn), kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                    context_tags=_dedup_context_tags(_jump_ctx),
                    victims=[vic] if vic else [], kill_ticks=[kt],
                    score_own=so, score_opp=se, round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd), death_tick=_rnd_dt,
                ))
                break

        # 颗秒单杀
        _keqiao_covered = {c.round for c in highlight_clips}
        for rnd, kills in round_kills.items():
            if len(kills) >= 2 or rnd in _keqiao_covered:
                continue
            for k in kills:
                _kq_w = str(k.get("weapon") or "").strip()
                _kq_hs = _bool(k.get("headshot"))
                _kq_shots = _int(k.get("shots_to_kill"), 0)
                if not _kq_hs or _kq_w not in _KEQIAO_WEAPONS:
                    continue
                _kq_one_tap = (_kq_shots == 1) or (_kq_shots == 0 and _kq_w in DEAGLE_VARIANTS)
                if not _kq_one_tap:
                    continue
                kt = _int(k.get("tick"))
                vic = str(k.get("victim") or "")
                _kq_ctx: list[str] = ["💥 颗秒", "爆头"]
                if _bool(k.get("victim_had_awp")) and _victim_facing_attacker(
                    spatial_cache.get(kt), target_player, vic,
                ):
                    _kq_ctx.append("🔪 手撕大狙")
                for _t in k.get("tags", []):
                    if _t not in _kq_ctx:
                        _kq_ctx.append(_t)
                so, se = round_start_scores_for_target(rnd, round_team_score_map)
                _rnd_dt = round_death_tick_map.get(rnd)
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    map_name=map_name, round=rnd, category="highlight",
                    weapon_used=_translate_weapon(_kq_w), kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                    context_tags=_dedup_context_tags(_kq_ctx),
                    victims=[vic] if vic else [], kill_ticks=[kt],
                    score_own=so, score_opp=se, round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd), death_tick=_rnd_dt,
                ))
                break

        # 🐂 1v1 斗牛单杀：该回合目标仅 1 杀，但亲手赢下 1v1 残局
        _duel_covered = {c.round for c in highlight_clips}
        for rnd, kills in round_kills.items():
            if len(kills) >= 2 or rnd in _duel_covered:
                continue
            if round_result_map.get(rnd) is not True:
                continue
            for k in kills:
                kt = _int(k.get("tick"))
                sk = _spatial_snap_pre_kill(spatial_cache, kt)
                if sk is None:
                    continue
                _as = alive_summary or {}
                _alive_by_team = (
                    _as.get(kt - 8) or _as.get(kt - 16)
                    or _as.get(kt - 24) or _as.get(kt - 32) or _as.get(kt)
                )
                pair = _alive_mates_and_enemies(sk, target_player, alive_by_team=_alive_by_team)
                if pair is None:
                    continue
                n_mates, n_enems = pair
                if (n_mates + 1) != 1 or n_enems != 1:
                    continue
                vic = str(k.get("victim") or "")
                wpn = str(k.get("weapon") or "")
                so, se = round_start_scores_for_target(rnd, round_team_score_map)
                _rnd_dt = round_death_tick_map.get(rnd)
                highlight_clips.append(Clip(
                    clip_id=f"c_{uuid.uuid4().hex[:8]}",
                    map_name=map_name, round=rnd, category="highlight",
                    weapon_used=_translate_weapon(wpn), kill_count=1,
                    start_tick=max(0, kt - BUFFER_SECONDS_BEFORE * TICK_RATE),
                    end_tick=kt + BUFFER_SECONDS_AFTER * TICK_RATE,
                    context_tags=["🐂 1v1 斗牛"],
                    victims=[vic] if vic else [], kill_ticks=[kt],
                    score_own=so, score_opp=se, round_won=round_result_map.get(rnd),
                    clip_min_tick=round_freeze_end_ticks.get(rnd), death_tick=_rnd_dt,
                ))
                break

        rounds_with_kill_highlight = {c.round for c in highlight_clips}
        bomb_round_defuse_ticks: dict[int, int] = {bh["round"]: bh["defuse_tick"] for bh in bomb_highlights}
        merged_highlights: list[Clip] = []
        for c in highlight_clips:
            extra_tags: list[str] = []
            defuse_tick = bomb_round_defuse_ticks.get(c.round)
            new_start = c.start_tick
            new_end = c.end_tick
            for bh in bomb_highlights:
                if bh["round"] == c.round:
                    extra_tags.extend(bh["tags"])
                    if defuse_tick is None or bh["defuse_tick"] < defuse_tick:
                        defuse_tick = bh["defuse_tick"]
            if extra_tags:
                if defuse_tick is not None:
                    new_start = min(c.start_tick, defuse_tick - BUFFER_SECONDS_BEFORE * TICK_RATE)
                    new_end = max(c.end_tick, defuse_tick + BUFFER_SECONDS_AFTER * TICK_RATE)
                merged_highlights.append(replace(
                    c, start_tick=new_start, end_tick=new_end,
                    context_tags=_dedup_context_tags(_extend_tags_unique(c.context_tags, extra_tags)),
                ))
            else:
                merged_highlights.append(c)
        for bh in bomb_highlights:
            if bh["round"] in rounds_with_kill_highlight:
                continue
            so, se = round_start_scores_for_target(bh["round"], round_team_score_map)
            merged_highlights.append(Clip(
                clip_id=f"c_{uuid.uuid4().hex[:8]}",
                map_name=map_name, round=bh["round"], category="highlight",
                weapon_used=_translate_weapon("defuse_kit"), kill_count=0,
                start_tick=max(0, bh["defuse_tick"] - BUFFER_SECONDS_BEFORE * TICK_RATE),
                end_tick=bh["defuse_tick"] + BUFFER_SECONDS_AFTER * TICK_RATE,
                context_tags=list(bh["tags"]), killer_name=None, victims=[],
                score_own=so, score_opp=se,
                round_won=round_result_map.get(bh["round"]),
                clip_min_tick=round_freeze_end_ticks.get(bh["round"]),
            ))
        highlight_clips = merged_highlights

        meme_clips: list[Clip] = []

        shoulder_clips = detect_shoulder_clips(
            spatial_cache=spatial_cache, target_player=target_player,
            round_freeze_end_ticks=round_freeze_end_ticks, round_result_map=round_result_map,
            round_team_score_map=round_team_score_map, round_death_tick_map=round_death_tick_map,
            map_name=map_name,
        )
        fail_clips = fail_clips + shoulder_clips

        _demo_max_tick = shared_facts.demo_max_tick

        compilation_clips = build_rival_compilations(
            target_player, round_kills, death_records,
            round_team_score_map, round_result_map, round_freeze_end_ticks,
            freeze_to_death_rounds=freeze_to_death_rounds,
            round_freeze_start_ticks=round_freeze_start_ticks,
            map_name=map_name, demo_max_tick=_demo_max_tick,
            round_end_tick_map=round_end_tick_map,
        )

        clips = fail_clips + highlight_clips + meme_clips + compilation_clips
        _done_rounds, _final_line = match_metrics_from_round_scores(round_team_score_map)
        clips = [
            c for c in clips
            if not is_post_match_round(
                c.round, c.score_own, c.score_opp,
                completed_rounds=_done_rounds, final_scoreline=_final_line,
            )
        ]
        clips.sort(key=lambda c: (c.round, c.start_tick))

        # clip_max_tick 计算
        _re_offset_last_ticks = int(float(
            os.environ.get("CS2_INSIGHT_LAST_ROUND_END_OFFSET_SEC", "-3.0") or "-3.0"
        ) * TICK_RATE)
        _re_buf_mid_ticks = int(float(
            os.environ.get("CS2_INSIGHT_MID_ROUND_END_BUFFER_SEC", "3.0") or "3.0"
        ) * TICK_RATE)
        _last_kill_buf_ticks = int(float(
            os.environ.get("CS2_INSIGHT_LAST_ROUND_KILL_BUFFER_SEC", "0.70") or "0.70"
        ) * TICK_RATE)
        _win_panel_ceiling = win_panel_ceiling_from_match_tick(win_panel_match_tick, TICK_RATE)

        # round_end 事件 tick 映射（已从缓存 DataFrame 派生）
        _round_end_evt_tick_map: dict[int, int] = dict(round_end_tick_map)
        if not _round_end_evt_tick_map and round_freeze_end_ticks:
            _sorted_rnds = sorted(round_freeze_end_ticks.keys())
            for _i, _rn in enumerate(_sorted_rnds):
                if _i + 1 < len(_sorted_rnds):
                    _round_end_evt_tick_map[_rn] = round_freeze_end_ticks[_sorted_rnds[_i + 1]] - int(5 * TICK_RATE)
                else:
                    _round_end_evt_tick_map[_rn] = round_freeze_end_ticks[_rn] + int(30 * TICK_RATE)

        _last_rnd_num = max(_round_end_evt_tick_map.keys()) if _round_end_evt_tick_map else None
        _terminal_play_round: Optional[int] = None
        try:
            _lrn_i = int(_last_rnd_num) if _last_rnd_num is not None else 0
        except (TypeError, ValueError):
            _lrn_i = 0
        try:
            _done_i = int(_done_rounds) if _done_rounds else 0
        except (TypeError, ValueError):
            _done_i = 0
        _tpr_i = max(_lrn_i, _done_i)
        if _tpr_i > 0:
            _terminal_play_round = _tpr_i

        logger.info(
            "[clip_max_tick] round_end_evt_tick_map rounds=%s last_rnd=%s terminal_round=%s done_rounds=%s",
            sorted(_round_end_evt_tick_map.keys()), _last_rnd_num, _terminal_play_round, _done_rounds,
        )
        for _c in clips:
            if _c.clip_max_tick is not None:
                pass
            elif _c.category == "compilation":
                _ck = str(getattr(_c, "compilation_kind", None) or "").strip()
                if _ck == "freeze_to_death":
                    _ld = getattr(_c, "death_tick", None)
                    if _ld is not None and int(_ld) > 0:
                        _c.clip_max_tick = int(_ld) + _last_kill_buf_ticks
                        if _c.end_tick > _c.clip_max_tick:
                            _c.end_tick = _c.clip_max_tick
                elif _terminal_play_round is not None:
                    _rounds_src = getattr(_c, "source_rounds", None) or []
                    _kts = getattr(_c, "kill_ticks", None) or []
                    _last_match_evt: Optional[int] = None
                    if isinstance(_rounds_src, list) and isinstance(_kts, list):
                        try:
                            _lrn = int(_terminal_play_round)
                        except (TypeError, ValueError):
                            _lrn = 0
                        if _lrn > 0:
                            for _i, _rn_raw in enumerate(_rounds_src):
                                try:
                                    _rni = int(_rn_raw)
                                except (TypeError, ValueError):
                                    continue
                                if _rni != _lrn:
                                    continue
                                if _i >= len(_kts):
                                    continue
                                try:
                                    _kti = int(_kts[_i])
                                except (TypeError, ValueError):
                                    continue
                                if _kti > 0 and (_last_match_evt is None or _kti > _last_match_evt):
                                    _last_match_evt = _kti
                        if _last_match_evt is None and _lrn > 0:
                            try:
                                _sr_max = max(int(_rn_raw) for _rn_raw in _rounds_src if str(_rn_raw).strip() not in ("", "None"))
                            except (TypeError, ValueError):
                                _sr_max = 0
                            if _sr_max > _lrn:
                                for _i, _rn_raw in enumerate(_rounds_src):
                                    try:
                                        _rni = int(_rn_raw)
                                    except (TypeError, ValueError):
                                        continue
                                    if _rni != _sr_max:
                                        continue
                                    if _i >= len(_kts):
                                        continue
                                    try:
                                        _kti = int(_kts[_i])
                                    except (TypeError, ValueError):
                                        continue
                                    if _kti > 0 and (_last_match_evt is None or _kti > _last_match_evt):
                                        _last_match_evt = _kti
                    if _last_match_evt is not None and _last_match_evt > 0:
                        _heuristic = int(_last_match_evt) + _last_kill_buf_ticks
                        if _win_panel_ceiling is not None and _win_panel_ceiling > int(_last_match_evt):
                            _c.clip_max_tick = _win_panel_ceiling
                        else:
                            _c.clip_max_tick = _heuristic
                        if _c.end_tick > _c.clip_max_tick:
                            _c.end_tick = _c.clip_max_tick
            elif _terminal_play_round is not None and _c.round == _terminal_play_round:
                if _c.kill_ticks:
                    _last_evt_tick = max(_c.kill_ticks)
                elif _c.death_tick is not None:
                    _last_evt_tick = _c.death_tick
                else:
                    _re_t = _round_end_evt_tick_map.get(_c.round, 0)
                    _last_evt_tick = _re_t + _re_offset_last_ticks if _re_t else None
                if _last_evt_tick:
                    _heuristic = int(_last_evt_tick) + int(_last_kill_buf_ticks)
                    if _win_panel_ceiling is not None and _win_panel_ceiling > int(_last_evt_tick):
                        _c.clip_max_tick = _win_panel_ceiling
                    else:
                        _c.clip_max_tick = _heuristic
                    if _c.end_tick > _c.clip_max_tick:
                        _c.end_tick = _c.clip_max_tick
            elif _c.round in _round_end_evt_tick_map:
                _round_end_tick = _round_end_evt_tick_map[_c.round]
                _next_freeze_tick = _int(round_freeze_end_ticks.get(_c.round + 1))
                _round_end_limit = _round_end_tick + _re_buf_mid_ticks
                _clip_limit = _round_end_limit
                if _c.kill_ticks:
                    _last_kill_tick = max(_c.kill_ticks)
                    if _last_kill_tick > _round_end_tick:
                        if _next_freeze_tick > _round_end_tick:
                            _clip_limit = _next_freeze_tick
                        else:
                            _clip_limit = max(_clip_limit, _last_kill_tick + int(BUFFER_SECONDS_AFTER * TICK_RATE))
                if _next_freeze_tick > _round_end_tick:
                    _clip_limit = min(_clip_limit, _next_freeze_tick)
                _c.clip_max_tick = _clip_limit
                if _c.end_tick > _c.clip_max_tick:
                    _c.end_tick = _c.clip_max_tick
            logger.info(
                "[clip_max_tick] clip_id=%s round=%s last_evt_tick=%s clip_max_tick=%s (terminal_rnd=%s)",
                _c.clip_id, _c.round,
                max(_c.kill_ticks) if _c.kill_ticks else _c.death_tick,
                _c.clip_max_tick, _terminal_play_round,
            )

        team_a_score, team_b_score, match_date, duration_mins, team_a_name, team_b_name = (
            shared_facts.match_summary
        )

        event_user_id = _lookup_user_id_for_name(shared_facts.name_to_uid, target_player)
        spec_slots = shared_facts.spec_slots
        target_player_user_id = (
            _spec_player_slot_from_event_user_id(
                event_user_id,
                self.dem_path,
                shared_facts.observed_user_ids,
            )
            or lookup_spec_player_slot_for_name(spec_slots, target_player)
        )
        for _c in clips:
            _c.target_spec_slot = target_player_user_id
            _c.kill_spec_slots = [target_player_user_id] * len(_c.kill_ticks)
            _c.victim_spec_slots = [spec_slots.get(v.lower()) if v else None for v in _c.victims]
            if _c.killer_name:
                _c.killer_spec_slot = spec_slots.get(_c.killer_name.lower())
            _c.killers_spec_slots = [spec_slots.get(k.lower()) if k else None for k in _c.killers]
        tsid = _lookup_steam_id_for_name(shared_facts.name_to_sid, target_player)
        target_steam_id = str(tsid) if tsid is not None else None

        all_players_roster = shared_facts.roster_snapshot()
        _server_name = shared_facts.server_name

        total_rounds = max(round_kills.keys(), default=0)
        if events.shape[0] > 0 and "total_rounds_played" in events.columns:
            total_rounds = max(total_rounds, _int(events["total_rounds_played"].max()) + 1)
        rounds_by_wins = team_a_score + team_b_score
        if rounds_by_wins > 0:
            total_rounds = rounds_by_wins

        timeline: Optional[dict] = None
        round_timeline: Optional[list] = None
        try:
            from ..round_timeline import build_round_timeline, build_round_timeline_error_fallback

            re_df_tl = re_df_cached
            tteam: Optional[int] = None
            if round_target_team_map:
                for rk in (1, *sorted(round_target_team_map.keys())):
                    if rk in round_target_team_map:
                        tteam = int(round_target_team_map[rk])
                        break

            # 每回合比分：优先按「队伍身份」累计（与记分牌一致，换边不串号），
            # 回退到旧的按阵营 (T/CT) 累计。槽位约定：2=开赛打 T 的一方，3=开赛打 CT 的一方。
            round_scores_tbl = shared_facts.round_scores_by_round
            if round_team_score_map and tteam in (2, 3):
                _opp_slot = 3 if tteam == 2 else 2
                round_scores_tbl = {
                    rn: {tteam: int(own), _opp_slot: int(opp)}
                    for rn, (own, opp) in round_team_score_map.items()
                }
            timeline_positions = shared_facts.timeline_event_positions_by_player.get(
                target_player,
                (),
            )
            timeline_events = events.iloc[list(timeline_positions)]
            bundle = build_round_timeline(
                demo_path=str(self.dem_path),
                map_name=map_name,
                target_player=target_player,
                target_player_user_id=target_player_user_id,
                target_steam_id=target_steam_id,
                target_team_num=tteam,
                round_target_team_map=round_target_team_map or {},
                events=timeline_events,
                round_freeze_end_ticks=round_freeze_end_ticks,
                round_result_map=round_result_map,
                round_scores_by_round=round_scores_tbl,
                round_end_df=re_df_tl,
                round_end_tick_map=_round_end_evt_tick_map,
                clips=[c.to_dict() for c in clips],
                total_rounds=total_rounds,
                match_start_tick=match_start_tick,
                tick_rate=float(TICK_RATE),
                spec_slots=spec_slots,
                win_panel_match_tick=win_panel_match_tick,
            )
            timeline = bundle.get("timeline")
            round_timeline = bundle.get("round_timeline")
        except BaseException as e:
            if isinstance(e, _DEMOPARSER_RE_RAISE):
                raise
            logger.exception("build_round_timeline failed for %s", self.dem_path)
            from ..round_timeline import build_round_timeline_error_fallback
            fb = build_round_timeline_error_fallback(
                demo_path=str(self.dem_path), map_name=map_name, target_player=target_player,
                target_steam_id=target_steam_id, target_player_user_id=target_player_user_id,
                total_rounds=total_rounds,
            )
            timeline = fb["timeline"]
            round_timeline = fb["round_timeline"]

        return ParseResult(
            match_meta=MatchMeta(
                map_name=map_name, target_player=target_player, total_rounds=total_rounds,
                target_player_user_id=target_player_user_id, target_steam_id=target_steam_id,
                target_kills=target_total_kills, target_deaths=target_total_deaths,
                team_a_score=team_a_score, team_b_score=team_b_score,
                team_a_name=team_a_name, team_b_name=team_b_name,
                match_date=match_date, duration_mins=duration_mins,
                meme_series_badges=meme_series_badges_for_kd(target_total_kills, target_total_deaths),
                server_name=_server_name, all_players=all_players_roster,
                win_panel_match_tick=win_panel_match_tick,
            ),
            clips=clips, timeline=timeline, round_timeline=round_timeline,
        )

    def analyze(
        self,
        target_player: str,
        *,
        freeze_to_death_rounds: Optional[list[int]] = None,
    ) -> ParseResult:
        results = self.analyze_multi_players(
            [target_player], freeze_to_death_rounds=freeze_to_death_rounds
        )
        return results[str(target_player).strip()]


def collect_match_summary_metrics(
    parser: DemoParser,
    dem_path: Path,
    match_start_tick: int,
    *,
    death_events: Optional[pd.DataFrame] = None,
    round_end_df: Optional[pd.DataFrame] = None,
    header: Optional[dict] = None,
) -> tuple[int, int, str, int, int, str, str]:
    """全局比赛信息：Team2/3 胜场、Demo 时长、总回合、队名。"""
    team_a_score = 0
    team_b_score = 0

    internal_a, internal_b = _extract_team_names_from_demo(parser, match_start_tick)
    team_a_name = internal_a or "Team A"
    team_b_name = internal_b or "Team B"
    match_date = ""
    duration_mins = 0
    total_rounds_est = 0

    duration_header = 0
    try:
        header_data = header if header is not None else parser.parse_header()
        raw_pt = header_data.get("playback_time", 0)
        duration_header = int(float(raw_pt) // 60) if raw_pt is not None else 0
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        duration_header = 0

    try:
        re_df = (
            round_end_df
            if _round_end_frame_usable(round_end_df, match_start_tick)
            else _to_pandas_df(parser.parse_event("round_end"))
        )
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        re_df = pd.DataFrame()

    if re_df.empty:
        return team_a_score, team_b_score, match_date, duration_mins, total_rounds_est, team_a_name, team_b_name

    re_filtered = re_df
    if match_start_tick > 0 and "tick" in re_df.columns:
        re_filtered = re_df.loc[
            pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()

    if match_start_tick > 0:
        team_a_score, team_b_score = _scoreline_by_starting_roster(parser, match_start_tick, re_df)

    # _scoreline_by_starting_roster 依赖逐 tick team_num，部分国服 demo 上该字段几乎全空，
    # 会退化成单边比分（如 9:0）。检测到单边或全零时，改用对坏数据稳健的「队伍身份」算法重算。
    _one_sided = (team_a_score == 0) ^ (team_b_score == 0)
    if _one_sided or (team_a_score == 0 and team_b_score == 0):
        ta_id, tb_id = compute_team_identity_scoreline(parser, match_start_tick, re_df)
        if ta_id + tb_id > 0:
            team_a_score, team_b_score = ta_id, tb_id

    if team_a_score == 0 and team_b_score == 0:
        team_a_score, team_b_score = _count_team_wins_from_round_end_df(re_filtered)
        if team_a_score == 0 and team_b_score == 0 and match_start_tick > 0:
            ua, ub = _count_team_wins_from_round_end_df(re_df)
            if ua + ub > 0:
                team_a_score, team_b_score = ua, ub

    total_rounds_est = team_a_score + team_b_score
    if total_rounds_est <= 0:
        total_rounds_est = _infer_total_rounds_from_round_end(re_df, match_start_tick)

    max_tick = _max_demo_tick(
        parser,
        re_df,
        match_start_tick,
        death_df=death_events,
    )
    duration_ticks = _duration_mins_from_tick_span(match_start_tick, max_tick)
    duration_mins = max(duration_header, duration_ticks)

    return team_a_score, team_b_score, match_date, duration_mins, total_rounds_est, team_a_name, team_b_name


def get_demo_match_summary(
    dem_path: str | Path,
    *,
    parser: Optional[DemoParser] = None,
    match_start_tick: Optional[int] = None,
    death_events: Optional[pd.DataFrame] = None,
    round_end_df: Optional[pd.DataFrame] = None,
    header: Optional[dict] = None,
) -> dict[str, object]:
    """上传后即刻可用的比赛摘要（无需选定玩家）。"""
    path = Path(dem_path)
    fallback: dict[str, object] = {
        "map_name": "unknown", "server_name": "", "target_player": "",
        "target_player_user_id": None, "target_steam_id": None,
        "total_rounds": 0, "target_kills": 0, "target_deaths": 0,
        "team_a_score": 0, "team_b_score": 0, "team_a_name": "Team A",
        "team_b_name": "Team B", "match_date": "", "duration_mins": 0,
        "win_panel_match_tick": 0,
    }
    try:
        parser = parser or DemoParser(str(path))
        mst = (
            int(match_start_tick)
            if match_start_tick is not None
            else _get_match_start_tick(parser)
        )
        ta, tb, md, dm, tr_est, tan, tbn = collect_match_summary_metrics(
            parser,
            path,
            mst,
            death_events=death_events,
            round_end_df=round_end_df,
            header=header,
        )
        try:
            hdr = header if header is not None else parser.parse_header()
            mn = hdr.get("map_name", "unknown") or "unknown"
            sn_raw = hdr.get("server_name")
            sn = str(sn_raw).strip() if sn_raw is not None else ""
        except BaseException as e:
            if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                raise
            mn = "unknown"
            sn = ""
        return {
            "map_name": mn, "server_name": sn, "target_player": "",
            "target_player_user_id": None, "target_steam_id": None,
            "total_rounds": int(tr_est), "target_kills": 0, "target_deaths": 0,
            "team_a_score": int(ta), "team_b_score": int(tb),
            "team_a_name": tan, "team_b_name": tbn,
            "match_date": md, "duration_mins": int(dm),
            "win_panel_match_tick": 0,
        }
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        logger.warning(
            "get_demo_match_summary: unreadable or corrupt demo %s (%s)", path, type(e).__name__,
        )
        return dict(fallback)


def inspect_demo(dem_path: str | Path) -> dict[str, object]:
    """Return upload/library metadata from one parser and one shared event scan."""
    path = Path(dem_path)
    parser = DemoParser(str(path))

    try:
        parsed_header = parser.parse_header()
        header = parsed_header if isinstance(parsed_header, dict) else {}
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        header = {}

    batch = safe_parse_events_batch(
        parser,
        ["player_death", "round_end", "round_announce_match_start"],
        player=["user_id"],
        other=list(_EXTRA_EVENT_FIELDS) + ["winner", "reason"],
    )
    deaths = batch["player_death"]
    round_ends = batch["round_end"]
    match_start_df = batch["round_announce_match_start"]
    match_start_tick = _get_match_start_tick(parser, precomputed_df=match_start_df)

    try:
        player_info_df = _to_pandas_df(parser.parse_player_info())
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        player_info_df = pd.DataFrame()

    players = get_player_list(
        path,
        parser=parser,
        match_start_tick=match_start_tick,
        death_events=deaths,
        player_info_df=player_info_df,
    )
    match_meta = get_demo_match_summary(
        path,
        parser=parser,
        match_start_tick=match_start_tick,
        death_events=deaths,
        round_end_df=round_ends,
        header=header,
    )
    return {"players": players, "match_meta": match_meta}
