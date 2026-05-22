# 官匹战绩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "官匹战绩" page that proxies Steam API to fetch Premier/Competitive match history, displays rich per-match stats, and lets the backend download + decompress Valve demo files into the demo library.

**Architecture:** New backend module `steam_match_history.py` handles all Steam API calls and demo downloading via `httpx`; three new FastAPI routes are added to `main.py`; four new AppConfig/ConfigPayload fields persist Steam credentials in the existing config JSON. The frontend adds a new page with six focused sub-components under `components/matchHistory/`, wired into the existing React Router and SidebarNav.

**Tech Stack:** Python `httpx` (async HTTP), `bz2` stdlib (decompress), FastAPI, React 19, Tailwind CSS v4, lucide-react icons, axios

---

## File Map

**Create:**
- `backend/app/steam_match_history.py` — Steam API client + demo download logic
- `backend/tests/test_steam_match_history.py` — unit tests (mock httpx)
- `frontend/src/api/matchHistoryApi.js` — axios wrappers for 3 backend endpoints
- `frontend/src/components/matchHistory/RoundsStrip.jsx` — 24-cell round result strip
- `frontend/src/components/matchHistory/DemoDownloadCell.jsx` — 3-state download button
- `frontend/src/components/matchHistory/CredentialPanel.jsx` — form / configured strip (2 states)
- `frontend/src/components/matchHistory/PlayerOverviewPanel.jsx` — player card + stats grid
- `frontend/src/components/matchHistory/MatchHistoryFilterBar.jsx` — filter bar (前端过滤)
- `frontend/src/components/matchHistory/MatchHistoryRow.jsx` — single match row (7-col grid)
- `frontend/src/pages/MatchHistoryPage.jsx` — page state hub

**Modify:**
- `backend/requirements.txt` — add `httpx>=0.27.0`
- `backend/app/env_utils.py` — add 4 fields to `AppConfig`
- `backend/app/main.py` — add `ConfigPayload` fields + 3 routes + config GET masking
- `frontend/src/components/SidebarNav.jsx` — add nav item under 工具
- `frontend/src/App.jsx` — add route + import

---

## Task 1: Add httpx dependency

**Files:**
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Add httpx to requirements**

  Open `backend/requirements.txt` and append:
  ```
  httpx>=0.27.0
  ```

- [ ] **Step 2: Install**
  ```bash
  cd backend
  uv pip install httpx>=0.27.0
  ```
  Expected: `Successfully installed httpx-...`

- [ ] **Step 3: Commit**
  ```bash
  git add backend/requirements.txt
  git commit -m "chore: add httpx for Steam API proxy"
  ```

---

## Task 2: Extend AppConfig and ConfigPayload with Steam fields

**Files:**
- Modify: `backend/app/env_utils.py` (AppConfig class, around line 394)
- Modify: `backend/app/main.py` (ConfigPayload class at line 618; GET /api/config at line 638; PUT /api/config handler)

- [ ] **Step 1: Add fields to AppConfig in `env_utils.py`**

  Find the `AppConfig` class (line 359). Add these four fields before the closing of the class (after `obs_black_scene_name`):
  ```python
  # 官匹战绩
  steam_api_key: str = ""
  steam_id64: str = ""
  match_mode: str = "premier"   # premier / competitive
  match_count: int = 20         # 20 / 50 / 100
  ```

- [ ] **Step 2: Mask steam_api_key in GET /api/config**

  In `main.py`, find `get_config()` (line 638). After `data = cfg.model_dump()`, add masking:
  ```python
  @app.get("/api/config")
  def get_config():
      cfg = load_config()
      cfg = ensure_cs2_path(cfg)
      data = cfg.model_dump()
      # mask sensitive keys
      if data.get("steam_api_key"):
          raw = data["steam_api_key"]
          data["steam_api_key"] = "****" + raw[-4:] if len(raw) >= 4 else "****"
      return data
  ```

- [ ] **Step 3: Add Steam fields to ConfigPayload in `main.py`**

  In the `ConfigPayload` class (line 618), add after `experimental`:
  ```python
  steam_api_key: Optional[str] = None
  steam_id64: Optional[str] = None
  match_mode: Optional[str] = None
  match_count: Optional[int] = None
  ```

- [ ] **Step 4: Handle Steam fields in PUT /api/config handler**

  Find the `update_config` function (line 810). Before `save_config(cfg)` (line 895), add:
  ```python
  if payload.steam_api_key is not None and not payload.steam_api_key.startswith("****"):
      cfg.steam_api_key = payload.steam_api_key.strip()
  if payload.steam_id64 is not None:
      cfg.steam_id64 = payload.steam_id64.strip()
  if payload.match_mode is not None and payload.match_mode in ("premier", "competitive"):
      cfg.match_mode = payload.match_mode
  if payload.match_count is not None and payload.match_count in (20, 50, 100):
      cfg.match_count = payload.match_count
  ```

- [ ] **Step 5: Write test**

  Create `backend/tests/test_steam_config.py`:
  ```python
  import sys
  from pathlib import Path
  sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

  from app.env_utils import AppConfig

  def test_steam_fields_defaults():
      cfg = AppConfig()
      assert cfg.steam_api_key == ""
      assert cfg.steam_id64 == ""
      assert cfg.match_mode == "premier"
      assert cfg.match_count == 20

  def test_steam_fields_from_dict():
      cfg = AppConfig(steam_api_key="ABCD1234", steam_id64="76561198012345678", match_mode="competitive", match_count=50)
      assert cfg.steam_api_key == "ABCD1234"
      assert cfg.match_mode == "competitive"
      assert cfg.match_count == 50
  ```

- [ ] **Step 6: Run tests**
  ```bash
  cd backend
  python -m pytest tests/test_steam_config.py -v
  ```
  Expected: 2 passed

- [ ] **Step 7: Commit**
  ```bash
  git add backend/app/env_utils.py backend/app/main.py backend/tests/test_steam_config.py
  git commit -m "feat(config): add Steam API key/SteamID64/match_mode/match_count fields"
  ```

---

## Task 3: Create `steam_match_history.py`

**Files:**
- Create: `backend/app/steam_match_history.py`
- Create: `backend/tests/test_steam_match_history.py`

### Background: Steam API response shape

`GET https://api.steampowered.com/ICSGOServers_730/GetMatchHistory/v001/`
Params: `key`, `steamid`, `count` (max ~16 per request), optionally `start_match_id` for pagination.

Response (abridged):
```json
{
  "result": {
    "status": 1,
    "matches": [
      {
        "matchid": "3733386468353335412",
        "matchtime": 1716217363,
        "watchablematchinfo": { "game_type": 2048 },
        "roundstatsall": [
          {
            "reservation_id": "18446744073709551615",
            "map": 3,
            "num_rounds": 22,
            "match_duration": 2280,
            "team_scores": [13, 9],
            "kills":   [24, 18, 20, 15, 19],
            "assists": [4,  2,  6,  3,  2],
            "deaths":  [14, 19, 16, 20, 15],
            "scores":  [50, 30, 45, 25, 42],
            "enemy_headshots": [12, 8, 10, 6, 9],
            "enemy_kills":     [20, 14, 17, 12, 16],
            "mvps":            [4, 1, 2, 0, 1]
          }
        ]
      }
    ]
  }
}
```

`game_type` bitmask: `2048` = Premier (CS Rating), `8` = Competitive.

Map enum → name mapping (CS2):
```
0→de_dust2, 1→de_inferno, 2→de_nuke, 3→de_vertigo,
4→de_ancient, 5→de_anubis, 6→de_mirage, 7→de_overpass
```

