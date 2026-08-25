"""cs数据图 HTTP 接口测试（卡片生成 / 列表 / 头像上传 / 图片服务）。"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.features.cs_data_radar.api import router

_PLAYERS = [
    {
        "player_key": "sid:76561198000000001",
        "name": "Donk",
        "display_name": "Donk",
        "steam_id64": "76561198000000001",
        "team_key": "2",
        "team_label": "T",
        "kills": 28,
        "deaths": 12,
        "assists": 7,
        "kpr": 0.99,
        "dpr": 0.42,
        "adr": 101.4,
        "kast": 78.2,
        "survival_rate": 34.0,
    },
    {
        "player_key": "sid:76561198000000002",
        "name": "ZywOo",
        "display_name": "ZywOo",
        "steam_id64": "76561198000000002",
        "team_key": "3",
        "team_label": "CT",
        "kills": 20,
        "deaths": 15,
        "assists": 9,
        "kpr": 0.71,
        "dpr": 0.53,
        "adr": 88.1,
        "kast": 71.5,
        "survival_rate": 40.0,
    },
]

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 128


def _make_client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_create_and_list_cards(monkeypatch, tmp_path):
    client = _make_client(monkeypatch, tmp_path)
    resp = client.post("/api/cs-data-radar/cards", json={"demo_id": 3, "demo_name": "g.dem", "players": _PLAYERS})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count"] == 2
    cards = body["cards"]
    for card in cards:
        assert card["image_path"]
        assert card["image_url"].startswith("/api/cs-data-radar/images/")
        assert set(card["radar"].keys()) == {"kpr", "survival_rate", "adr", "kast", "multi_kill", "rating"}

    listed = client.get("/api/cs-data-radar/cards").json()
    assert listed["count"] == 2


def test_generate_alias_and_serve_image(monkeypatch, tmp_path):
    client = _make_client(monkeypatch, tmp_path)
    resp = client.post("/api/cs-data-radar/generate", json={"players": _PLAYERS[:1]})
    assert resp.status_code == 200
    card = resp.json()["cards"][0]
    filename = card["image_url"].rsplit("/", 1)[-1]
    img = client.get(f"/api/cs-data-radar/images/{filename}")
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"


def test_portrait_upload(monkeypatch, tmp_path):
    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": _PLAYERS[:1]}).json()["cards"][0]
    card_id = created["id"]
    resp = client.post(
        f"/api/cs-data-radar/cards/{card_id}/portrait",
        files={"file": ("p.png", _PNG, "image/png")},
    )
    assert resp.status_code == 200
    assert resp.json()["portrait_file"]

    # 再渲染后成品图仍然可访问
    filename = resp.json()["image_url"].rsplit("/", 1)[-1]
    assert client.get(f"/api/cs-data-radar/images/{filename}").status_code == 200

    # 不存在的卡片 → 404
    missing = client.post(
        "/api/cs-data-radar/cards/missing/portrait",
        files={"file": ("p.png", _PNG, "image/png")},
    )
    assert missing.status_code == 404


def test_delete_card(monkeypatch, tmp_path):
    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": _PLAYERS}).json()["cards"]
    first = created[0]["id"]
    assert client.delete(f"/api/cs-data-radar/cards/{first}").status_code == 200
    assert client.get("/api/cs-data-radar/cards").json()["count"] == 1
    assert client.delete(f"/api/cs-data-radar/cards/{first}").status_code == 404


def test_create_requires_players(monkeypatch, tmp_path):
    client = _make_client(monkeypatch, tmp_path)
    resp = client.post("/api/cs-data-radar/cards", json={"players": []})
    assert resp.status_code == 400


def test_multi_kill_rounds_flow_through(monkeypatch, tmp_path):
    """two_kill_rounds 等多余字段应保留并参与 Multi-kill（多杀回合）计算。"""
    client = _make_client(monkeypatch, tmp_path)
    players = [
        {
            "player_key": "sid:76561198000000009",
            "name": "Frag",
            "display_name": "Frag",
            "team_key": "2",
            "team_label": "T",
            "kills": 26,
            "deaths": 13,
            "assists": 6,
            "kpr": 0.9,
            "dpr": 0.45,
            "adr": 96.0,
            "kast": 80.0,
            "survival_rate": 40.0,
            "two_kill_rounds": 7,
            "three_kill_rounds": 2,
            "rounds": 29,
        }
    ]
    resp = client.post("/api/cs-data-radar/cards", json={"players": players})
    assert resp.status_code == 200
    card = resp.json()["cards"][0]
    assert abs(card["radar"]["multi_kill"] - round((7 + 2) / 29, 2)) < 1e-9
    assert card["match_avg"]["multi_kill"] >= 0


def test_animation_endpoint_falls_back_without_ffmpeg(monkeypatch, tmp_path):
    """FFmpeg 不可用（或生成失败）时，动画接口返回静态卡（video_url 为空），不报错。"""
    import app.features.cs_data_radar.api as radar_api

    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": [{
        "player_key": "sid:76561198000000011",
        "name": "Anim",
        "display_name": "Anim",
        "team_key": "3",
        "team_label": "CT",
        "kills": 26, "deaths": 13, "assists": 6,
        "kpr": 0.9, "dpr": 0.45, "adr": 96.0, "kast": 80.0, "survival_rate": 40.0,
    }]}).json()["cards"][0]

    monkeypatch.setattr(radar_api, "_resolve_ffmpeg_or_none", lambda cfg: None)
    resp = client.post(f"/api/cs-data-radar/cards/{created['id']}/animation")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == created["id"]
    assert not body.get("video_url")  # 回退为静态卡

    # 卡片不存在 → 404
    assert client.post("/api/cs-data-radar/cards/missing/animation").status_code == 404


def _seed_existing_video(monkeypatch, tmp_path, card_id) -> None:
    """模拟该卡片已生成过开场动画（index 里写入 video_file + 磁盘假 mp4）。"""
    from app.features.cs_data_radar import store as radar_store

    index = radar_store._read_index()
    for card in index.get("cards", []):
        if str(card.get("id")) == str(card_id):
            card["video_file"] = f"animations/{card_id}.mp4"
            break
    radar_store._write_index(index)
    anim_dir = radar_store.get_data_dir() / "animations"
    anim_dir.mkdir(parents=True, exist_ok=True)
    (anim_dir / f"{card_id}.mp4").write_bytes(b"FAKE-MP4")


def test_portrait_reupload_regenerates_video(monkeypatch, tmp_path):
    """修复问题4：上传错误头像生成视频后，重传正确头像应自动重新生成动画。"""
    from pathlib import Path

    import app.features.cs_data_radar.api as radar_api

    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": [{
        "player_key": "sid:76561198000000012",
        "name": "ReUpload",
        "display_name": "ReUpload",
        "team_key": "3",
        "team_label": "CT",
        "kills": 26, "deaths": 13, "assists": 6,
        "kpr": 0.9, "dpr": 0.45, "adr": 96.0, "kast": 80.0, "survival_rate": 40.0,
    }]}).json()["cards"][0]
    card_id = created["id"]
    _seed_existing_video(monkeypatch, tmp_path, card_id)

    calls: list[str] = []

    def fake_generate(cid, ffmpeg_bin, workers=None):
        calls.append(str(cid))
        return {**created, "video_url": "/api/cs-data-radar/videos/x.mp4"}

    monkeypatch.setattr(radar_api, "generate_card_animation", fake_generate)
    monkeypatch.setattr(radar_api, "_resolve_ffmpeg_or_none", lambda cfg: Path("ffmpeg"))

    resp = client.post(
        f"/api/cs-data-radar/cards/{card_id}/portrait",
        files={"file": ("p.png", _PNG, "image/png")},
    )
    assert resp.status_code == 200
    assert calls == [card_id]  # 原本有动画 → 头像变化后自动重新生成


def test_portrait_reupload_clears_stale_video_without_ffmpeg(monkeypatch, tmp_path):
    """没有 FFmpeg 时，头像变化后旧动画必须被清除（回退静态图），不能继续用旧头像的视频。"""
    import app.features.cs_data_radar.api as radar_api
    from app.features.cs_data_radar import store as radar_store

    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": [{
        "player_key": "sid:76561198000000013",
        "name": "NoFfmpeg",
        "display_name": "NoFfmpeg",
        "team_key": "2",
        "team_label": "T",
        "kills": 26, "deaths": 13, "assists": 6,
        "kpr": 0.9, "dpr": 0.45, "adr": 96.0, "kast": 80.0, "survival_rate": 40.0,
    }]}).json()["cards"][0]
    card_id = created["id"]
    _seed_existing_video(monkeypatch, tmp_path, card_id)

    monkeypatch.setattr(radar_api, "_resolve_ffmpeg_or_none", lambda cfg: None)
    resp = client.post(
        f"/api/cs-data-radar/cards/{card_id}/portrait",
        files={"file": ("p.png", _PNG, "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert not body.get("video_url")  # 旧动画已失效
    stale = radar_store.get_data_dir() / "animations" / f"{card_id}.mp4"
    assert not stale.exists()  # 旧 mp4 已删除


def test_team_logo_upload_and_clear(monkeypatch, tmp_path):
    """上传/清除队标端点：返回 team_logo_url，图片可访问，清除后置空。"""
    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": [_PLAYERS[0]]}).json()["cards"][0]
    card_id = created["id"]

    resp = client.post(
        f"/api/cs-data-radar/cards/{card_id}/team-logo",
        files={"file": ("logo.png", _PNG, "image/png")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["team_logo_file"]
    assert body["team_logo_url"].startswith("/api/cs-data-radar/images/")
    filename = body["team_logo_url"].rsplit("/", 1)[-1]
    assert client.get(f"/api/cs-data-radar/images/{filename}").status_code == 200

    cleared = client.delete(f"/api/cs-data-radar/cards/{card_id}/team-logo")
    assert cleared.status_code == 200
    assert not cleared.json().get("team_logo_file")

    missing = client.post(
        "/api/cs-data-radar/cards/missing/team-logo",
        files={"file": ("logo.png", _PNG, "image/png")},
    )
    assert missing.status_code == 404


def test_team_logo_reupload_regenerates_video(monkeypatch, tmp_path):
    """队标变化后：原本已有动画 → 自动用新队标重新生成（与头像重传一致）。"""
    from pathlib import Path

    import app.features.cs_data_radar.api as radar_api

    client = _make_client(monkeypatch, tmp_path)
    created = client.post("/api/cs-data-radar/cards", json={"players": [{
        "player_key": "sid:76561198000000014",
        "name": "LogoAnim",
        "display_name": "LogoAnim",
        "team_key": "3",
        "team_label": "CT",
        "kills": 26, "deaths": 13, "assists": 6,
        "kpr": 0.9, "dpr": 0.45, "adr": 96.0, "kast": 80.0, "survival_rate": 40.0,
    }]}).json()["cards"][0]
    card_id = created["id"]
    _seed_existing_video(monkeypatch, tmp_path, card_id)

    calls: list[str] = []

    def fake_generate(cid, ffmpeg_bin, workers=None):
        calls.append(str(cid))
        return {**created, "video_url": "/api/cs-data-radar/videos/x.mp4"}

    monkeypatch.setattr(radar_api, "generate_card_animation", fake_generate)
    monkeypatch.setattr(radar_api, "_resolve_ffmpeg_or_none", lambda cfg: Path("ffmpeg"))

    resp = client.post(
        f"/api/cs-data-radar/cards/{card_id}/team-logo",
        files={"file": ("logo.png", _PNG, "image/png")},
    )
    assert resp.status_code == 200
    assert calls == [card_id]  # 队标变化 → 自动重新生成动画
