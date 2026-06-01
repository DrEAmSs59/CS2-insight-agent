# 多玩家共享解析优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 N 玩家解析从"N 次子进程 × 每次完整扫描 demo"优化为"1 次子进程，事件解析共享，空间快照合并"，预期耗时从 1.9min（10 人）降至 ~20s。

**Architecture:** 在 `DemoAnalyzer` 新增 `_parse_shared_events()` 提取共享 IO，新增 `analyze_multi_players()` 复用共享数据；`analyze()` 改为其单人包装；`parse_worker.py` 增加 `analyze_batch` action；`_run_library_demo_analyze` 改为单次子进程调用。

**Tech Stack:** Python 3.12 / demoparser2 / pandas / asyncio

---

## 关键数据流变化

**旧流程**（10 玩家 ≈ 80 次 IO）：
```
for player in players:               # 10 次循环
    subprocess → DemoAnalyzer.analyze(player)
        parse_events(bomb)            # IO
        parse_events(equip)           # IO
        parse_event(player_death)     # IO
        parse_event(weapon_fire)      # IO
        parse_event(player_hurt)      # IO
        parse_events(nade)            # IO
        parse_event(round_end)        # IO
        parse_ticks(spatial)          # IO — 最大瓶颈
```

**新流程**（10 玩家 ≈ 10 次 IO）：
```
subprocess → DemoAnalyzer.analyze_multi_players(players)
    _parse_shared_events()            # IO × 7（所有玩家共享）
    for player in players:            # 纯 Python，无 IO
        build_round_economy()         # IO × 2（每人仍需，但很小）
        _extract_kills_deaths()       # 纯 Python
        collect spatial ticks
    parse_ticks(union of all ticks)   # IO × 1（合并后单次）
    for player in players:            # 纯 Python，无 IO
        build_clips()
```

---

## 文件变更清单

| 文件 | 变更类型 | 内容 |
|------|---------|------|
| `backend/app/parser/analyzer.py` | Modify | 新增 `_parse_shared_events()`、`analyze_multi_players()`；`analyze()` 改为包装器 |
| `backend/app/parse_worker.py` | Modify | 新增 `analyze_batch` action |
| `backend/app/demo_parse_isolation.py` | Modify | 新增 `analyze_multi_isolated()` |
| `backend/app/main.py` | Modify | `_run_library_demo_analyze` 改用 `analyze_multi_isolated()` |

---

## Task 1：DemoAnalyzer — 提取 `_parse_shared_events()`

**Files:**
- Modify: `backend/app/parser/analyzer.py`

这一步把 `analyze()` 里所有玩家无关的 IO 提取成独立方法，`analyze()` 调用它，行为不变。

- [ ] **Step 1: 在 `DemoAnalyzer` 类里，`analyze()` 方法之前插入 `_parse_shared_events()` 方法**

读取 `backend/app/parser/analyzer.py` 找到 `class DemoAnalyzer:` 内的 `def analyze(` 行（当前约第 145 行），在其**之前**插入：