Demo URL: Valve CDN pattern derived from matchid and reservation_id:
`http://replay{N}.valve.net/730/{matchid}_{reservation_id}.dem.bz2`
where `N = str(int(matchid) % 10 + 131)` (empirical, may need adjustment per actual API response).

Player summary: `GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v002/?key=<K>&steamids=<ID>`

- [ ] **Step 1: Write failing tests**

  Create `backend/tests/test_steam_match_history.py`:
  ```python
  import sys, time
  from pathlib import Path
  from unittest.mock import AsyncMock, patch, MagicMock
  import pytest
  sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

  from app.steam_match_history import (
      is_demo_expired,
      demo_expires_at_iso,
      map_enum_to_name,
      game_type_to_mode,
      calc_rating,
      build_demo_url,
      parse_match_row,
  )

  def test_is_demo_expired_fresh():
      ts = int(time.time()) - 3 * 24 * 3600  # 3 days ago
      assert is_demo_expired(ts) is False

  def test_is_demo_expired_old():
      ts = int(time.time()) - 9 * 24 * 3600  # 9 days ago
      assert is_demo_expired(ts) is True

  def test_demo_expires_at_iso():
      ts = 1716217363
      result = demo_expires_at_iso(ts)
      assert result.endswith("Z")
      assert "2024" in result or "2026" in result  # sanity: it's a date

  def test_map_enum_to_name():
      assert map_enum_to_name(6) == "de_mirage"
      assert map_enum_to_name(0) == "de_dust2"
      assert map_enum_to_name(99) == "unknown"

  def test_game_type_to_mode():
      assert game_type_to_mode(2048) == "premier"
      assert game_type_to_mode(8) == "competitive"
      assert game_type_to_mode(0) == "competitive"

  def test_calc_rating_average_player():
      # 20 kills, 16 deaths, 4 assists over 22 rounds, 70 ADR
      r = calc_rating(kills=20, deaths=16, assists=4, rounds=22, damage=70 * 22)
      assert 0.8 < r < 1.5

  def test_build_demo_url():
      url = build_demo_url("3733386468353335412", "12345678901234567")
      assert url.startswith("http://replay")
      assert ".valve.net/730/" in url
      assert url.endswith(".dem.bz2")

  def test_parse_match_row_win():
      raw_match = {
          "matchid": "3733386468353335412",
          "matchtime": int(time.time()) - 3600,
          "watchablematchinfo": {"game_type": 2048},
          "roundstatsall": [{
              "reservation_id": "99999",
              "map": 6,
              "num_rounds": 22,
              "match_duration": 2280,
              "team_scores": [13, 9],
              "kills":   [24], "assists": [4], "deaths": [14],
              "enemy_headshots": [12], "enemy_kills": [20], "mvps": [4],
              "scores":  [50],
          }],
      }
      result = parse_match_row(raw_match, player_index=0)
      assert result["result"] == "win"
      assert result["map"] == "de_mirage"
      assert result["kills"] == 24
      assert result["mode"] == "premier"
      assert result["demo_expired"] is False
  ```

