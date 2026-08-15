from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Optional

from ... import native_table as pd


def _text(value: object) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    text = str(value).strip()
    return "" if not text or text.lower() in {"nan", "nat", "none"} else text


def _positive_int_text(value: object) -> str:
    if value is None or isinstance(value, bool) or (
        isinstance(value, float) and pd.isna(value)
    ):
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    try:
        number = int(text)
    except (TypeError, ValueError):
        return ""
    return str(number) if number > 0 else ""


def steam_player_key(steamid: object) -> str:
    value = _positive_int_text(steamid)
    return f"steamid:{value}" if value else ""


def player_key_for_values(
    name: object,
    steamid: object = None,
    user_id: object = None,
) -> str:
    steam_key = steam_player_key(steamid)
    if steam_key:
        return steam_key
    uid = _positive_int_text(user_id)
    if uid:
        return f"userid:{uid}"
    normalized_name = _text(name).casefold()
    return f"name:{normalized_name}" if normalized_name else ""


@dataclass(slots=True)
class PlayerIdentity:
    player_key: str
    display_name: str
    steamid: str = ""
    user_id: str = ""
    analysis_name: str = ""


@dataclass(frozen=True, slots=True)
class ResolvedPlayerTarget:
    result_key: str
    analysis_name: str
    identity: Optional[PlayerIdentity]


_ROLE_COLUMNS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("attacker_name", ("attacker_steamid",), ("attacker_user_id", "attacker_id")),
    ("user_name", ("user_steamid", "steamid"), ("user_user_id", "user_id")),
    ("assister_name", ("assister_steamid", "assistor_steamid"), ("assister_user_id", "assistor_user_id")),
    ("player_name", ("player_steamid", "steamid"), ("player_user_id", "user_id")),
    ("defuser_name", ("defuser_steamid", "user_steamid", "steamid"), ("defuser_user_id", "user_user_id", "user_id")),
    ("defuser", ("defuser_steamid", "user_steamid", "steamid"), ("defuser_user_id", "user_user_id", "user_id")),
    ("name", ("steamid",), ("user_id",)),
)


def _first_value(row: dict[str, Any], columns: Iterable[str]) -> object:
    for column in columns:
        value = row.get(column)
        if _positive_int_text(value):
            return value
    return None


def _frame_observations(frame: Optional[pd.DataFrame]) -> list[tuple[str, str, str]]:
    if frame is None or frame.empty:
        return []
    observations: list[tuple[str, str, str]] = []
    columns = set(frame.columns)
    for _, row in frame.iterrows():
        for name_column, steam_columns, uid_columns in _ROLE_COLUMNS:
            if name_column not in columns:
                continue
            name = _text(row.get(name_column))
            if not name:
                continue
            steamid = _positive_int_text(_first_value(row, steam_columns))
            user_id = _positive_int_text(_first_value(row, uid_columns))
            observations.append((name, steamid, user_id))
    return observations