```python
    def _parse_shared_events(self, match_start_tick: int) -> dict:
        """
        解析所有玩家共享的事件 DataFrame，每次 demo 文件只扫描一次。
        返回包含以下键的 dict：
          events, fire_df, hurt_df, equip_df, pickup_df,
          planted_df, defused_df, bomb_exploded_df, begindefuse_df,
          nade_batch, re_df_cached
        所有 DataFrame 已做 warmup 过滤和 name 列 strip。
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

        # 炸弹批量
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

        # 装备批量
        _equip_batch = safe_parse_events_batch(
            self.parser,
            ["item_equip", "item_pickup"],
            player=["steamid", "name", "team_num"],
            other=["total_rounds_played"],
        )
        equip_df  = _filter_ms(_equip_batch["item_equip"])
        pickup_df = _filter_ms(_equip_batch["item_pickup"])

        # player_death（最大事件，单独解析）
        _death_other = list(dict.fromkeys(list(_EXTRA_EVENT_FIELDS) + list(_PLAYER_DEATH_GAME_KEYS)))
        events = _filter_ms(_to_pandas_df(self.parser.parse_event("player_death", other=_death_other)))

        # weapon_fire + player_hurt
        fire_df  = _filter_ms(self._safe_parse_event("weapon_fire"))
        hurt_df  = _filter_ms(self._safe_parse_event("player_hurt"))

        # 手雷爆点批量
        nade_batch = safe_parse_events_batch(
            self.parser,
            ["hegrenade_detonate", "inferno_startburn", "molotov_detonate"],
        )

        # round_end（缓存，复用于 round_end_tick_map 和 demo_max_tick）
        re_df = self._safe_parse_event("round_end", other=list(_EXTRA_EVENT_FIELDS))
        if match_start_tick > 0 and not re_df.empty and "tick" in re_df.columns:
            re_df = re_df.loc[
                pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
            ].copy()

        # Name strip
        for _df in (events, equip_df, fire_df, hurt_df, planted_df, defused_df):
            if _df is None or _df.empty:
                continue
            for _col in _NAME_COLS:
                if _col in _df.columns:
                    _df[_col] = _df[_col].astype(str).str.strip()

        # pickup_df 的 user_name 单独处理（原 analyze() 逻辑）
        if not pickup_df.empty and "user_name" in pickup_df.columns:
            pickup_df["user_name"] = pickup_df["user_name"].astype(str).str.strip()

        return {
            "events":        events,
            "fire_df":       fire_df,
            "hurt_df":       hurt_df,
            "equip_df":      equip_df,
            "pickup_df":     pickup_df,
            "planted_df":    planted_df,
            "defused_df":    defused_df,
            "bomb_exploded_df": bomb_exploded,
            "begindefuse_df":  begindefuse,
            "nade_batch":    nade_batch,
            "re_df_cached":  re_df,
        }
```

- [ ] **Step 2: 修改 `analyze()` 方法，用 `_parse_shared_events()` 替换其内部的相同 IO**

在 `analyze()` 方法体里，找到以下代码块（约第 184-255 行）并**整体替换**：

旧代码（从 `# ── P0 批量解析：炸弹事件` 到 name strip 循环结束，约第 184-255 行）：
```python
        # ── P0 批量解析：炸弹事件（1 次扫描替换 4 次）──
        _bomb_batch = safe_parse_events_batch(
        ...
        for _df in (events, equip_df, fire_df, hurt_df, planted_df, defused_df):
            if _df is None or _df.empty:
                continue
            for _col in _NAME_COLS:
                if _col in _df.columns:
                    _df[_col] = _df[_col].astype(str).str.strip()
```

替换为：
```python
        _shared = self._parse_shared_events(match_start_tick)
        events          = _shared["events"]
        fire_df         = _shared["fire_df"]
        hurt_df         = _shared["hurt_df"]
        equip_df        = _shared["equip_df"]
        pickup_df       = _shared["pickup_df"]
        planted_df      = _shared["planted_df"]
        defused_df      = _shared["defused_df"]
        _bomb_exploded_df = _shared["bomb_exploded_df"]
        _begindefuse_df   = _shared["begindefuse_df"]
        _nade_batch     = _shared["nade_batch"]
        _re_df_cached   = _shared["re_df_cached"]
```

同时，删除 `analyze()` 方法里后续对 `_nade_batch` 的重复解析（约第 214-218 行）和 `_re_df_cached` 的重复解析（约第 343-350 行），因为它们已由 `_parse_shared_events()` 提供。

> **注意**：`_re_df_cached` 在 `analyze()` 里有两处使用：`round_end_tick_map` 构建（约第 340 行）和 `_demo_max_tick` 调用（约第 583 行）。确保两处都用 `_shared["re_df_cached"]`。

- [ ] **Step 3: 验证 analyze() 行为不变**

```
cd backend
python -c "from app.parser.analyzer import DemoAnalyzer; print('import OK')"
```

Expected: `import OK`（无语法错误）

- [ ] **Step 4: 运行现有测试确认不退化**

```
cd backend
python -m pytest tests/ -q
```

Expected: `130 passed`

- [ ] **Step 5: Commit**

```
git add backend/app/parser/analyzer.py
git commit -m "refactor: extract _parse_shared_events() from analyze()"
```