- [ ] **Step 2: Run tests — expect ImportError (module doesn't exist yet)**
  ```bash
  cd backend
  python -m pytest tests/test_steam_match_history.py -v 2>&1 | head -20
  ```
  Expected: `ModuleNotFoundError` or `ImportError`

- [ ] **Step 3: Implement `steam_match_history.py`**

  Create `backend/app/steam_match_history.py`:
  ```python
  """Steam Web API proxy for CS2 official match history."""
  from __future__ import annotations

  import asyncio
  import bz2
  import logging
  import time
  from datetime import datetime, timezone
  from pathlib import Path
  from typing import Optional

  import httpx

  logger = logging.getLogger(__name__)

  STEAM_API_BASE = "https://api.steampowered.com"
  _MAP_NAMES: dict[int, str] = {
      0: "de_dust2",
      1: "de_inferno",
      2: "de_nuke",
      3: "de_vertigo",
      4: "de_ancient",
      5: "de_anubis",
      6: "de_mirage",
      7: "de_overpass",
      8: "de_train",
      9: "de_cache",
  }
  _DEMO_EXPIRY_SECS = 8 * 24 * 3600
  _GAME_TYPE_PREMIER = 2048


  # ---------- pure helpers ----------

  def map_enum_to_name(enum_val: int) -> str:
      return _MAP_NAMES.get(enum_val, "unknown")


  def game_type_to_mode(game_type: int) -> str:
      return "premier" if game_type == _GAME_TYPE_PREMIER else "competitive"


  def is_demo_expired(match_time: int) -> bool:
      return (time.time() - match_time) > _DEMO_EXPIRY_SECS


  def demo_expires_at_iso(match_time: int) -> str:
      ts = match_time + _DEMO_EXPIRY_SECS
      return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


  def calc_rating(kills: int, deaths: int, assists: int, rounds: int, damage: int) -> float:
      """Simplified HLTV Rating 2.0 approximation."""
      if rounds <= 0:
          return 0.0
      kpr = kills / rounds
      dpr = deaths / rounds
      apr = assists / rounds
      adr = damage / rounds
      impact = 2.13 * kpr + 0.42 * apr - 0.41
      return round(0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587, 2)


  def build_demo_url(match_id: str, reservation_id: str) -> str:
      try:
          n = int(match_id) % 10 + 131
      except (ValueError, TypeError):
          n = 131
      return f"http://replay{n}.valve.net/730/{match_id}_{reservation_id}.dem.bz2"


  def parse_match_row(raw: dict, player_index: int = 0) -> dict:
      """Transform a single Steam API match object into our frontend-ready dict."""
      match_id = str(raw.get("matchid", ""))
      match_time = int(raw.get("matchtime", 0))
      wmi = raw.get("watchablematchinfo") or {}
      game_type = int(wmi.get("game_type", 0))
      mode = game_type_to_mode(game_type)

      rounds_all = raw.get("roundstatsall") or []
      last = rounds_all[-1] if rounds_all else {}

      map_enum = int(last.get("map", -1))
      map_name = map_enum_to_name(map_enum)
      num_rounds = int(last.get("num_rounds") or 0)
      duration_sec = int(last.get("match_duration") or 0)
      team_scores = last.get("team_scores") or [0, 0]
      score_own = int(team_scores[0]) if team_scores else 0
      score_opp = int(team_scores[1]) if len(team_scores) > 1 else 0

      if score_own > score_opp:
          result = "win"
      elif score_own < score_opp:
          result = "loss"
      else:
          result = "tie"

      def _idx(lst: list, i: int, default=0):
          try:
              return lst[i] if lst else default
          except IndexError:
              return default

      kills = _idx(last.get("kills") or [], player_index)
      assists = _idx(last.get("assists") or [], player_index)
      deaths = _idx(last.get("deaths") or [], player_index)
      hs_kills = _idx(last.get("enemy_headshots") or [], player_index)
      enemy_kills = _idx(last.get("enemy_kills") or [], player_index)
      mvps = _idx(last.get("mvps") or [], player_index)
      damage_total = _idx(last.get("damage") or [], player_index, 0)

      hs_pct = round(hs_kills / kills * 100) if kills > 0 else 0
      adr = round(damage_total / num_rounds, 1) if num_rounds > 0 else 0.0
      rating = calc_rating(kills, deaths, assists, num_rounds, damage_total)

      reservation_id = str(last.get("reservation_id") or last.get("reservationid") or "")
      demo_url = build_demo_url(match_id, reservation_id) if reservation_id else None
      expired = is_demo_expired(match_time)

      played_at = datetime.fromtimestamp(match_time, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

      rounds_strip: list[Optional[bool]] = []
      for r in rounds_all:
          ts = r.get("team_scores") or [0, 0]
          s_own = int(ts[0]) if ts else 0
          s_opp = int(ts[1]) if len(ts) > 1 else 0
          if s_own > s_opp:
              rounds_strip.append(True)
          elif s_own < s_opp:
              rounds_strip.append(False)
          else:
              rounds_strip.append(None)
      while len(rounds_strip) < 24:
          rounds_strip.append(None)
      rounds_strip = rounds_strip[:24]

      return {
          "match_id": match_id,
          "map": map_name,
          "mode": mode,
          "result": result,
          "score_own": score_own,
          "score_opp": score_opp,
          "duration_sec": duration_sec,
          "played_at": played_at,
          "rounds": rounds_strip,
          "kills": kills,
          "deaths": deaths,
          "assists": assists,
          "headshot_kills": hs_kills,
          "headshot_pct": hs_pct,
          "damage": damage_total,
          "adr": adr,
          "mvp_count": mvps,
          "rating": rating,
          "demo_url": demo_url,
          "demo_expired": expired,
          "demo_expires_at": demo_expires_at_iso(match_time) if demo_url else None,
          "demo_in_library": False,
      }


  # ---------- async API calls ----------

  async def fetch_match_history(api_key: str, steam_id64: str, count: int = 20) -> list[dict]:
      url = f"{STEAM_API_BASE}/ICSGOServers_730/GetMatchHistory/v001/"
      params = {"key": api_key, "steamid": steam_id64, "count": min(count, 100)}
      async with httpx.AsyncClient(timeout=20.0) as client:
          resp = await client.get(url, params=params)
          resp.raise_for_status()
      data = resp.json()
      result = data.get("result") or {}
      status = result.get("status")
      if status != 1:
          raise ValueError(f"Steam API status={status}")
      return result.get("matches") or []


  async def fetch_player_summary(api_key: str, steam_id64: str) -> dict:
      url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v002/"
      params = {"key": api_key, "steamids": steam_id64}
      async with httpx.AsyncClient(timeout=10.0) as client:
          resp = await client.get(url, params=params)
          resp.raise_for_status()
      players = resp.json().get("response", {}).get("players") or []
      return players[0] if players else {}


  async def download_demo(demo_url: str, dest_dir: Path, filename: str) -> Path:
      """Download a .bz2 demo and decompress into dest_dir. Returns the .dem path."""
      dest_dir.mkdir(parents=True, exist_ok=True)
      bz2_path = dest_dir / (filename + ".bz2")
      dem_path = dest_dir / filename

      if dem_path.exists():
          return dem_path

      async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
          async with client.stream("GET", demo_url) as resp:
              resp.raise_for_status()
              with open(bz2_path, "wb") as f:
                  async for chunk in resp.aiter_bytes(chunk_size=65536):
                      f.write(chunk)

      data = bz2_path.read_bytes()
      dem_path.write_bytes(bz2.decompress(data))
      bz2_path.unlink(missing_ok=True)
      return dem_path
  ```

- [ ] **Step 4: Run tests**
  ```bash
  cd backend
  python -m pytest tests/test_steam_match_history.py -v
  ```
  Expected: 8 passed

- [ ] **Step 5: Commit**
  ```bash
  git add backend/app/steam_match_history.py backend/tests/test_steam_match_history.py
  git commit -m "feat(backend): add steam_match_history module with API proxy and demo download"
  ```

---

## Task 4: Add 3 API routes in `main.py`

> **依赖顺序：** Task 4 的路由代码调用 `demo_db.find_by_filename()`，该方法在 Task 14 实现。两个 task 可并行编写，但须在 Task 15 smoke test 前都完成。

**Files:**
- Modify: `backend/app/main.py`

Add the following imports at the top of `main.py` (with other imports, around line 28):
```python
import httpx

from .steam_match_history import (
    fetch_match_history,
    fetch_player_summary,
    parse_match_row,
    download_demo,
    game_type_to_mode,
    is_demo_expired,
)
```

- [ ] **Step 1: Add the three Pydantic request models** (after `ConfigPayload`, around line 636):
  ```python
  class MatchHistoryDownloadBody(BaseModel):
      demo_url: str
      match_id: str
      filename: str  # e.g. "match730_3733386468353335412.dem"
  ```

- [ ] **Step 2: Add GET /api/match-history/matches**

  Add after the existing `/api/demos/stream` route:
  ```python
  @app.get("/api/match-history/matches")
  async def get_match_history():
      cfg = load_config()
      if not cfg.steam_api_key or not cfg.steam_id64:
          raise HTTPException(400, "Steam API Key 和 SteamID64 未配置，请先保存凭据")

      try:
          raw_matches = await fetch_match_history(cfg.steam_api_key, cfg.steam_id64, cfg.match_count)
          player = await fetch_player_summary(cfg.steam_api_key, cfg.steam_id64)
      except httpx.HTTPStatusError as e:
          status = e.response.status_code
          if status == 403:
              raise HTTPException(403, "Steam API Key 无效，请检查凭据")
          if status == 429:
              raise HTTPException(429, "Steam API 请求频率超限，请稍后再试")
          raise HTTPException(502, f"Steam API 返回 {status}")
      except httpx.RequestError as e:
          raise HTTPException(502, f"无法连接 Steam API: {e}")
      except ValueError as e:
          raise HTTPException(502, str(e))

      mode_filter = cfg.match_mode
      rows = []
      for i, m in enumerate(raw_matches):
          wmi = m.get("watchablematchinfo") or {}
          mode = game_type_to_mode(int(wmi.get("game_type", 0)))
          if mode != mode_filter:
              continue
          try:
              row = parse_match_row(m, player_index=0)
          except Exception:
              logger.exception("Failed to parse match %s", m.get("matchid"))
              continue
          # check if already in library
          dem_name = f"match730_{row['match_id']}.dem"
          in_lib = await demo_db.find_by_filename(dem_name) is not None
          row["demo_in_library"] = in_lib
          rows.append(row)

      wins = sum(1 for r in rows if r["result"] == "win")
      losses = sum(1 for r in rows if r["result"] == "loss")
      total_kills = sum(r["kills"] for r in rows)
      total_deaths = sum(r["deaths"] for r in rows)
      total_hs = sum(r["headshot_kills"] for r in rows)
      total_dmg = sum(r["damage"] for r in rows)
      total_rounds = sum(r["score_own"] + r["score_opp"] for r in rows)
      avg_kd = round(total_kills / total_deaths, 2) if total_deaths else 0.0
      hs_pct = round(total_hs / total_kills * 100) if total_kills else 0
      avg_adr = round(total_dmg / total_rounds, 1) if total_rounds else 0.0
      avg_rating = round(sum(r["rating"] for r in rows) / len(rows), 2) if rows else 0.0

      return {
          "player": {
              "name": player.get("personaname", ""),
              "avatar": player.get("avatarfull", ""),
              "steam_id64": cfg.steam_id64,
          },
          "stats_summary": {
              "wins": wins,
              "losses": losses,
              "avg_kd": avg_kd,
              "headshot_pct": hs_pct,
              "avg_adr": avg_adr,
              "rating": avg_rating,
          },
          "matches": rows,
          "total": len(rows),
      }
  ```

- [ ] **Step 3: Add POST /api/match-history/test-connection**
  ```python
  @app.post("/api/match-history/test-connection")
  async def test_steam_connection(body: dict = Body(...)):
      api_key = str(body.get("steam_api_key") or "").strip()
      steam_id64 = str(body.get("steam_id64") or "").strip()
      if not api_key or not steam_id64:
          raise HTTPException(400, "steam_api_key 和 steam_id64 不能为空")
      try:
          player = await fetch_player_summary(api_key, steam_id64)
      except httpx.HTTPStatusError as e:
          raise HTTPException(e.response.status_code, f"Steam API 返回 {e.response.status_code}")
      except httpx.RequestError as e:
          raise HTTPException(502, f"无法连接 Steam: {e}")
      if not player:
          raise HTTPException(404, "未找到该 SteamID 的玩家信息，请检查 SteamID64")
      return {"ok": True, "name": player.get("personaname", ""), "avatar": player.get("avatarfull", "")}
  ```

- [ ] **Step 4: Add POST /api/match-history/download**
  ```python
  @app.post("/api/match-history/download")
  async def download_match_demo(body: MatchHistoryDownloadBody):
      cfg = load_config()
      watch_paths = [p for p in cfg.demo_watch_paths if p.strip()]
      if not watch_paths:
          raise HTTPException(400, "未配置 Demo 库监听目录，请先在「Demo 库」设置监听路径")

      dest_dir = Path(watch_paths[0])
      filename = body.filename if body.filename.endswith(".dem") else body.filename + ".dem"
      try:
          dem_path = await download_demo(body.demo_url, dest_dir, filename)
      except httpx.HTTPStatusError as e:
          raise HTTPException(502, f"下载失败，HTTP {e.response.status_code}")
      except httpx.RequestError as e:
          raise HTTPException(502, f"下载超时或网络错误: {e}")
      except OSError as e:
          raise HTTPException(500, f"文件写入失败: {e}")
      except Exception as e:
          raise HTTPException(500, f"解压失败: {e}")

      await _enqueue_demo_path(dem_path)
      return {"ok": True, "path": str(dem_path), "filename": filename}
  ```

- [ ] **Step 5: Verify the server starts**
  ```bash
  cd backend
  uvicorn app.main:app --port 8000 --reload &
  sleep 2
  curl -s http://localhost:8000/api/match-history/matches | python -m json.tool | head -5
  ```
  Expected: `{"detail": "Steam API Key 和 SteamID64 未配置..."}`

- [ ] **Step 6: Commit**
  ```bash
  git add backend/app/main.py
  git commit -m "feat(api): add /api/match-history/* routes (matches, test-connection, download)"
  ```

---

## Task 5: Frontend API client

**Files:**
- Create: `frontend/src/api/matchHistoryApi.js`

- [ ] **Step 1: Create the file**
  ```js
  import API from "./api";

  export async function fetchMatchHistory() {
    const { data } = await API.get("/match-history/matches");
    return data;
  }

  export async function testSteamConnection(steam_api_key, steam_id64) {
    const { data } = await API.post("/match-history/test-connection", { steam_api_key, steam_id64 });
    return data;
  }

  export async function downloadMatchDemo(demo_url, match_id, filename) {
    const { data } = await API.post("/match-history/download", { demo_url, match_id, filename });
    return data;
  }

  export function saveMatchCredentials(steam_api_key, steam_id64, match_mode, match_count) {
    return API.put("/config", { steam_api_key, steam_id64, match_mode, match_count });
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/api/matchHistoryApi.js
  git commit -m "feat(frontend): add matchHistoryApi.js"
  ```

---

## Task 6: RoundsStrip component

**Files:**
- Create: `frontend/src/components/matchHistory/RoundsStrip.jsx`

- [ ] **Step 1: Create the component**

  ```jsx
  export default function RoundsStrip({ rounds = [] }) {
    const cells = [...rounds];
    while (cells.length < 24) cells.push(null);
    return (
      <div>
        <div className="mb-1 font-mono text-[10.5px] text-cs2-text-muted">逐回合走势</div>
        <div className="grid grid-cols-[repeat(24,1fr)] gap-[2px]" style={{ height: 18 }}>
          {cells.slice(0, 24).map((won, i) => (
            <div
              key={i}
              className="rounded-[1px]"
              style={{
                backgroundColor:
                  won === true ? "#2eb86a" : won === false ? "#e0556a" : "#25252c",
              }}
            />
          ))}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/RoundsStrip.jsx
  git commit -m "feat(ui): add RoundsStrip component"
  ```

---

## Task 7: DemoDownloadCell component

**Files:**
- Create: `frontend/src/components/matchHistory/DemoDownloadCell.jsx`

State: `idle | downloading | done | expired`

- [ ] **Step 1: Create the component**

  ```jsx
  import { useState } from "react";
  import { Download, Check, Ban, Loader2 } from "lucide-react";

  function fmtBytes(bytes) {
    if (!bytes) return "";
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }

  function fmtExpiry(expiresAt) {
    if (!expiresAt) return "";
    const diff = new Date(expiresAt) - Date.now();
    if (diff <= 0) return "已过期";
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    return `剩 ${days}d ${hours}h`;
  }

  export default function DemoDownloadCell({
    matchId,
    demoUrl,
    demoExpired,
    demoInLibrary,
    demoExpiresAt,
    demoSizeBytes,
    filename,
    onDownload,
    onGoToLibrary,
  }) {
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState("");

    if (demoExpired) {
      return (
        <div className="flex flex-col items-center gap-1">
          <button
            disabled
            className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border bg-transparent px-3 py-1.5 text-[12px] text-cs2-text-muted opacity-50 cursor-not-allowed"
          >
            <Ban className="h-3.5 w-3.5" />
            已过期
          </button>
          <span className="font-mono text-[10px] text-cs2-text-muted">超过 8 天保留</span>
        </div>
      );
    }

    if (demoInLibrary) {
      return (
        <div className="flex flex-col items-center gap-1">
          <button
            onClick={onGoToLibrary}
            className="flex items-center gap-1.5 rounded-[7px] border border-[#2eb86a]/40 bg-[#2eb86a]/10 px-3 py-1.5 text-[12px] font-semibold text-[#2eb86a] transition-colors hover:bg-[#2eb86a]/20"
          >
            <Check className="h-3.5 w-3.5" />
            已入库
          </button>
          <span className="font-mono text-[10px] text-cs2-text-muted">跳转解析</span>
        </div>
      );
    }

    async function handleDownload() {
      setLoading(true);
      setErr("");
      try {
        await onDownload(demoUrl, matchId, filename);
      } catch (e) {
        setErr(e?.response?.data?.detail || e?.message || "下载失败");
      } finally {
        setLoading(false);
      }
    }

    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={handleDownload}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border bg-transparent px-3 py-1.5 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent hover:text-cs2-accent disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {loading ? "下载中…" : "下载"}
        </button>
        <span className="font-mono text-[10px] text-cs2-text-muted">
          {fmtBytes(demoSizeBytes)}{demoSizeBytes && demoExpiresAt ? " · " : ""}{fmtExpiry(demoExpiresAt)}
        </span>
        {err && <span className="text-[10px] text-cs2-fail">{err}</span>}
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/DemoDownloadCell.jsx
  git commit -m "feat(ui): add DemoDownloadCell with 3 states"
  ```

---

## Task 8: CredentialPanel component

**Files:**
- Create: `frontend/src/components/matchHistory/CredentialPanel.jsx`

- [ ] **Step 1: Create the component**

  ```jsx
  import { useState } from "react";
  import { Loader2, CircleCheck } from "lucide-react";
  import { testSteamConnection, saveMatchCredentials } from "../../api/matchHistoryApi";

  const MODES = [
    { value: "premier", label: "优先排位" },
    { value: "competitive", label: "竞技" },
  ];
  const COUNTS = [20, 50, 100];

  export default function CredentialPanel({
    configured,
    maskedKey,
    steamId64,
    syncedAt,
    matchMode,
    matchCount,
    onSaved,
    onSync,
  }) {
    const [apiKey, setApiKey] = useState("");
    const [id64, setId64] = useState(steamId64 || "");
    const [mode, setMode] = useState(matchMode || "premier");
    const [count, setCount] = useState(matchCount || 20);
    const [testing, setTesting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [testErr, setTestErr] = useState("");

    async function handleTest() {
      setTesting(true);
      setTestErr("");
      setTestResult(null);
      try {
        const res = await testSteamConnection(apiKey, id64);
        setTestResult(res);
      } catch (e) {
        setTestErr(e?.response?.data?.detail || "连接失败");
      } finally {
        setTesting(false);
      }
    }

    async function handleSave() {
      setSaving(true);
      try {
        await saveMatchCredentials(apiKey || undefined, id64, mode, count);
        onSaved?.();
      } catch (e) {
        setTestErr(e?.response?.data?.detail || "保存失败");
      } finally {
        setSaving(false);
      }
    }

    if (configured) {
      return (
        <div
          className="flex items-center gap-3 rounded-[10px] border px-5 py-3"
          style={{ background: "rgba(46,184,106,0.10)", borderColor: "rgba(46,184,106,0.28)" }}
        >
          <div
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: "#2eb86a", boxShadow: "0 0 8px #2eb86a80" }}
          />
          <div className="flex-1 text-[13px]">
            <span className="font-semibold text-[#2eb86a]">凭据已生效</span>
            {maskedKey && (
              <span className="ml-2 font-mono text-[12px] text-cs2-text-secondary">
                Key: {maskedKey}
              </span>
            )}
            {steamId64 && (
              <span className="ml-2 font-mono text-[12px] text-cs2-text-secondary">
                · {steamId64}
              </span>
            )}
            {syncedAt && (
              <span className="ml-2 text-[11px] text-cs2-text-muted">· 上次同步 {syncedAt}</span>
            )}
          </div>
          <button
            onClick={onSync}
            className="rounded-[7px] border border-cs2-border px-3 py-1 text-[12px] text-cs2-text-secondary hover:text-cs2-text-primary"
          >
            同步
          </button>
        </div>
      );
    }

    return (
      <div className="rounded-[10px] border border-cs2-border bg-[#16161a] px-6 py-5">
        <div className="grid grid-cols-2 gap-x-5 gap-y-4">
          {/* API Key */}
          <div>
            <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
              Steam Web API Key
              <a
                href="https://steamcommunity.com/dev/apikey"
                target="_blank"
                rel="noreferrer"
                className="ml-2 text-cs2-accent underline"
              >
                获取
              </a>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="32 位字符串，例如 1A2B3C4D5E6F…"
              className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
            />
          </div>

          {/* SteamID64 */}
          <div>
            <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
              Steam64ID
            </label>
            <input
              type="text"
              value={id64}
              onChange={(e) => setId64(e.target.value)}
              placeholder="17 位数字，以 7656119 开头"
              className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 font-mono text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
            />
          </div>

          {/* Mode */}
          <div>
            <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
              对局模式
            </label>
            <div className="flex gap-1">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  className={`flex-1 rounded-[7px] border px-3 py-2 text-[12.5px] font-semibold transition-colors ${
                    mode === m.value
                      ? "border-cs2-accent/60 bg-cs2-accent/10 text-cs2-accent"
                      : "border-cs2-border text-cs2-text-secondary hover:text-cs2-text-primary"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Count */}
          <div>
            <label className="mb-1 block text-[12.5px] font-semibold text-cs2-text-secondary">
              每次拉取数量
            </label>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[12.5px] text-cs2-text-primary focus:border-cs2-accent focus:outline-none"
            >
              {COUNTS.map((c) => (
                <option key={c} value={c}>最近 {c} 场</option>
              ))}
            </select>
          </div>
        </div>

        {testResult && (
          <div className="mt-3 flex items-center gap-2 text-[12.5px] text-[#2eb86a]">
            <CircleCheck className="h-4 w-4" />
            连接成功 · {testResult.name}
          </div>
        )}
        {testErr && <p className="mt-2 text-[12.5px] text-cs2-fail">{testErr}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border px-4 py-2 text-[13px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-50"
          >
            {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            测试连接
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (!apiKey && !steamId64)}
            className="flex items-center gap-1.5 rounded-[7px] bg-cs2-accent px-4 py-2 text-[13px] font-semibold text-black hover:bg-cs2-accent-light disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            保存并拉取战绩
          </button>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/CredentialPanel.jsx
  git commit -m "feat(ui): add CredentialPanel with form/configured states"
  ```

---

## Task 9: PlayerOverviewPanel component

**Files:**
- Create: `frontend/src/components/matchHistory/PlayerOverviewPanel.jsx`

- [ ] **Step 1: Create the component**

  ```jsx
  const RATING_TIERS = [
    { min: 25000, label: "tier-gold",   color: "#f5c542" },
    { min: 20000, label: "tier-red",    color: "#ff5b5b" },
    { min: 15000, label: "tier-pink",   color: "#ff6ec1" },
    { min: 10000, label: "tier-purple", color: "#b478ff" },
    { min: 5000,  label: "tier-blue",   color: "#6aa9ff" },
    { min: 0,     label: "tier-gray",   color: "#9aa0a8" },
  ];

  function getRatingColor(rating) {
    return (RATING_TIERS.find((t) => rating >= t.min) || RATING_TIERS[RATING_TIERS.length - 1]).color;
  }

  function StatCol({ label, value, sub }) {
    return (
      <div className="flex flex-col items-center gap-0.5 border-r border-cs2-border last:border-r-0 px-3">
        <div className="font-mono text-[22px] font-bold text-cs2-text-primary">{value}</div>
        {sub && <div className={`font-mono text-[11px] ${sub.startsWith("+") || sub.startsWith("↑") ? "text-[#2eb86a]" : sub.startsWith("-") || sub.startsWith("↓") ? "text-[#e0556a]" : "text-cs2-text-muted"}`}>{sub}</div>}
        <div className="text-[11px] text-cs2-text-muted">{label}</div>
      </div>
    );
  }

  export default function PlayerOverviewPanel({ player, stats }) {
    if (!player) return null;
    const ratingColor = getRatingColor(player.cs_rating || 0);

    return (
      <div className="grid gap-3.5" style={{ gridTemplateColumns: "340px 1fr" }}>
        {/* Player Card */}
        <div className="rounded-[10px] border border-cs2-border bg-cs2-bg-card p-4 flex items-start gap-3">
          <div className="relative shrink-0">
            {player.avatar ? (
              <img
                src={player.avatar}
                alt={player.name}
                className="h-16 w-16 rounded-lg object-cover"
              />
            ) : (
              <div className="h-16 w-16 rounded-lg bg-cs2-bg-elevated flex items-center justify-center text-2xl font-bold text-cs2-text-muted">
                {(player.name || "?")[0].toUpperCase()}
              </div>
            )}
            <div className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-cs2-bg-card bg-[#2eb86a]" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] font-semibold text-cs2-text-primary">{player.name}</div>

            {player.cs_rating > 0 && (
              <div
                className="mt-1 inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-0.5 font-mono text-[11px] font-bold"
                style={{ color: ratingColor, borderColor: ratingColor + "40", background: ratingColor + "18" }}
              >
                CS RATING &nbsp;
                {player.cs_rating.toLocaleString()}
                {player.cs_rating_delta != null && (
                  <span style={{ color: player.cs_rating_delta >= 0 ? "#2eb86a" : "#e0556a" }}>
                    {player.cs_rating_delta >= 0 ? " ▲" : " ▼"} {Math.abs(player.cs_rating_delta)}
                  </span>
                )}
              </div>
            )}

            {player.steam_id64 && (
              <div className="mt-1.5 font-mono text-[10px] text-cs2-text-muted">{player.steam_id64}</div>
            )}
          </div>
        </div>

        {/* Stats Card */}
        <div className="rounded-[10px] border border-cs2-border bg-cs2-bg-card flex items-center">
          {stats && (
            <div className="flex w-full divide-x divide-cs2-border">
              <StatCol label={`最近 ${(stats.wins || 0) + (stats.losses || 0)} 场`} value={`${stats.wins}胜/${stats.losses}负`} />
              <StatCol label="场均 K/D" value={stats.avg_kd} sub={stats.avg_kd >= 1.2 ? "↑ 优秀" : stats.avg_kd < 0.95 ? "↓ 偏低" : undefined} />
              <StatCol label="爆头率" value={`${stats.headshot_pct}%`} />
              <StatCol label="场均伤害 ADR" value={stats.avg_adr} />
              <StatCol label="综合评分" value={stats.rating}
                sub={stats.rating >= 1.2 ? "↑ 优秀" : stats.rating < 0.95 ? "↓ 偏低" : undefined} />
            </div>
          )}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/PlayerOverviewPanel.jsx
  git commit -m "feat(ui): add PlayerOverviewPanel with CS Rating color tiers"
  ```

---

## Task 10: MatchHistoryFilterBar component

**Files:**
- Create: `frontend/src/components/matchHistory/MatchHistoryFilterBar.jsx`

- [ ] **Step 1: Create the component**

  ```jsx
  import { LayoutGrid, List, Download } from "lucide-react";

  const MAPS = ["全部地图", "de_mirage", "de_inferno", "de_dust2", "de_nuke", "de_ancient", "de_vertigo", "de_anubis", "de_overpass"];
  const RESULTS = ["全部结果", "win", "loss", "tie"];
  const RESULT_LABELS = { "全部结果": "全部结果", win: "胜", loss: "负", tie: "平" };
  const TIMES = ["全部时间", "近 7 天", "近 30 天"];
  const MODES = [
    { value: "all", label: "全部" },
    { value: "premier", label: "优先排位" },
    { value: "competitive", label: "竞技" },
  ];

  function Sel({ value, onChange, options, labels }) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[7px] border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[12.5px] text-cs2-text-primary focus:border-cs2-accent focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>{labels?.[o] ?? o}</option>
        ))}
      </select>
    );
  }

  export default function MatchHistoryFilterBar({ filters, onFiltersChange, viewMode, onViewModeChange, onExportCsv }) {
    function set(key, val) {
      onFiltersChange({ ...filters, [key]: val });
    }

    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={filters.search}
          onChange={(e) => set("search", e.target.value)}
          placeholder="搜索 Match ID / 备注…"
          className="min-w-[220px] rounded-[7px] border border-cs2-border bg-cs2-bg-input px-3 py-1.5 text-[12.5px] text-cs2-text-primary placeholder:text-cs2-text-muted focus:border-cs2-accent focus:outline-none"
        />
        <Sel value={filters.map} onChange={(v) => set("map", v)} options={MAPS} />
        <Sel value={filters.result} onChange={(v) => set("result", v)} options={RESULTS} labels={RESULT_LABELS} />
        <Sel value={filters.time} onChange={(v) => set("time", v)} options={TIMES} />

        <div className="ml-auto flex items-center gap-2">
          {/* Mode tabs */}
          <div className="flex rounded-[7px] border border-cs2-border overflow-hidden">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => set("mode", m.value)}
                className={`px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                  filters.mode === m.value
                    ? "bg-cs2-accent text-black"
                    : "text-cs2-text-secondary hover:text-cs2-text-primary"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <div className="flex rounded-[7px] border border-cs2-border overflow-hidden">
            {[["list", <List className="h-4 w-4" key="l" />], ["grid", <LayoutGrid className="h-4 w-4" key="g" />]].map(([v, icon]) => (
              <button
                key={v}
                onClick={() => onViewModeChange(v)}
                className={`px-2.5 py-1.5 transition-colors ${viewMode === v ? "bg-cs2-accent text-black" : "text-cs2-text-secondary hover:text-cs2-text-primary"}`}
              >
                {icon}
              </button>
            ))}
          </div>

          <button
            onClick={onExportCsv}
            className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border px-3 py-1.5 text-[12.5px] text-cs2-text-secondary hover:text-cs2-text-primary"
          >
            <Download className="h-3.5 w-3.5" />
            导出 CSV
          </button>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/MatchHistoryFilterBar.jsx
  git commit -m "feat(ui): add MatchHistoryFilterBar"
  ```

---

## Task 11: MatchHistoryRow component

**Files:**
- Create: `frontend/src/components/matchHistory/MatchHistoryRow.jsx`

- [ ] **Step 1: Create the component**

  ```jsx
  import { Clock, Calendar } from "lucide-react";
  import RoundsStrip from "./RoundsStrip";
  import DemoDownloadCell from "./DemoDownloadCell";

  const MAP_THUMB = {
    de_mirage: "https://cs2.tools/map-images/mirage.jpg",
    de_inferno: "https://cs2.tools/map-images/inferno.jpg",
    de_dust2: "https://cs2.tools/map-images/dust2.jpg",
    de_nuke: "https://cs2.tools/map-images/nuke.jpg",
    de_ancient: "https://cs2.tools/map-images/ancient.jpg",
    de_anubis: "https://cs2.tools/map-images/anubis.jpg",
    de_vertigo: "https://cs2.tools/map-images/vertigo.jpg",
    de_overpass: "https://cs2.tools/map-images/overpass.jpg",
  };

  const RESULT_STYLE = {
    win:  { bar: "#2eb86a", badge: "bg-[#2eb86a]/15 text-[#2eb86a]", label: "胜" },
    loss: { bar: "#e0556a", badge: "bg-[#e0556a]/15 text-[#e0556a]", label: "负" },
    tie:  { bar: "#d97706", badge: "bg-[#d97706]/15 text-[#d97706]", label: "平" },
  };

  const MODE_LABEL = { premier: "优先排位", competitive: "竞技模式" };

  function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    return `${m} 分钟`;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${yy}/${mm}/${dd} ${hh}:${min}`;
  }

  function ratingColor(r) {
    if (r >= 1.2) return "#2eb86a";
    if (r < 0.95) return "#e0556a";
    return undefined;
  }

  function kdColor(k, d) {
    const kd = d > 0 ? k / d : k;
    if (kd >= 1.2) return "text-[#2eb86a]";
    if (kd < 0.95) return "text-[#e0556a]";
    return "text-cs2-text-primary";
  }

  export default function MatchHistoryRow({ match, onDownload, onGoToLibrary }) {
    const style = RESULT_STYLE[match.result] || RESULT_STYLE.tie;
    const thumb = MAP_THUMB[match.map];
    const demoFilename = `match730_${match.match_id}.dem`;
    const scoreColor = style.bar;

    return (
      <div
        className="grid items-center rounded-[10px] border border-cs2-border bg-cs2-bg-card overflow-hidden"
        style={{ gridTemplateColumns: "4px 116px 1fr 240px 200px 130px 120px" }}
      >
        {/* Col 1: result bar */}
        <div className="self-stretch" style={{ backgroundColor: style.bar }} />

        {/* Col 2: map */}
        <div className="flex flex-col items-center gap-1 p-2">
          {thumb ? (
            <img src={thumb} alt={match.map} className="h-14 w-[92px] rounded-[5px] object-cover" />
          ) : (
            <div className="flex h-14 w-[92px] items-center justify-center rounded-[5px] bg-cs2-bg-elevated text-[10px] text-cs2-text-muted">
              {match.map}
            </div>
          )}
          <div className="text-center text-[14.5px] font-semibold text-cs2-text-primary leading-none">
            {match.map.replace("de_", "")}
          </div>
          <div className="font-mono text-[11.5px] uppercase text-cs2-text-muted">
            {MODE_LABEL[match.mode] || match.mode}
          </div>
        </div>

        {/* Col 3: score + meta */}
        <div className="flex flex-col gap-1.5 px-3 py-3">
          <div className={`inline-flex w-fit items-center rounded-[4px] px-2 py-0.5 text-[12px] font-bold ${style.badge}`}>
            {style.label}
          </div>
          <div className="font-mono text-[17px] font-bold">
            <span style={{ color: scoreColor }}>{match.score_own}</span>
            <span className="mx-1 text-cs2-text-muted">:</span>
            <span className="text-cs2-text-primary">{match.score_opp}</span>
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-cs2-text-muted">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtDuration(match.duration_sec)}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              {fmtDate(match.played_at)}
            </span>
          </div>
        </div>

        {/* Col 4: rounds strip */}
        <div className="px-3 py-3">
          <RoundsStrip rounds={match.rounds} />
        </div>

        {/* Col 5: personal stats */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3 py-3">
          <div>
            <div className="text-[10.5px] text-cs2-text-muted">击杀·阵亡·助攻</div>
            <div className={`font-mono text-[13px] font-semibold ${kdColor(match.kills, match.deaths)}`}>
              {match.kills}–{match.deaths}–{match.assists}
            </div>
          </div>
          <div>
            <div className="text-[10.5px] text-cs2-text-muted">爆头率</div>
            <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.headshot_pct}%</div>
          </div>
          <div>
            <div className="text-[10.5px] text-cs2-text-muted">场均伤害</div>
            <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.adr}</div>
          </div>
          <div>
            <div className="text-[10.5px] text-cs2-text-muted">MVP</div>
            <div className="font-mono text-[13px] font-semibold text-cs2-text-primary">{match.mvp_count}</div>
          </div>
        </div>

        {/* Col 6: rating + badges */}
        <div className="flex flex-col items-center gap-1.5 px-2 py-3">
          <div className="text-[10.5px] text-cs2-text-muted">综合评分</div>
          <div className="font-mono text-[20px] font-bold" style={{ color: ratingColor(match.rating) }}>
            {match.rating}
          </div>
          <div className="flex flex-wrap justify-center gap-1">
            {match.ace_count > 0 && (
              <span className="rounded-[4px] bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-blue-400">
                五杀×{match.ace_count}
              </span>
            )}
            {match.mvp_count >= 4 && (
              <span className="rounded-[4px] bg-[#2eb86a]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#2eb86a]">
                MVP×{match.mvp_count}
              </span>
            )}
          </div>
        </div>

        {/* Col 7: demo download */}
        <div className="flex items-center justify-center px-2 py-3">
          <DemoDownloadCell
            matchId={match.match_id}
            demoUrl={match.demo_url}
            demoExpired={match.demo_expired}
            demoInLibrary={match.demo_in_library}
            demoExpiresAt={match.demo_expires_at}
            filename={demoFilename}
            onDownload={onDownload}
            onGoToLibrary={() => onGoToLibrary(match.match_id)}
          />
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/components/matchHistory/MatchHistoryRow.jsx
  git commit -m "feat(ui): add MatchHistoryRow with 7-column grid layout"
  ```

---

## Task 12: MatchHistoryPage (main page)

**Files:**
- Create: `frontend/src/pages/MatchHistoryPage.jsx`

- [ ] **Step 1: Create the page**

  ```jsx
  import { useState, useEffect, useCallback } from "react";
  import { useNavigate } from "react-router-dom";
  import { Trophy, RefreshCw, Download, Info, Loader2 } from "lucide-react";
  import { fetchMatchHistory, downloadMatchDemo, saveMatchCredentials } from "../api/matchHistoryApi";
  import CredentialPanel from "../components/matchHistory/CredentialPanel";
  import PlayerOverviewPanel from "../components/matchHistory/PlayerOverviewPanel";
  import MatchHistoryFilterBar from "../components/matchHistory/MatchHistoryFilterBar";
  import MatchHistoryRow from "../components/matchHistory/MatchHistoryRow";
  import API from "../api/api";

  const PAGE_SIZE = 20;

  const DEFAULT_FILTERS = { search: "", map: "全部地图", result: "全部结果", time: "全部时间", mode: "all" };

  function applyFilters(matches, filters) {
    return matches.filter((m) => {
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!m.match_id.includes(q)) return false;
      }
      if (filters.map !== "全部地图" && m.map !== filters.map) return false;
      if (filters.result !== "全部结果" && m.result !== filters.result) return false;
      if (filters.mode !== "all" && m.mode !== filters.mode) return false;
      if (filters.time !== "全部时间") {
        const days = filters.time === "近 7 天" ? 7 : 30;
        const cutoff = Date.now() - days * 86400000;
        if (new Date(m.played_at).getTime() < cutoff) return false;
      }
      return true;
    });
  }

  function exportCsv(matches) {
    const cols = ["match_id","map","mode","result","score_own","score_opp","kills","deaths","assists","headshot_pct","adr","rating","played_at"];
    const rows = [cols.join(","), ...matches.map((m) => cols.map((c) => m[c] ?? "").join(","))];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "match_history.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  export default function MatchHistoryPage() {
    const navigate = useNavigate();
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState(null);
    const [err, setErr] = useState("");
    const [credOpen, setCredOpen] = useState(false);
    const [filters, setFilters] = useState(DEFAULT_FILTERS);
    const [viewMode, setViewMode] = useState("list");
    const [page, setPage] = useState(1);
    const [localLibrary, setLocalLibrary] = useState({});  // match_id → true when just downloaded

    useEffect(() => {
      API.get("/config").then(({ data: cfg }) => {
        setConfig(cfg);
        if (cfg.steam_api_key && cfg.steam_id64) {
          doFetch();
        } else {
          setCredOpen(true);
        }
      }).catch(() => setCredOpen(true));
    }, []);

    const doFetch = useCallback(async () => {
      setLoading(true);
      setErr("");
      try {
        const res = await fetchMatchHistory();
        setData(res);
        setCredOpen(false);
      } catch (e) {
        setErr(e?.response?.data?.detail || "拉取战绩失败，请检查凭据或网络");
      } finally {
        setLoading(false);
      }
    }, []);

    async function handleCredSaved() {
      const { data: cfg } = await API.get("/config");
      setConfig(cfg);
      doFetch();
    }

    async function handleDownload(demoUrl, matchId, filename) {
      await downloadMatchDemo(demoUrl, matchId, filename);
      setLocalLibrary((prev) => ({ ...prev, [matchId]: true }));
    }

    function handleGoToLibrary() {
      navigate("/library");
    }

    const allMatches = data?.matches ?? [];
    const filtered = applyFilters(allMatches, filters).map((m) => ({
      ...m,
      demo_in_library: m.demo_in_library || !!localLibrary[m.match_id],
    }));

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const pageMatches = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const configured = !!(config?.steam_api_key);

    return (
      <div className="flex flex-col gap-5 p-7">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-semibold text-cs2-text-primary">
              <Trophy className="h-6 w-6 text-cs2-accent" />
              官匹战绩
            </h1>
            <p className="mt-0.5 text-[13.5px] text-cs2-text-secondary">
              通过 Steam Web API 拉取官方匹配（优先排位 / 竞技）战绩，可直接下载官方 Demo 进入「Demo 库」解析。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCredOpen((v) => !v)}
              className="rounded-[7px] border border-cs2-border px-3 py-1.5 text-[13px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary"
            >
              编辑凭据
            </button>
            <button
              onClick={doFetch}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-[7px] border border-cs2-border px-3 py-1.5 text-[13px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              刷新战绩
            </button>
            <button className="flex items-center gap-1.5 rounded-[7px] bg-cs2-accent px-3 py-1.5 text-[13px] font-semibold text-black hover:bg-cs2-accent-light">
              <Download className="h-3.5 w-3.5" />
              下载选中 Demo
            </button>
          </div>
        </div>

        {/* Demo retention notice */}
        <div
          className="flex items-start gap-3 rounded-[10px] border px-4 py-3 text-[13px]"
          style={{ background: "rgba(56,178,196,0.08)", borderColor: "rgba(56,178,196,0.25)", color: "#a5f3fc" }}
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#38b2c4]" />
          <span>
            <strong className="text-[#38b2c4]">关于 Demo 保留期：</strong>
            Valve 官方匹配 Demo 一般保留 <strong>8 天</strong>（赛后开始计算）。超过保留期的对局会显示「已过期」，无法下载——若需要历史 Demo，请尽早入库。
          </span>
        </div>

        {/* Credential panel (shown when credOpen OR not configured) */}
        {(credOpen || !configured) && (
          <CredentialPanel
            configured={configured && !credOpen}
            maskedKey={config?.steam_api_key}
            steamId64={config?.steam_id64}
            matchMode={config?.match_mode}
            matchCount={config?.match_count}
            onSaved={handleCredSaved}
            onSync={doFetch}
          />
        )}

        {/* Player overview */}
        {data?.player && (
          <PlayerOverviewPanel player={data.player} stats={data.stats_summary} />
        )}

        {/* Error */}
        {err && (
          <div className="rounded-[10px] border border-cs2-fail/30 bg-cs2-fail/10 px-4 py-3 text-[13px] text-cs2-fail">
            {err}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="flex items-center justify-center gap-3 py-20 text-cs2-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
            正在从 Steam 拉取战绩…
          </div>
        )}

        {/* Match list */}
        {data && !loading && (
          <>
            <MatchHistoryFilterBar
              filters={filters}
              onFiltersChange={(f) => { setFilters(f); setPage(1); }}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onExportCsv={() => exportCsv(filtered)}
            />

            <div className="flex flex-col gap-2.5">
              {pageMatches.length === 0 ? (
                <div className="py-16 text-center text-cs2-text-muted">没有符合条件的战绩</div>
              ) : (
                pageMatches.map((m) => (
                  <MatchHistoryRow
                    key={m.match_id}
                    match={m}
                    onDownload={handleDownload}
                    onGoToLibrary={handleGoToLibrary}
                  />
                ))
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between text-[12.5px] text-cs2-text-muted">
                <span>显示 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} 共 {filtered.length} 场</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className="px-2 py-1 disabled:opacity-30">‹</button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`min-w-[28px] rounded px-2 py-1 ${p === page ? "bg-cs2-accent text-black font-bold" : "hover:text-cs2-text-primary"}`}
                    >
                      {p}
                    </button>
                  ))}
                  <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className="px-2 py-1 disabled:opacity-30">›</button>
                </div>
                <span>每页 {PAGE_SIZE} 条</span>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 2: Commit**
  ```bash
  git add frontend/src/pages/MatchHistoryPage.jsx
  git commit -m "feat(page): add MatchHistoryPage"
  ```

---

## Task 13: Wire up routing and navigation

**Files:**
- Modify: `frontend/src/components/SidebarNav.jsx`
- Modify: `frontend/src/App.jsx`

- [ ] **Step 1: Add nav item to SidebarNav**

  In `SidebarNav.jsx`, add `Trophy` to the lucide-react imports:
  ```js
  import { ..., Trophy } from "lucide-react";
  ```

  After the `Gamepad2` NavLink (line 96), add:
  ```jsx
  <NavLink to="/match-history" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
    <Trophy className="h-4 w-4 shrink-0 opacity-90" />
    <span className="flex min-w-0 flex-1 items-center justify-between gap-1">
      官匹战绩
      <span className="rounded bg-cs2-accent/20 px-1 font-mono text-[9px] text-cs2-accent">新</span>
    </span>
  </NavLink>
  ```

- [ ] **Step 2: Add route to App.jsx**

  In `App.jsx`, add import at the top with other page imports:
  ```js
  import MatchHistoryPage from "./pages/MatchHistoryPage";
  ```

  In the `<Routes>` block (line 2378), add before the catch-all:
  ```jsx
  <Route path="/match-history" element={<MatchHistoryPage />} />
  ```

- [ ] **Step 3: Commit**
  ```bash
  git add frontend/src/components/SidebarNav.jsx frontend/src/App.jsx
  git commit -m "feat: wire /match-history route and sidebar nav entry"
  ```

---

## Task 14: Add demo_db.find_by_filename helper

**Files:**
- Modify: `backend/app/demo_db.py`

The route in Task 4 calls `demo_db.find_by_filename(dem_name)`. This method needs to exist.

- [ ] **Step 1: Check if method exists**
  ```bash
  grep -n "find_by_filename\|async def find" backend/app/demo_db.py
  ```

- [ ] **Step 2: If it does NOT exist, add it**

  Open `demo_db.py` and find the `DemoDB` class. Add this method:
  ```python
  async def find_by_filename(self, filename: str) -> Optional[dict]:
      """Return the demo_files row for the given filename, or None."""
      async with aiosqlite.connect(self._db_path) as db:
          db.row_factory = aiosqlite.Row
          async with db.execute(
              "SELECT * FROM demo_files WHERE filename = ? LIMIT 1", (filename,)
          ) as cur:
              row = await cur.fetchone()
      return dict(row) if row else None
  ```

- [ ] **Step 3: Run existing demo_db tests**
  ```bash
  cd backend
  python -m pytest tests/ -k "demo" -v 2>&1 | tail -15
  ```
  Expected: all pass

- [ ] **Step 4: Commit**
  ```bash
  git add backend/app/demo_db.py
  git commit -m "feat(demo_db): add find_by_filename helper for match history"
  ```

---

## Task 15: End-to-end smoke test

- [ ] **Step 1: Start backend**
  ```bash
  cd backend
  uvicorn app.main:app --port 8000 --reload
  ```

- [ ] **Step 2: Start frontend**
  ```bash
  cd frontend
  npm run dev
  ```

- [ ] **Step 3: Manual verification checklist**
  - Open http://localhost:5173/match-history
  - Sidebar shows「官匹战绩」with「新」badge under 工具
  - Page shows Demo 保留期提示条
  - With no credentials: form shows automatically
  - Fill in a real API Key + SteamID64 → click「测试连接」→ shows player name
  - Click「保存并拉取战绩」→ player overview appears, match list loads
  - Verify CS Rating badge renders in correct color
  - Verify RoundsStrip shows green/red cells
  - Verify Demo 下载 buttons show correct states (可下载 / 已过期)
  - Click「编辑凭据」→ form reopens
  - Filters work client-side (map / result / time / mode)
  - Pagination renders if > 20 matches
  - Click「导出 CSV」→ file downloads

- [ ] **Step 4: Final commit**
  ```bash
  git add -A
  git commit -m "feat: official match history page - complete implementation"
  ```