class PlayerIdentityRegistry:
    """Map Demo players by XUID/SteamID while keeping names display-only."""

    def __init__(self, identities: list[PlayerIdentity]):
        self.identities = identities
        self.by_key = {identity.player_key: identity for identity in identities}
        self.by_steamid = {
            identity.steamid: identity for identity in identities if identity.steamid
        }
        self.by_user_id = {
            identity.user_id: identity for identity in identities if identity.user_id
        }
        self.by_name: dict[str, list[PlayerIdentity]] = {}
        for identity in identities:
            self.by_name.setdefault(identity.display_name.casefold(), []).append(identity)

        for same_name in self.by_name.values():
            if len(same_name) == 1:
                same_name[0].analysis_name = same_name[0].display_name
                continue
            used: set[str] = set()
            for identity in same_name:
                suffix = identity.steamid[-8:] if identity.steamid else identity.user_id
                suffix = suffix or identity.player_key.rsplit(":", 1)[-1]
                candidate = f"{identity.display_name} · {suffix}"
                if candidate.casefold() in used:
                    candidate = f"{identity.display_name} · {identity.player_key}"
                used.add(candidate.casefold())
                identity.analysis_name = candidate

        self.by_analysis_name = {
            identity.analysis_name.casefold(): identity for identity in identities
        }

    @classmethod
    def from_frames(
        cls,
        *,
        player_info: Optional[pd.DataFrame] = None,
        death_events: Optional[pd.DataFrame] = None,
    ) -> "PlayerIdentityRegistry":
        observations = [
            *_frame_observations(player_info),
            *_frame_observations(death_events),
        ]
        uid_to_steamid: dict[str, str] = {}
        for _name, steamid, user_id in observations:
            if steamid and user_id:
                uid_to_steamid[user_id] = steamid

        identities_by_key: dict[str, PlayerIdentity] = {}
        for name, steamid, user_id in observations:
            resolved_steamid = steamid or uid_to_steamid.get(user_id, "")
            key = player_key_for_values(name, resolved_steamid, user_id)
            if not key:
                continue
            identity = identities_by_key.get(key)
            if identity is None:
                identity = PlayerIdentity(
                    player_key=key,
                    display_name=name,
                    steamid=resolved_steamid,
                    user_id=user_id,
                )
                identities_by_key[key] = identity
            else:
                if not identity.steamid and resolved_steamid:
                    identity.steamid = resolved_steamid
                if not identity.user_id and user_id:
                    identity.user_id = user_id

        return cls(list(identities_by_key.values()))

    @property
    def has_name_collisions(self) -> bool:
        return any(len(identities) > 1 for identities in self.by_name.values())

    def identity_for_values(
        self,
        name: object,
        steamid: object = None,
        user_id: object = None,
    ) -> Optional[PlayerIdentity]:
        sid = _positive_int_text(steamid)
        if sid and sid in self.by_steamid:
            return self.by_steamid[sid]
        uid = _positive_int_text(user_id)
        if uid and uid in self.by_user_id:
            return self.by_user_id[uid]
        candidates = self.by_name.get(_text(name).casefold(), [])
        return candidates[0] if len(candidates) == 1 else None

    def identity_for_analysis_name(self, value: object) -> Optional[PlayerIdentity]:
        return self.by_analysis_name.get(_text(value).casefold())

    def canonicalize_frame(self, frame: Optional[pd.DataFrame]) -> Optional[pd.DataFrame]:
        if frame is None or frame.empty or not self.has_name_collisions:
            return frame
        columns = set(frame.columns)
        replacements: dict[str, list[object]] = {}
        for name_column, steam_columns, uid_columns in _ROLE_COLUMNS:
            if name_column not in columns:
                continue
            values: list[object] = []
            for _, row in frame.iterrows():
                raw_name = row.get(name_column)
                identity = self.identity_for_values(
                    raw_name,
                    _first_value(row, steam_columns),
                    _first_value(row, uid_columns),
                )
                values.append(identity.analysis_name if identity is not None else raw_name)
            replacements[name_column] = values
        for column, values in replacements.items():
            frame[column] = values
        return frame

    def resolve_targets(self, requested: Iterable[str]) -> list[ResolvedPlayerTarget]:
        resolved: list[ResolvedPlayerTarget] = []
        seen: set[str] = set()
        for raw_value in requested:
            raw = _text(raw_value)
            if not raw:
                continue
            identity = self.by_key.get(raw)
            if identity is None and raw.isdigit():
                identity = self.by_steamid.get(raw)
            if identity is not None:
                if identity.player_key not in seen:
                    seen.add(identity.player_key)
                    resolved.append(
                        ResolvedPlayerTarget(
                            identity.player_key,
                            identity.analysis_name,
                            identity,
                        )
                    )
                continue

            by_analysis = self.identity_for_analysis_name(raw)
            if by_analysis is not None:
                if by_analysis.player_key not in seen:
                    seen.add(by_analysis.player_key)
                    resolved.append(
                        ResolvedPlayerTarget(raw, by_analysis.analysis_name, by_analysis)
                    )
                continue

            same_name = self.by_name.get(raw.casefold(), [])
            if len(same_name) == 1:
                identity = same_name[0]
                if identity.player_key not in seen:
                    seen.add(identity.player_key)
                    # Preserve legacy name-keyed responses for unambiguous callers.
                    resolved.append(ResolvedPlayerTarget(raw, identity.analysis_name, identity))
            elif same_name:
                # A legacy name-only request is ambiguous. Analyze every matching
                # identity separately instead of merging them under the nickname.
                for identity in same_name:
                    if identity.player_key in seen:
                        continue
                    seen.add(identity.player_key)
                    resolved.append(
                        ResolvedPlayerTarget(
                            identity.player_key,
                            identity.analysis_name,
                            identity,
                        )
                    )
            elif raw not in seen:
                seen.add(raw)
                resolved.append(ResolvedPlayerTarget(raw, raw, None))
        return resolved

    def canonical_team_map(
        self,
        steam_to_team: dict[str, int],
        fallback_name_to_team: dict[str, int],
    ) -> dict[str, int]:
        out: dict[str, int] = {}
        for identity in self.identities:
            team = steam_to_team.get(identity.steamid) if identity.steamid else None
            if team not in (2, 3):
                candidates = self.by_name.get(identity.display_name.casefold(), [])
                if len(candidates) == 1:
                    team = fallback_name_to_team.get(identity.display_name.casefold())
            if team in (2, 3):
                out[identity.analysis_name.casefold()] = int(team)
        return out

    def enrich_roster(self, roster: list[dict[str, Any]]) -> None:
        for row in roster:
            identity = self.identity_for_values(
                row.get("name"),
                row.get("steamid64") or row.get("steam_id64") or row.get("steam_id"),
                row.get("user_id") or row.get("spec_slot"),
            ) or self.identity_for_analysis_name(row.get("name"))
            if identity is None:
                continue
            row["player_key"] = identity.player_key
            row["display_name"] = identity.display_name
            row["xuid"] = identity.steamid or None

    def decorate_result(self, result: Any, analysis_name: str) -> None:
        identity = self.identity_for_analysis_name(analysis_name)
        if identity is None:
            return
        match_meta = getattr(result, "match_meta", None)
        if match_meta is None:
            return
        match_meta.target_player = identity.display_name
        match_meta.target_player_key = identity.player_key
        if identity.steamid:
            match_meta.target_steam_id = identity.steamid
        self.enrich_roster(match_meta.all_players)