---

## Task 2：DemoAnalyzer — 新增 `analyze_multi_players()`

**Files:**
- Modify: `backend/app/parser/analyzer.py`

核心优化：事件共享 + 空间快照合并。

- [ ] **Step 1: 在 `analyze_multi_players()` 方法紧接在 `analyze()` 方法之后插入**

```python
    def analyze_multi_players(
        self,
        target_players: list[str],
        freeze_to_death_rounds: Optional[list[int]] = None,
    ) -> dict[str, "ParseResult"]:
        """
        多玩家共享解析：事件解析仅执行一次，空间快照合并后单次 parse_ticks。
        返回 {player_name: ParseResult}。
        """
        if not target_players:
            return {}
        # 去重 + strip，保持顺序
        seen: set[str] = set()
        players: list[str] = []
        for p in target_players:
            s = str(p or "").strip()
            if s and s not in seen:
                seen.add(s)
                players.append(s)
        if not players:
            return {}

        map_name         = self._detect_map()
        match_start_tick = _get_match_start_tick(self.parser)

        # ── 阶段 1：共享事件解析（所有玩家只执行一次）──
        _shared = self._parse_shared_events(match_start_tick)

        # ── 阶段 2：per-player 第一轮（纯 Python + 极小 IO）──
        # build_round_economy 仍需 per-player（team 归属），但仅扫 ~24 tick
        per_player_ctx: dict[str, dict] = {}
        all_spatial_ticks: set[int] = set()

        aim_secs = _backstab_aim_sample_offsets_sec()

        for target_player in players:
            (
                round_economy_map,
                round_target_team_map,
                round_freeze_end_ticks,
                round_freeze_start_ticks,
            ) = build_round_economy(self.parser, target_player, match_start_tick)

            round_team_score_map = build_round_scores_team_based(
                self.parser, round_target_team_map, match_start_tick,
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

            events   = _shared["events"]
            fire_df  = _shared["fire_df"]
            hurt_df  = _shared["hurt_df"]
            equip_df = _shared["equip_df"]
            pickup_df = _shared["pickup_df"]
            planted_df  = _shared["planted_df"]
            defused_df  = _shared["defused_df"]
            _bomb_exploded_df = _shared["bomb_exploded_df"]
            _begindefuse_df   = _shared["begindefuse_df"]
            _nade_batch       = _shared["nade_batch"]
            _re_df_cached     = _shared["re_df_cached"]

            # AWP 索引（全场，per-player 过滤在 kill 循环里做）
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

            _fire_index_full = build_fire_index(target_player, fire_df)

            # Kill/death 提取（纯 Python，从共享 events DataFrame 过滤）
            round_kills: dict[int, list[dict]] = {}
            death_records: list[dict] = []
            target_total_kills = 0
            round_first_death_tick: dict[int, int] = {}

            for _, row in events.iterrows():
                round_num = _int(row.get("total_rounds_played")) + 1
                attacker  = str(row.get("attacker_name", "") or "").strip()
                victim    = str(row.get("user_name", "") or "").strip()
                weapon    = _normalize_item(row.get("weapon", ""))
                tick      = _int(row.get("tick"))

                if round_num not in round_first_death_tick and attacker and attacker != victim:
                    round_first_death_tick[round_num] = tick

                headshot     = _bool(row.get("headshot"))
                noscope      = _bool(row.get("noscope"))
                penetrated   = _int(row.get("penetrated"))
                thrusmoke    = _bool(row.get("thrusmoke"))
                attackerblind  = _bool(row.get("attackerblind"))
                assistedflash  = _bool(row.get("assistedflash"))
                attacker_team  = row.get("attackerteam")
                victim_team    = row.get("userteam")

                is_attacker = (attacker == target_player)
                is_victim   = (victim   == target_player)

                if is_victim:
                    death_records.append({
                        "round": round_num, "tick": tick, "weapon": weapon,
                        "headshot": headshot, "attacker": attacker,
                        "attacker_steamid": str(row.get("attacker_steamid") or ""),
                        "attacker_team": attacker_team, "victim_team": victim_team,
                        "attackerblind": attackerblind, "assistedflash": assistedflash,
                    })

                if is_attacker and attacker != victim:
                    target_total_kills += 1
                    per_kill_tags = detect_kill_action_tags(
                        weapon=weapon, headshot=headshot, noscope=noscope,
                        penetrated=penetrated, thrusmoke=thrusmoke, attackerblind=attackerblind,
                    )
                    shots_to_kill = count_shots_before(
                        _fire_index_full, tick, weapon, window_ticks=int(TICK_RATE * 2.0),
                    )
                    _vic_str   = str(victim).strip()
                    _rnd_lo    = round_freeze_end_ticks.get(round_num, 0)
                    _awp_lo    = max(_rnd_lo, tick - int(TICK_RATE * 5.0))
                    _vic_fired = any(_awp_lo <= _t <= tick for _t in _awp_fire_index.get(_vic_str, []))
                    _vic_picked= any(_awp_lo <= _t <= tick for _t in _awp_pickup_index.get(_vic_str, []))
                    round_kills.setdefault(round_num, []).append({
                        "weapon": weapon, "tick": tick, "headshot": headshot,
                        "noscope": noscope, "tags": per_kill_tags, "victim": victim,
                        "victim_steamid": str(row.get("user_steamid") or ""),
                        "thrusmoke": thrusmoke, "penetrated": penetrated,
                        "shots_to_kill": shots_to_kill,
                        "victim_had_awp": _vic_fired or _vic_picked,
                    })

            # C4 world cluster fixup
            c4_world_cluster_keys = _world_self_kill_cluster_c4_surrogate_keys(events, match_start_tick)
            _apply_c4_world_cluster_weapon_fixup(death_records, c4_world_cluster_keys)

            # 炸弹爆炸后击杀回合修正
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

            # 计算该玩家所需 spatial ticks，加入全局集合
            hs_ticks       = [d["tick"] for d in death_records if d["headshot"]]
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
            for kills in round_kills.values():
                for k in kills:
                    w = str(k.get("weapon") or "")
                    if w not in SNIPER_WEAPONS:
                        continue
                    if not (_bool(k.get("noscope")) or "盲狙" in (k.get("tags") or [])):
                        continue
                    kt = _int(k.get("tick"))
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

            player_spatial_ticks = set(
                hs_ticks + backstab_ticks + highlight_ticks + bomb_def_ticks
                + flying_ticks + jump_sample_ticks + fail_lookback_ticks + shoulder_ticks
            )
            all_spatial_ticks.update(player_spatial_ticks)

            per_player_ctx[target_player] = {
                "round_economy_map":       round_economy_map,
                "round_target_team_map":   round_target_team_map,
                "round_freeze_end_ticks":  round_freeze_end_ticks,
                "round_freeze_start_ticks":round_freeze_start_ticks,
                "round_team_score_map":    round_team_score_map,
                "round_result_map":        round_result_map,
                "round_kills":             round_kills,
                "death_records":           death_records,
                "round_first_death_tick":  round_first_death_tick,
                "round_target_kill_ticks": round_target_kill_ticks,
                "target_total_kills":      target_total_kills,
                "player_spatial_ticks":    player_spatial_ticks,
            }

        # ── 阶段 3：合并 spatial ticks，单次 parse_ticks ──
        spatial_cache = parse_spatial_snapshots(self.parser, sorted(all_spatial_ticks))

        # ── 阶段 4：per-player 第二轮（纯 Python）── 
        results: dict[str, ParseResult] = {}
        for target_player in players:
            ctx = per_player_ctx[target_player]

            # 解构 ctx
            round_economy_map        = ctx["round_economy_map"]
            round_target_team_map    = ctx["round_target_team_map"]
            round_freeze_end_ticks   = ctx["round_freeze_end_ticks"]
            round_freeze_start_ticks = ctx["round_freeze_start_ticks"]
            round_team_score_map     = ctx["round_team_score_map"]
            round_result_map         = ctx["round_result_map"]
            round_kills              = ctx["round_kills"]
            death_records            = ctx["death_records"]
            round_first_death_tick   = ctx["round_first_death_tick"]
            round_target_kill_ticks  = ctx["round_target_kill_ticks"]
            target_total_kills       = ctx["target_total_kills"]

            # 从 _shared 重新解构（局部名绑定，让下面的 analyze() 后半段代码可复用）
            events            = _shared["events"]
            fire_df           = _shared["fire_df"]
            hurt_df           = _shared["hurt_df"]
            equip_df          = _shared["equip_df"]
            pickup_df         = _shared["pickup_df"]
            planted_df        = _shared["planted_df"]
            defused_df        = _shared["defused_df"]
            _bomb_exploded_df = _shared["bomb_exploded_df"]
            _begindefuse_df   = _shared["begindefuse_df"]
            _nade_batch       = _shared["nade_batch"]
            _re_df_cached     = _shared["re_df_cached"]

            # 以下逻辑与 analyze() 方法的"空间快照之后"部分完全相同
            # 直接调用 analyze() 的后半段，传入已构建的数据

            result = self._finish_single_player_analysis(
                target_player         = target_player,
                map_name              = map_name,
                match_start_tick      = match_start_tick,
                round_economy_map     = round_economy_map,
                round_target_team_map = round_target_team_map,
                round_freeze_end_ticks = round_freeze_end_ticks,
                round_freeze_start_ticks = round_freeze_start_ticks,
                round_team_score_map  = round_team_score_map,
                round_result_map      = round_result_map,
                round_kills           = round_kills,
                death_records         = death_records,
                round_first_death_tick = round_first_death_tick,
                round_target_kill_ticks = round_target_kill_ticks,
                target_total_kills    = target_total_kills,
                spatial_cache         = spatial_cache,
                events                = events,
                fire_df               = fire_df,
                hurt_df               = hurt_df,
                equip_df              = equip_df,
                planted_df            = planted_df,
                defused_df            = defused_df,
                bomb_exploded_df      = _bomb_exploded_df,
                begindefuse_df        = _begindefuse_df,
                nade_batch            = _nade_batch,
                re_df_cached          = _re_df_cached,
                freeze_to_death_rounds = freeze_to_death_rounds,
            )
            results[target_player] = result

        return results
```

