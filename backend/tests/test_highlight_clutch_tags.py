from app.parser.tag_detection import build_highlight_tags


def _kill(tick: int) -> dict:
    return {
        "tick": tick,
        "weapon": "ak47",
        "headshot": False,
        "tags": [],
    }


def _snapshot(target: str, *, mates: int, enemies: int) -> tuple[dict, dict]:
    rows = {
        target: {
            "name": target,
            "team_num": 2,
            "is_alive": True,
            "health": 100,
            "X": 0.0,
            "Y": 0.0,
            "Z": 0.0,
        },
    }
    friendly_names = {target}
    for index in range(mates):
        name = f"Mate{index + 1}"
        friendly_names.add(name)
        rows[name] = {
            "name": name,
            "team_num": 2,
            "is_alive": True,
            "X": 100.0 + index,
            "Y": 0.0,
            "Z": 0.0,
        }

    enemy_names = set()
    for index in range(enemies):
        name = f"Enemy{index + 1}"
        enemy_names.add(name)
        rows[name] = {
            "name": name,
            "team_num": 3,
            "is_alive": True,
            "X": 1000.0 + index,
            "Y": 0.0,
            "Z": 0.0,
        }

    alive = {2: frozenset(friendly_names), 3: frozenset(enemy_names)}
    return rows, alive


def _build_tags(
    kills: list[dict],
    snapshots: dict[int, tuple[dict, dict]],
) -> list[str]:
    spatial_cache = {tick: snapshot[0] for tick, snapshot in snapshots.items()}
    alive_summary = {tick: snapshot[1] for tick, snapshot in snapshots.items()}
    return build_highlight_tags(
        kills,
        kills[0]["tick"],
        kills[-1]["tick"],
        20,
        {},
        spatial_cache,
        "Hero",
        {},
        2,
        (11, 8),
        round_won=True,
        alive_summary=alive_summary,
    )


def test_real_1v4_is_not_downgraded_to_later_1v2() -> None:
    kills = [_kill(tick) for tick in (100, 200, 300, 400)]
    snapshots = {
        192: _snapshot("Hero", mates=0, enemies=4),
        292: _snapshot("Hero", mates=0, enemies=2),
        392: _snapshot("Hero", mates=0, enemies=1),
    }

    tags = _build_tags(kills, snapshots)

    assert "🔥 1v4 史诗残局" in tags
    assert "🔥 1v2 史诗残局" not in tags
    assert "🐂 1v1 斗牛" not in tags


def test_pure_1v1_win_keeps_bull_duel_tag() -> None:
    kills = [_kill(tick) for tick in (100, 200)]
    snapshots = {
        192: _snapshot("Hero", mates=0, enemies=1),
    }

    tags = _build_tags(kills, snapshots)

    assert "🐂 1v1 斗牛" in tags
    assert not any("史诗残局" in tag for tag in tags)