class IdentityAwareDemoParser:
    """Delegate to demoparser2 and qualify only colliding player names."""

    def __init__(self, parser: Any, registry: PlayerIdentityRegistry):
        self._parser = parser
        self._registry = registry

    @property
    def identity_registry(self) -> PlayerIdentityRegistry:
        return self._registry

    def __getattr__(self, name: str) -> Any:
        return getattr(self._parser, name)

    def parse_ticks(self, *args: Any, **kwargs: Any) -> pd.DataFrame:
        return self._registry.canonicalize_frame(
            pd.DataFrame(self._parser.parse_ticks(*args, **kwargs))
        )

    def parse_event(self, *args: Any, **kwargs: Any) -> pd.DataFrame:
        return self._registry.canonicalize_frame(
            pd.DataFrame(self._parser.parse_event(*args, **kwargs))
        )

    def parse_player_info(self, *args: Any, **kwargs: Any) -> pd.DataFrame:
        return self._registry.canonicalize_frame(
            pd.DataFrame(self._parser.parse_player_info(*args, **kwargs))
        )

    def parse_events(self, *args: Any, **kwargs: Any) -> Any:
        raw = self._parser.parse_events(*args, **kwargs)
        if isinstance(raw, list) and raw and isinstance(raw[0], tuple):
            return [
                (name, self._registry.canonicalize_frame(pd.DataFrame(frame)))
                for name, frame in raw
            ]
        return self._registry.canonicalize_frame(pd.DataFrame(raw))