- [ ] **Step 2: 在 `analyze_multi_players()` 之后插入 `_finish_single_player_analysis()` 方法**

这个方法包含 `analyze()` 里"spatial_cache 构建完成后"到"return ParseResult"的全部逻辑。具体做法：

a) 在 `analyze()` 方法里找到 `spatial_cache = parse_spatial_snapshots(...)` 这行（约第 413 行），在它**之后**开始的全部代码（直到 `return ParseResult(...)`）整体剪切。

b) 创建新方法 `_finish_single_player_analysis(self, target_player, map_name, match_start_tick, round_economy_map, round_target_team_map, round_freeze_end_ticks, round_freeze_start_ticks, round_team_score_map, round_result_map, round_kills, death_records, round_first_death_tick, round_target_kill_ticks, target_total_kills, spatial_cache, events, fire_df, hurt_df, equip_df, planted_df, defused_df, bomb_exploded_df, begindefuse_df, nade_batch, re_df_cached, freeze_to_death_rounds=None) -> ParseResult:`，把剪切出来的代码粘贴进去。

c) 将 `analyze()` 里 `spatial_cache = parse_spatial_snapshots(...)` 之后替换为一行调用：
```python
        return self._finish_single_player_analysis(
            target_player=target_player,
            map_name=map_name,
            match_start_tick=match_start_tick,
            round_economy_map=round_economy_map,
            round_target_team_map=round_target_team_map,
            round_freeze_end_ticks=round_freeze_end_ticks,
            round_freeze_start_ticks=round_freeze_start_ticks,
            round_team_score_map=round_team_score_map,
            round_result_map=round_result_map,
            round_kills=round_kills,
            death_records=death_records,
            round_first_death_tick=round_first_death_tick,
            round_target_kill_ticks=round_target_kill_ticks,
            target_total_kills=target_total_kills,
            spatial_cache=spatial_cache,
            events=events,
            fire_df=fire_df,
            hurt_df=hurt_df,
            equip_df=equip_df,
            planted_df=planted_df,
            defused_df=defused_df,
            bomb_exploded_df=_bomb_exploded_df,
            begindefuse_df=_begindefuse_df,
            nade_batch=_nade_batch,
            re_df_cached=_re_df_cached,
            freeze_to_death_rounds=freeze_to_death_rounds,
        )
```

