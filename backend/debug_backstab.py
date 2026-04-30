"""
Debug script: 顶级智斗 detection metrics for kyxsan on mirage.
Run: cd backend && python debug_backstab.py
"""
import math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
sys.stdout.reconfigure(encoding="utf-8")  # type: ignore

from demoparser2 import DemoParser  # type: ignore

DEMO    = r"D:\code\CS2-insight-agent\cs2_demo\vitality-vs-falcons-m1-mirage.dem"
TARGET  = "kyxsan"
TICK_RATE      = 64
SNIPER_WEAPONS = {"awp", "ssg08", "g3sg1", "scar20"}

# None = 全部多杀回合；指定 round_num 集合可以缩小输出
FOCUS_ROUNDS: set[int] | None = None   # e.g. {17, 19, 21}


def adiff(a, b):
    return abs((a - b + 180) % 360 - 180)

def d2d(x1, y1, x2, y2):
    return math.hypot(x1 - x2, y1 - y2)

def get_row(snap_df, tick, name):
    s = snap_df[(snap_df["tick"] == tick)
                & (snap_df["name"].astype(str).str.strip() == name)]
    return s.iloc[0] if not s.empty else None


def main():
    parser = DemoParser(DEMO)

    # ── kills ─────────────────────────────────────────────────────────────────
    kdf = parser.parse_event(
        "player_death",
        player=["name", "X", "Y", "Z", "team_num", "yaw"],
        other=["weapon", "headshot", "thrusmoke", "penetrated",
               "total_rounds_played"],
    )
    ATK, VIC = "attacker_name", "user_name"
    ATEAM     = "attacker_team_num"

    kyxsan_kills = kdf[kdf[ATK].astype(str).str.strip() == TARGET].copy()
    kyxsan_kills["round_num"] = kyxsan_kills["total_rounds_played"].astype(int)

    # ── round scores ──────────────────────────────────────────────────────────
    re_df = parser.parse_event("round_end",
                               other=["winner", "total_rounds_played"]).sort_values("tick")

    def parse_winner(w):
        try:
            return int(float(w))
        except Exception:
            return 3 if "CT" in str(w).upper() else 2

    # kyxsan 的 team_num per round
    rnd_atk_team: dict[int, int] = {}
    for _, row in kyxsan_kills.iterrows():
        rnd = int(row["round_num"])
        try:
            rnd_atk_team[rnd] = int(float(row[ATEAM]))
        except Exception:
            pass

    own_w = opp_w = 0
    score_before: dict[int, tuple[int, int]] = {}

    for _, row in re_df.iterrows():
        rnd = int(row["total_rounds_played"])
        score_before[rnd] = (own_w, opp_w)
        winner = parse_winner(row["winner"])

        # 推断 kyxsan team_num（换边用）
        k_team = rnd_atk_team.get(rnd)
        if k_team is None:
            for r in range(rnd - 1, 0, -1):
                if r in rnd_atk_team:
                    crosses = (r <= 12) != (rnd <= 12)
                    k_team = (3 if rnd_atk_team[r] == 2 else 2) if crosses else rnd_atk_team[r]
                    break

        if k_team is not None and winner == k_team:
            own_w += 1
        else:
            opp_w += 1

    print("=== 分数表 (round_num => own:opp before round) ===")
    for r in sorted(score_before):
        o, e = score_before[r]
        k = rnd_atk_team.get(r, "?")
        print(f"  Round {r:>3}: {o}:{e}  (kyxsan_team={k})")

    # ── multi-kill rounds ─────────────────────────────────────────────────────
    mk_rounds = (
        kyxsan_kills.groupby("round_num").size()[lambda s: s >= 2].index.tolist()
    )
    print(f"\nkyxsan 多杀回合: {sorted(mk_rounds)}")
    print("(请对照前端显示分数确认回合号)\n")

    # ── per-round analysis ────────────────────────────────────────────────────
    for rnd in sorted(mk_rounds):
        if FOCUS_ROUNDS and rnd not in FOCUS_ROUNDS:
            continue

        own, opp = score_before.get(rnd, (0, 0))
        rnd_kills = kyxsan_kills[kyxsan_kills["round_num"] == rnd].sort_values("tick")
        n  = len(rnd_kills)
        ws = [str(r.get("weapon") or "") for _, r in rnd_kills.iterrows()]

        all_sniper = bool(ws) and all(w in SNIPER_WEAPONS for w in ws)
        dirty = all_sniper or any(
            bool(r.get("thrusmoke")) or int(r.get("penetrated") or 0) > 0
            for _, r in rnd_kills.iterrows()
        )

        print(f"{'='*72}")
        print(f"Round {rnd}  score_before={own}:{opp}  n={n}  weapons={ws}  dirty={dirty}")
        print(f"{'='*72}")

        kill_ticks = rnd_kills["tick"].astype(int).tolist()
        sticks = sorted(set(max(0, t + off) for t in kill_ticks for off in (0, -8, -16, -64, -128)))
        snap = parser.parse_ticks(
            ["X", "Y", "Z", "vel_z", "yaw", "name", "is_alive", "team_num"],
            ticks=sticks,
        )

        backstab_count = 0
        for _, kill in rnd_kills.iterrows():
            kt       = int(kill["tick"])
            vic_name = str(kill.get(VIC) or "").strip()
            weapon   = str(kill.get("weapon") or "")

            atk = get_row(snap, kt, TARGET)
            vic = get_row(snap, kt, vic_name)

            print(f"\n  Kill @ tick={kt}  victim={vic_name!r}  weapon={weapon}")
            if atk is None:
                print("    [SKIP] atk_row=None")
                continue
            if vic is None:
                names_at_tick = snap[snap["tick"] == kt]["name"].tolist()
                print(f"    [SKIP] vic_row=None  names_in_snap={names_at_tick}")
                continue

            ax, ay = float(atk["X"]), float(atk["Y"])
            vx, vy = float(vic["X"]),  float(vic["Y"])
            dist   = d2d(ax, ay, vx, vy)
            print(f"    atk=({ax:.0f},{ay:.0f})  vic=({vx:.0f},{vy:.0f})  dist={dist:.0f}")

            if dist >= 1200:
                print(f"    [SKIP] dist >= 1200")
                continue

            patience_ok = True
            for pw_off in (64, 128):
                pv = get_row(snap, kt - pw_off, vic_name)
                pa = get_row(snap, kt - pw_off, TARGET)
                if pv is None or pa is None:
                    print(f"    [pw={pw_off}] pv={pv is not None} pa={pa is not None} -> continue")
                    continue

                vex, vey = float(pv["X"]), float(pv["Y"])
                aex, aey = float(pa["X"]), float(pa["Y"])
                disp  = d2d(vx, vy, vex, vey)
                a_e   = math.degrees(math.atan2(vey - aey, vex - aex))
                a_k   = math.degrees(math.atan2(vy - ay, vx - ax))
                adelta = adiff(a_e, a_k)

                toward = False
                diff_m = 999.0
                if disp > 5:
                    vm  = math.degrees(math.atan2(vy - vey, vx - vex))
                    v2a = math.degrees(math.atan2(ay - vy, ax - vx))
                    diff_m = adiff(vm, v2a)
                    toward = diff_m < 45.0
                    print(f"    [pw={pw_off}] disp={disp:.0f} adelta={adelta:.1f}deg"
                          f"  vm={vm:.1f} v2a={v2a:.1f} diff_m={diff_m:.1f} toward={toward}")
                else:
                    print(f"    [pw={pw_off}] disp={disp:.0f} (static)  adelta={adelta:.1f}deg")

                patience_ok = (disp >= 100 or adelta >= 60) and not toward
                print(f"    patience_ok = (disp={disp:.0f}>=100:{disp>=100} OR adelta={adelta:.1f}>=60:{adelta>=60})"
                      f" AND not toward={toward}  => {patience_ok}")
                break

            if patience_ok:
                backstab_count += 1
                print(f"    >> BACKSTAB  count={backstab_count}")
            else:
                print(f"    >> NOT backstab")

        need   = 1 if n == 2 else 2
        tagged = not dirty and backstab_count >= need
        print(f"\n  Result: backstab={backstab_count}  need={need}  dirty={dirty}"
              f"  => {'TAGGED: 顶级智斗' if tagged else 'NOT tagged'}\n")


if __name__ == "__main__":
    main()