d) `_finish_single_player_analysis()` 里，把原来直接使用的 `_bomb_exploded_df` / `_begindefuse_df` / `_nade_batch` / `_re_df_cached` 局部变量名替换为参数名 `bomb_exploded_df` / `begindefuse_df` / `nade_batch` / `re_df_cached`（用 rename，不改逻辑）。

- [ ] **Step 3: 验证 import 和方法签名**

```
cd backend
python -c "
from app.parser.analyzer import DemoAnalyzer
import inspect
sig = inspect.signature(DemoAnalyzer.analyze_multi_players)
print('analyze_multi_players params:', list(sig.parameters.keys()))
sig2 = inspect.signature(DemoAnalyzer._finish_single_player_analysis)
print('_finish_single_player_analysis params count:', len(sig2.parameters))
print('OK')
"
```

Expected: 打印参数名，无报错。

- [ ] **Step 4: 运行测试**

```
cd backend
python -m pytest tests/ -q
```

Expected: `130 passed`

- [ ] **Step 5: Commit**

```
git add backend/app/parser/analyzer.py
git commit -m "feat: add analyze_multi_players() with shared events and unified spatial cache"
```

---

## Task 3：parse_worker.py — 新增 `analyze_batch` action

**Files:**
- Modify: `backend/app/parse_worker.py`

在 `_run()` 函数里的 `if action == "analyze":` 块之后插入新 action。

- [ ] **Step 1: 在 `parse_worker.py` 里的 `_run()` 函数中，`if action == "analyze":` 块结束后插入**

```python
    if action == "analyze_batch":
        raw_players = payload.get("target_players") or []
        if not isinstance(raw_players, list) or not raw_players:
            raise ValueError("target_players must be a non-empty list")
        target_players = [str(p).strip() for p in raw_players if str(p).strip()]
        if not target_players:
            raise ValueError("target_players contains no valid player names")
        ftd_raw = payload.get("freeze_to_death_rounds")
        ftd_list: Optional[list[int]] = None
        if ftd_raw is not None:
            if not isinstance(ftd_raw, list):
                raise ValueError("freeze_to_death_rounds must be a list of integers or null")
            ftd_list = [int(x) for x in ftd_raw]
        results = DemoAnalyzer(dem_path).analyze_multi_players(
            target_players, freeze_to_death_rounds=ftd_list
        )
        return {player: result.to_dict() for player, result in results.items()}
```

- [ ] **Step 2: 验证 parse_worker 导入正常**

```
cd backend
python -c "from app.parse_worker import _run; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```
git add backend/app/parse_worker.py
git commit -m "feat: add analyze_batch action to parse_worker"
```

---

## Task 4：demo_parse_isolation.py — 新增 `analyze_multi_isolated()`

**Files:**
- Modify: `backend/app/demo_parse_isolation.py`

在文件末尾（`analyze_demo_isolated` 函数之后）插入新函数。

- [ ] **Step 1: 先读取 `analyze_demo_isolated` 的实现，了解模式**

读 `backend/app/demo_parse_isolation.py` 确认 `analyze_demo_isolated` 函数签名和 `run_parse_worker` 调用模式。

- [ ] **Step 2: 在文件末尾插入 `analyze_multi_isolated()`**

```python
def analyze_multi_isolated(
    dem_path: str,
    target_players: list[str],
    freeze_to_death_rounds: Optional[list[int]] = None,
) -> dict[str, Any]:
    """
    在隔离子进程中对多玩家执行共享解析，返回 {player: ParseResult.to_dict()} 形式的字典。
    相比逐人调用 analyze_demo_isolated，减少约 90% 的 demo IO。
    """
    return run_parse_worker(
        "analyze_batch",
        dem_path=dem_path,
        target_players=target_players,
        freeze_to_death_rounds=freeze_to_death_rounds,
    )
```

- [ ] **Step 3: 验证**

```
cd backend
python -c "from app.demo_parse_isolation import analyze_multi_isolated; print('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```
git add backend/app/demo_parse_isolation.py
git commit -m "feat: add analyze_multi_isolated() for shared multi-player parsing"
```

---

## Task 5：main.py — `_run_library_demo_analyze` 改用批量解析

**Files:**
- Modify: `backend/app/main.py`（约第 479-563 行的 `_run_library_demo_analyze` 函数）

- [ ] **Step 1: 读取 `_run_library_demo_analyze` 函数（约第 479-563 行）确认当前代码**

当前 for 循环：
```python
    players_out: dict = {}
    try:
        from .demo_parse_isolation import IsolatedParseError

        for player in target_players:
            parsed = await asyncio.to_thread(
                _analyze_demo_sync,
                dem_path,
                player,
                freeze_to_death_rounds,
            )
            players_out[player] = parsed
    except IsolatedParseError as e:
        ...
```

- [ ] **Step 2: 将 for 循环替换为单次批量调用**

将上面的 `try` 块替换为：

```python
    players_out: dict = {}
    try:
        from .demo_parse_isolation import IsolatedParseError, analyze_multi_isolated

        batch_result = await asyncio.to_thread(
            analyze_multi_isolated,
            dem_path,
            target_players,
            freeze_to_death_rounds,
        )
        # batch_result: {player: ParseResult.to_dict()}
        players_out = {p: v for p, v in batch_result.items() if isinstance(v, dict)}
        # 验证所有请求的玩家都有结果
        missing = [p for p in target_players if p not in players_out]
        if missing:
            logger.warning(
                "analyze_multi_isolated missing players demo_id=%s missing=%s",
                demo_id, missing,
            )
    except IsolatedParseError as e:
        msg = f"Demo 解析失败：{e}"
        logger.error("Library demo parse failed demo_id=%s path=%s: %s", demo_id, dem_path, e)
        await demo_db.update_status(dem_path, "error", error_msg=msg, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, msg) from e
```

- [ ] **Step 3: 验证 main.py 导入**

```
cd backend
python -c "from app.main import app; print('import OK')"
```

Expected: `import OK`

- [ ] **Step 4: 运行完整测试**

```
cd backend
python -m pytest tests/ -q
```

Expected: `130 passed`

- [ ] **Step 5: 手工计时对比（可选但推荐）**

先用旧方式记录基线（如果有测试 demo 的话）：
```
# 在 main.py 临时 revert 到 for 循环，记录 10 人解析时间
# 然后 revert back，对比
```

- [ ] **Step 6: Commit**

```
git add backend/app/main.py
git commit -m "perf: _run_library_demo_analyze uses analyze_multi_isolated (single subprocess)"
```

---

## 自查清单

**Spec 覆盖：**
- [x] 共享事件解析（player_death/weapon_fire/hurt/bomb/equip/nade/round_end）→ Task 1 `_parse_shared_events()`
- [x] 空间快照合并（union spatial ticks → 单次 parse_ticks）→ Task 2 `analyze_multi_players()`
- [x] `analyze()` 行为不变（wrapper）→ Task 2 `_finish_single_player_analysis()`
- [x] 单子进程处理所有玩家 → Task 3 + 4 + 5
- [x] 现有测试通过 → 每个 Task 均有 pytest 验证步骤

**关键注意事项：**
1. Task 2 Step 2 中 `_finish_single_player_analysis()` 的参数命名：`bomb_exploded_df` / `begindefuse_df` / `nade_batch` / `re_df_cached` 与 `analyze()` 内部的 `_bomb_exploded_df` / `_begindefuse_df` / `_nade_batch` / `_re_df_cached` 对应，注意下划线前缀差异
2. `c4_world_cluster_keys` 在 `analyze_multi_players()` 里只计算了一次（基于共享 events），但每个玩家都需要用——正确，因为 c4 cluster 是基于全场数据的
3. `round_end_tick_map` 在 `_finish_single_player_analysis()` 里从 `re_df_cached` 派生，确保参数名一致
