"""OBS 配置中心：诊断、推荐预设、.cs2obs 与原生文件导入、备份恢复（主要面向 Windows 本机 OBS 配置目录）。"""

from __future__ import annotations

import configparser
import filecmp
import json
import logging
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from obswebsocket import obsws, requests as obs_requests

from .env_utils import get_data_dir

logger = logging.getLogger(__name__)

APP_VERSION = "V2.1.0"
DEFAULT_PROJECT_PROFILE = "未命名"  # 解析失败时的兜底目录名；正常由 resolve_default_project_profile_for_obs() 解析
BACKUP_SUBDIR = ".obs_config_backups"


def _dedicated_scene_name() -> str:
    s = (os.environ.get("CS2_INSIGHT_OBS_SCENE_NAME") or "CS2 Insight Recording").strip()
    return s or "CS2 Insight Recording"


def _dedicated_capture_name() -> str:
    s = (os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_NAME") or "CS2 Insight Game Capture").strip()
    return s or "CS2 Insight Game Capture"


def _obs_studio_root() -> Optional[Path]:
    if sys.platform != "win32":
        return None
    appdata = os.environ.get("APPDATA", "").strip()
    if not appdata:
        return None
    return Path(appdata) / "obs-studio"


def _backup_root() -> Path:
    return get_data_dir() / BACKUP_SUBDIR


def _read_global_profile_names(obs_root: Path) -> tuple[Optional[str], Optional[str]]:
    g = obs_root / "global.ini"
    if not g.is_file():
        return None, None
    try:
        raw = g.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None, None
    prof: Optional[str] = None
    sc: Optional[str] = None
    for line in raw.splitlines():
        s = line.strip()
        if s.lower().startswith("currentprofile="):
            prof = s.split("=", 1)[1].strip()
        if s.lower().startswith("currentscenecollection="):
            sc = s.split("=", 1)[1].strip()
    return prof, sc


def _set_global_ini_current_profile(obs_root: Path, profile_name: str) -> bool:
    g = obs_root / "global.ini"
    if not g.is_file():
        return False
    try:
        lines = g.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return False
    key = "CurrentProfile="
    out: list[str] = []
    found = False
    for line in lines:
        if line.strip().lower().startswith("currentprofile="):
            out.append(f"CurrentProfile={profile_name}")
            found = True
        else:
            out.append(line)
    if not found:
        # 追加到 [General] 后或文件头
        inserted = False
        final: list[str] = []
        for i, line in enumerate(out):
            final.append(line)
            if line.strip() == "[General]" and i + 1 < len(out) and not any(
                x.strip().lower().startswith("currentprofile=") for x in out[i + 1 : i + 5]
            ):
                final.append(f"CurrentProfile={profile_name}")
                inserted = True
        if not inserted:
            final = [f"CurrentProfile={profile_name}", ""] + out
        out = final
    try:
        g.write_text("\n".join(out) + "\n", encoding="utf-8")
        return True
    except OSError:
        return False


# OBS 安装后常见的默认配置目录名（中文界面为「未命名」，英文为 Untitled）。不使用环境变量覆盖。
_OBS_DEFAULT_PROFILE_FOLDER_NAMES: tuple[str, ...] = ("未命名", "Untitled", "Default")


def _profile_template_dir(profiles_root: Path) -> Optional[Path]:
    """从已有 Profile 中选一个作为新建目录的拷贝模板。"""
    for name in _OBS_DEFAULT_PROFILE_FOLDER_NAMES:
        p = profiles_root / name
        if p.is_dir():
            return p
    try:
        subs = sorted(
            [x for x in profiles_root.iterdir() if x.is_dir()],
            key=lambda x: x.name.lower(),
        )
        if subs:
            return subs[0]
    except OSError:
        pass
    return None


def _resolve_obs_profile_folder_name(obs_root: Path) -> str:
    """解析本机应写入的 OBS Profile 目录名：优先默认文件夹（未命名 / Untitled），否则 CurrentProfile，再否则首个子目录。不使用环境变量。"""
    profiles_root = obs_root / "basic" / "profiles"
    for name in _OBS_DEFAULT_PROFILE_FOLDER_NAMES:
        if (profiles_root / name).is_dir():
            return name
    cur, _ = _read_global_profile_names(obs_root)
    if cur:
        c = cur.strip()
        if c and (profiles_root / c).is_dir():
            return c
    try:
        subs = [p for p in profiles_root.iterdir() if p.is_dir()]
        if subs:
            return sorted(subs, key=lambda p: p.name.lower())[0].name
    except OSError:
        pass
    return DEFAULT_PROJECT_PROFILE


def resolve_default_project_profile_for_obs() -> str:
    """解析默认 OBS Profile 目录名（Windows）；非 Windows 返回 ``Untitled``（后续文件 API 仍会拒绝）。"""
    if sys.platform != "win32":
        return "Untitled"
    root = _obs_studio_root()
    if root is None:
        return DEFAULT_PROJECT_PROFILE
    return _resolve_obs_profile_folder_name(root)


def _effective_project_profile(obs_root: Path, explicit: Optional[str]) -> str:
    """explicit 非空则用之；否则按本机 OBS 目录解析默认 Profile（未命名 / Untitled 等）。"""
    e = (explicit or "").strip()
    if e:
        return e
    return _resolve_obs_profile_folder_name(obs_root)


def _parse_simple_output(ini_path: Path) -> dict[str, str]:
    if not ini_path.is_file():
        return {}
    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(ini_path, encoding="utf-8-sig")
    except configparser.Error:
        return {}
    if "SimpleOutput" not in cp:
        return {}
    return {k: str(v) for k, v in cp["SimpleOutput"].items()}


def _parse_adv_output_rec_path(ini_path: Path) -> str:
    """从 basic.ini [AdvOut] 读取高级输出模式的录像目录（RecFilePath）。"""
    if not ini_path.is_file():
        return ""
    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(ini_path, encoding="utf-8-sig")
    except configparser.Error:
        return ""
    section = cp["AdvOut"] if "AdvOut" in cp else {}
    return str(section.get("recfilepath") or section.get("RecFilePath") or "").strip()


def _get_record_directory_via_ws(ws: obsws) -> str:
    """通过 OBS WebSocket GetRecordDirectory 获取录像目录，失败返回空串。"""
    try:
        req = getattr(obs_requests, "GetRecordDirectory", None)
        if req is None:
            return ""
        resp = ws.call(req())
        datain = getattr(resp, "datain", None) or {}
        raw = (
            datain.get("recordDirectory")
            or datain.get("record_directory")
            or datain.get("record-directory")
        )
        return str(raw).strip() if raw else ""
    except Exception:  # noqa: BLE001
        return ""


def _copy_profile_tree(src: Path, dst: Path) -> None:
    if not src.is_dir():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)


def _safe_copy_file(src: Path, dst: Path, *, skip_if_identical: bool = False) -> bool:
    """复制文件，可选在目标与源字节完全一致时跳过（避免仅刷新修改时间）。返回是否执行了复制。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if skip_if_identical and dst.is_file() and src.is_file():
        try:
            if filecmp.cmp(src, dst, shallow=False):
                return False
        except OSError:
            pass
    shutil.copy2(src, dst)
    return True


def _ensure_project_profile_folder(obs_root: Path, project_profile: str) -> Path:
    profiles_root = obs_root / "basic" / "profiles"
    tgt = profiles_root / project_profile
    if tgt.is_dir():
        return tgt
    profiles_root.mkdir(parents=True, exist_ok=True)
    template = _profile_template_dir(profiles_root)
    if template is not None and template.is_dir():
        shutil.copytree(template, tgt)
        logger.info("Created OBS profile %s from template %s", project_profile, template.name)
    else:
        tgt.mkdir(parents=True, exist_ok=True)
        basic = tgt / "basic.ini"
        if not basic.is_file():
            basic.write_text("[General]\nName=" + project_profile + "\n", encoding="utf-8")
        logger.info("Created empty OBS profile directory: %s", tgt)
    return tgt


def _ws_connect(obs_cfg) -> obsws:
    ws = obsws(obs_cfg.host, obs_cfg.port, obs_cfg.password)
    ws.connect()
    return ws


def _ws_disconnect(ws: Optional[obsws]) -> None:
    if not ws:
        return
    try:
        ws.disconnect()
    except Exception:  # noqa: BLE001
        pass


def _obs_is_recording(ws: obsws) -> bool:
    try:
        req = getattr(obs_requests, "GetRecordStatus", None)
        if req is None:
            return False
        resp = ws.call(req())
        d = getattr(resp, "datain", {}) or {}
        active = d.get("outputActive")
        if active is None:
            active = getattr(resp, "outputActive", None)
        return bool(active)
    except Exception:  # noqa: BLE001
        return False


def _parse_ws_video(resp: object) -> dict[str, int]:
    d = getattr(resp, "datain", {}) or {}
    vs = d.get("videoSettings") or d.get("video_settings") or d
    if isinstance(vs, dict):
        bw = int(vs.get("baseWidth") or vs.get("base_width") or 0)
        bh = int(vs.get("baseHeight") or vs.get("base_height") or 0)
        ow = int(vs.get("outputWidth") or vs.get("output_width") or bw)
        oh = int(vs.get("outputHeight") or vs.get("output_height") or bh)
        fn = int(vs.get("fpsNumerator") or vs.get("fps_numerator") or 60)
        fd = int(vs.get("fpsDenominator") or vs.get("fps_denominator") or 1)
        return {"base_width": bw, "base_height": bh, "output_width": ow, "output_height": oh, "fps_num": fn, "fps_den": max(1, fd)}
    return {"base_width": 0, "base_height": 0, "output_width": 0, "output_height": 0, "fps_num": 60, "fps_den": 1}


def _fps_from_video_dict(v: dict[str, int]) -> int:
    fd = max(1, int(v.get("fps_den") or 1))
    fn = int(v.get("fps_num") or 60)
    return int(round(fn / fd)) if fn else 60


def _detect_use_stream_encoder(simple: dict[str, str], obs_ws: Optional[obsws]) -> bool:
    # ini 启发式
    for key in ("RecUseStreamEncoder", "UseStreamEncoder", "rec_use_stream_encoder"):
        val = simple.get(key)
        if val is not None:
            return str(val).strip().lower() in ("1", "true", "yes")
    same = (simple.get("RecEncoder") or "").strip() and (simple.get("Encoder") or "").strip()
    if same and simple.get("RecEncoder") == simple.get("Encoder"):
        # 可能共用；保守视为警告来源之一，最终以 WS 为准
        pass
    if obs_ws is not None:
        for pname in ("RecUseStreamEncoder", "UseStreamEncoder"):
            try:
                req = getattr(obs_requests, "GetProfileParameter", None)
                if req is None:
                    break
                r = obs_ws.call(
                    req(parameterCategory="SimpleOutput", parameterName=pname),
                )
                d = getattr(r, "datain", {}) or {}
                raw = d.get("parameterValue")
                if raw is not None:
                    return str(raw).strip().lower() in ("1", "true", "yes")
            except Exception:  # noqa: BLE001
                continue
    return False


def _recording_output_path_from_simple(simple: dict[str, str]) -> str:
    return (simple.get("FilePath") or simple.get("FilePath2") or "").strip()


def _scene_item_transform(ws: obsws, scene_name: str, source_name: str) -> Optional[dict]:
    try:
        gtr = getattr(obs_requests, "GetSceneItemTransform", None)
        if gtr is None:
            return None
        il = ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
        items = getattr(il, "datain", {}).get("sceneItems") or []
        sid = None
        for it in items:
            if not isinstance(it, dict):
                continue
            nm = it.get("sourceName") or it.get("sceneItemSourceName")
            if str(nm or "") == source_name:
                sid = it.get("sceneItemId")
                break
        if sid is None:
            return None
        tr = ws.call(gtr(sceneName=scene_name, sceneItemId=int(sid)))
        d = getattr(tr, "datain", {}) or {}
        return d.get("sceneItemTransform") or d
    except Exception as e:  # noqa: BLE001
        logger.debug("GetSceneItemTransform failed: %s", e)
        return None


def _source_fits_canvas(ws: obsws, scene_name: str, source_name: str, base_w: int, base_h: int) -> bool:
    t = _scene_item_transform(ws, scene_name, source_name)
    if not isinstance(t, dict):
        return False
    bt = str(t.get("boundsType") or "")
    # Bounds-based stretch/scale (set via calibrate or OBS bounds UI)
    if bt and bt != "OBS_BOUNDS_NONE":
        bw = int(float(t.get("boundsWidth") or 0))
        bh = int(float(t.get("boundsHeight") or 0))
        ok_dims = bw >= base_w - 4 and bh >= base_h - 4 and bw > 0 and bh > 0
        ok_type = "STRETCH" in bt.upper() or "SCALE_INNER" in bt.upper() or "SCALE_OUTER" in bt.upper()
        if ok_dims and ok_type:
            return True
    # Fallback: OBS "拉伸至全屏" (boundsType=NONE, fills via scale)
    px = float(t.get("positionX") or 0)
    py = float(t.get("positionY") or 0)
    if abs(px) <= 4 and abs(py) <= 4:
        w = int(float(t.get("width") or 0))
        h = int(float(t.get("height") or 0))
        if w >= base_w - 4 and h >= base_h - 4 and w > 0 and h > 0:
            return True
        # scaleX * sourceWidth in case width is pre-scale
        sx = float(t.get("scaleX") or 0)
        sy = float(t.get("scaleY") or 0)
        sw = int(float(t.get("sourceWidth") or 0))
        sh = int(float(t.get("sourceHeight") or 0))
        if sx > 0 and sy > 0 and sw > 0 and sh > 0:
            if int(sx * sw) >= base_w - 8 and int(sy * sh) >= base_h - 8:
                return True
    return False


def _create_backup(
    obs_root: Path,
    *,
    reason: str,
    project_profile: str,
) -> tuple[str, Path]:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_id = f"{ts}_{reason}"
    dest = _backup_root() / backup_id
    dest.mkdir(parents=True, exist_ok=True)
    prof_name, sc_name = _read_global_profile_names(obs_root)
    manifest = {
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "reason": reason,
        "obs_config_dir": str(obs_root),
        "active_profile": prof_name,
        "active_scene_collection": sc_name,
        "project_profile": project_profile,
        "app_version": APP_VERSION,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    g = obs_root / "global.ini"
    if g.is_file():
        _safe_copy_file(g, dest / "global.ini")
    pp = obs_root / "basic" / "profiles" / project_profile
    if pp.is_dir():
        _copy_profile_tree(pp, dest / "profiles" / project_profile)
    return backup_id, dest


def _restore_backup_pack(backup_dir: Path, obs_root: Path, project_profile: str) -> bool:
    g_bak = backup_dir / "global.ini"
    if g_bak.is_file():
        _safe_copy_file(g_bak, obs_root / "global.ini")
    prof_bak = backup_dir / "profiles" / project_profile
    if prof_bak.is_dir():
        tgt = obs_root / "basic" / "profiles" / project_profile
        _copy_profile_tree(prof_bak, tgt)
    return True


def list_backups() -> list[dict[str, Any]]:
    root = _backup_root()
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not child.is_dir():
            continue
        mf = child / "manifest.json"
        if not mf.is_file():
            continue
        try:
            data = json.loads(mf.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        items.append(
            {
                "id": child.name,
                "created_at": str(data.get("created_at") or ""),
                "reason": str(data.get("reason") or ""),
                "active_profile": data.get("active_profile"),
            }
        )
    return items


def _latest_backup_summary() -> Optional[dict[str, str]]:
    rows = list_backups()
    if not rows:
        return None
    top = rows[0]
    return {"id": top["id"], "created_at": top.get("created_at") or ""}


def get_status_payload(obs_cfg) -> dict[str, Any]:
    obs_root = _obs_studio_root()
    prof_name, sc_name = (None, None)
    if obs_root:
        prof_name, sc_name = _read_global_profile_names(obs_root)

    latest = _latest_backup_summary()
    from .env_utils import get_primary_monitor_resolution
    _mon_w, _mon_h = get_primary_monitor_resolution()
    base: dict[str, Any] = {
        "ok": True,
        "obs_connected": False,
        "obs_config_dir": str(obs_root) if obs_root else None,
        "active_profile": prof_name,
        "active_scene_collection": sc_name,
        "video": {
            "base_width": 0,
            "base_height": 0,
            "output_width": 0,
            "output_height": 0,
            "fps": 0,
        },
        "recording": {
            "use_stream_encoder": False,
            "encoder": "",
            "format": "",
            "output_path": "",
        },
        "scene": {
            "dedicated_scene_exists": False,
            "capture_source_exists": False,
            "source_fit_to_canvas": False,
        },
        "monitor": {"width": _mon_w, "height": _mon_h},
        "latest_backup": latest,
        "obs_version": None,
    }

    if sys.platform != "win32":
        base["ok"] = True
        base["message"] = "OBS 配置文件操作建议在 Windows 上进行；仍可尝试连接 OBS WebSocket 查看画面状态。"
    ws: Optional[obsws] = None
    try:
        ws = _ws_connect(obs_cfg)
    except Exception as e:  # noqa: BLE001
        base["obs_connected"] = False
        base["ws_error"] = str(e)
        return base

    base["obs_connected"] = True
    try:
        try:
            ver = ws.call(obs_requests.GetVersion())
            ov = None
            if ver is not None:
                go = getattr(ver, "getObsVersion", None)
                ov = go() if callable(go) else None
            if ov is None and ver is not None:
                din = getattr(ver, "datain", {}) or {}
                ov = din.get("obsVersion") or din.get("obs_version") or din.get("obs-version")
            base["obs_version"] = str(ov).strip() if ov else None
        except Exception:  # noqa: BLE001
            base["obs_version"] = None

        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        base["video"] = {
            "base_width": vd["base_width"],
            "base_height": vd["base_height"],
            "output_width": vd["output_width"],
            "output_height": vd["output_height"],
            "fps": _fps_from_video_dict(vd),
        }
        scene_name = _dedicated_scene_name()
        cap_name = _dedicated_capture_name()
        try:
            sl = ws.call(obs_requests.GetSceneList())
            scenes = getattr(sl, "datain", {}).get("scenes") or []
            base["scene"]["dedicated_scene_exists"] = any(
                isinstance(s, dict) and str(s.get("sceneName") or "") == scene_name for s in scenes
            )
        except Exception:  # noqa: BLE001
            pass
        try:
            il = ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
            items = getattr(il, "datain", {}).get("sceneItems") or []
            base["scene"]["capture_source_exists"] = any(
                isinstance(it, dict) and str(it.get("sourceName") or it.get("sceneItemSourceName") or "") == cap_name
                for it in items
            )
        except Exception:  # noqa: BLE001
            pass
        if base["video"]["base_width"] and base["scene"]["capture_source_exists"]:
            base["scene"]["source_fit_to_canvas"] = _source_fits_canvas(
                ws,
                scene_name,
                cap_name,
                int(base["video"]["base_width"]),
                int(base["video"]["base_height"]),
            )
        simple: dict[str, str] = {}
        if obs_root and prof_name:
            simple = _parse_simple_output(obs_root / "basic" / "profiles" / prof_name / "basic.ini")
        base["recording"]["use_stream_encoder"] = _detect_use_stream_encoder(simple, ws)
        base["recording"]["encoder"] = (simple.get("RecEncoder") or simple.get("Encoder") or "").strip()
        # 三路兜底：Simple 输出 INI → Advanced 输出 INI → WebSocket GetRecordDirectory
        _ini_path = (obs_root / "basic" / "profiles" / prof_name / "basic.ini") if (obs_root and prof_name) else None
        _out_path = (
            _recording_output_path_from_simple(simple)
            or (_parse_adv_output_rec_path(_ini_path) if _ini_path else "")
            or _get_record_directory_via_ws(ws)
        )
        base["recording"]["output_path"] = _out_path
        # 优先从 OBS WebSocket 读取格式和质量，避免 INI 路径检测失败导致"未知"
        try:
            fmt_resp = ws.call(obs_requests.GetProfileParameter(
                parameterCategory="SimpleOutput", parameterName="RecFormat2"
            ))
            fmt_val = (getattr(fmt_resp, "datain", None) or {}).get("parameterValue", "")
            base["recording"]["format"] = fmt_val or (simple.get("RecFormat2") or simple.get("RecFormat") or "").strip()
        except Exception:  # noqa: BLE001
            base["recording"]["format"] = (simple.get("RecFormat2") or simple.get("RecFormat") or "").strip()
        try:
            q_resp = ws.call(obs_requests.GetProfileParameter(
                parameterCategory="SimpleOutput", parameterName="RecQuality"
            ))
            q_val = (getattr(q_resp, "datain", None) or {}).get("parameterValue", "")
            base["recording"]["rec_quality"] = q_val or (simple.get("RecQuality") or "").strip()
        except Exception:  # noqa: BLE001
            base["recording"]["rec_quality"] = (simple.get("RecQuality") or "").strip()
    except Exception as e:  # noqa: BLE001
        base["ws_error"] = str(e)
    finally:
        _ws_disconnect(ws)

    return base


def diagnose(obs_cfg) -> dict[str, Any]:
    """基于 OBS WebSocket +（Windows）Profile 目录的真实诊断；返回结果含连接状态与时间戳供前端展示。"""
    issues: list[dict[str, Any]] = []
    obs_root = _obs_studio_root()

    ws: Optional[obsws] = None
    obs_connected = False
    obs_version: Optional[str] = None
    video_dims: dict[str, int] = {"base_width": 0, "base_height": 0, "output_width": 0, "output_height": 0, "fps_num": 60, "fps_den": 1}
    prof_name: Optional[str] = None
    disk_profile_checked = False

    try:
        ws = _ws_connect(obs_cfg)
        obs_connected = True

        try:
            ver = ws.call(obs_requests.GetVersion())
            ov = None
            if ver is not None:
                go = getattr(ver, "getObsVersion", None)
                ov = go() if callable(go) else None
            if ov is None and ver is not None:
                din = getattr(ver, "datain", {}) or {}
                ov = din.get("obsVersion") or din.get("obs_version") or din.get("obs-version")
            obs_version = str(ov).strip() if ov else None
        except Exception:  # noqa: BLE001
            obs_version = None

        if _obs_is_recording(ws):
            issues.append(
                {
                    "code": "OBS_RECORDING_ACTIVE",
                    "level": "error",
                    "title": "OBS 正在录制",
                    "message": "录制进行中时无法安全修改配置，请先停止录制。",
                    "fixable": False,
                }
            )
        from .env_utils import get_primary_monitor_resolution

        monitor_w, monitor_h = get_primary_monitor_resolution()
        vr = ws.call(obs_requests.GetVideoSettings())
        video_dims = _parse_ws_video(vr)
        fps = _fps_from_video_dict(video_dims)
        bw, bh = video_dims["base_width"], video_dims["base_height"]
        ow, oh = video_dims["output_width"], video_dims["output_height"]
        if bw and bh and (bw != monitor_w or bh != monitor_h):
            issues.append(
                {
                    "code": "CANVAS_RESOLUTION_MISMATCH",
                    "level": "warning",
                    "title": "画布分辨率与主显示器不一致",
                    "message": f"当前 {bw}×{bh}，应为 {monitor_w}×{monitor_h}。",
                    "fixable": True,
                }
            )
        if ow and oh and (ow != monitor_w or oh != monitor_h):
            issues.append(
                {
                    "code": "OUTPUT_RESOLUTION_MISMATCH",
                    "level": "warning",
                    "title": "输出分辨率与主显示器不一致",
                    "message": f"当前 {ow}×{oh}，应为 {monitor_w}×{monitor_h}。",
                    "fixable": True,
                }
            )
        if bw and bh and ow and oh and (bw != ow or bh != oh):
            issues.append(
                {
                    "code": "VIDEO_SCALE_MISMATCH",
                    "level": "warning",
                    "title": "基础画布与输出分辨率不一致",
                    "message": "可能导致画面缩放异常或黑边。",
                    "fixable": True,
                }
            )
        if fps < 60:
            issues.append(
                {
                    "code": "FPS_TOO_LOW",
                    "level": "warning",
                    "title": "FPS 低于 60",
                    "message": "录制流畅度可能不足，推荐 60 FPS。",
                    "fixable": True,
                }
            )

        scene_name = _dedicated_scene_name()
        cap_name = _dedicated_capture_name()
        scene_ok = False
        cap_ok = False
        try:
            sl = ws.call(obs_requests.GetSceneList())
            scenes = getattr(sl, "datain", {}).get("scenes") or []
            scene_ok = any(isinstance(s, dict) and str(s.get("sceneName") or "") == scene_name for s in scenes)
        except Exception:  # noqa: BLE001
            pass
        if not scene_ok:
            issues.append(
                {
                    "code": "DEDICATED_SCENE_MISSING",
                    "level": "warning",
                    "title": "专属录制场景不存在",
                    "message": f"未找到场景「{scene_name}」，录制流程可能无法切换画面。",
                    "fixable": True,
                }
            )
        try:
            il = ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
            items = getattr(il, "datain", {}).get("sceneItems") or []
            cap_ok = any(
                isinstance(it, dict) and str(it.get("sourceName") or it.get("sceneItemSourceName") or "") == cap_name for it in items
            )
        except Exception:  # noqa: BLE001
            pass
        if not cap_ok:
            issues.append(
                {
                    "code": "CAPTURE_SOURCE_MISSING",
                    "level": "error",
                    "title": "CS2 捕获源缺失",
                    "message": f"场景「{scene_name}」中未找到「{cap_name}」。",
                    "fixable": True,
                }
            )
        elif bw and bh and not _source_fits_canvas(ws, scene_name, cap_name, bw, bh):
            issues.append(
                {
                    "code": "SOURCE_NOT_FIT_CANVAS",
                    "level": "warning",
                    "title": "CS2 捕获源未铺满画布",
                    "message": "可能出现黑边或未拉伸。应用推荐预设可修复变换。",
                    "fixable": True,
                }
            )

        simple: dict[str, str] = {}
        if obs_root is not None and obs_root.is_dir():
            prof_name, _ = _read_global_profile_names(obs_root)
            if prof_name:
                pin = obs_root / "basic" / "profiles" / prof_name / "basic.ini"
                if pin.is_file():
                    simple = _parse_simple_output(pin)
                    disk_profile_checked = True

        if disk_profile_checked:
            if _detect_use_stream_encoder(simple, ws):
                issues.append(
                    {
                        "code": "USE_STREAM_ENCODER",
                        "level": "error",
                        "title": "录制正在使用与串流一致",
                        "message": "当前录制配置依赖串流编码器，可能导致录制失败。建议应用推荐预设。",
                        "fixable": True,
                    }
                )
            out_path = _recording_output_path_from_simple(simple)
            if not out_path:
                issues.append(
                    {
                        "code": "NO_OUTPUT_PATH",
                        "level": "warning",
                        "title": "未设置录制输出目录",
                        "message": "请在 OBS 设置中为录制指定输出路径。",
                        "fixable": False,
                    }
                )
            enc = (simple.get("RecEncoder") or "").strip()
            if not enc:
                issues.append(
                    {
                        "code": "ENCODER_UNAVAILABLE",
                        "level": "warning",
                        "title": "录制编码器未配置或为空",
                        "message": "建议应用推荐预设或手动选择可用编码器。",
                        "fixable": True,
                    }
                )
    except Exception as e:  # noqa: BLE001
        obs_connected = False
        obs_version = None
        issues.append(
            {
                "code": "OBS_NOT_CONNECTED",
                "level": "error",
                "title": "无法连接 OBS WebSocket",
                "message": str(e) or "请确认 OBS 已启动且 WebSocket 已启用。",
                "fixable": False,
            }
        )
    finally:
        _ws_disconnect(ws)

    if not obs_root and sys.platform != "win32":
        issues.append(
            {
                "code": "UNKNOWN_PROFILE",
                "level": "warning",
                "title": "未检测到本机 OBS 配置目录",
                "message": "当前平台非 Windows，文件级诊断与导入功能不可用。",
                "fixable": False,
            }
        )

    level = "normal"
    if any(i["level"] == "error" for i in issues):
        level = "error"
    elif any(i["level"] == "warning" for i in issues):
        level = "warning"

    return {
        "ok": True,
        "level": level,
        "issues": issues,
        "obs_connected": obs_connected,
        "obs_version": obs_version,
        "active_profile_name": prof_name,
        "disk_profile_checked": disk_profile_checked,
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def calibrate(obs_cfg) -> dict[str, Any]:
    """运行时校准：读显示器分辨率 → 修正 OBS 画布 → 建场景 → 建 Game Capture → 设拉伸 → 修输出格式。
    仅操作 CS2 Insight 专用场景，不动用户其他场景。
    """
    from .env_utils import get_primary_monitor_resolution

    ws = None
    try:
        ws = _ws_connect(obs_cfg)
    except Exception as exc:
        raise ValueError(f"OBS WebSocket 未连接，请先在设置中测试连接：{exc}") from exc

    try:
        if _obs_is_recording(ws):
            raise ValueError("录制进行中，无法修改视频设置，请录制结束后再校准")

        changed: list[str] = []
        already_ok: list[str] = []

        # Step 1+2: 读显示器分辨率 & OBS 画布
        monitor_w, monitor_h = get_primary_monitor_resolution()

        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        canvas_w = vd.get("base_width", 0)
        canvas_h = vd.get("base_height", 0)
        output_w = vd.get("output_width", 0)
        output_h = vd.get("output_height", 0)
        existing_fps_n = vd.get("fps_num", 60)
        existing_fps_d = vd.get("fps_den", 1)

        # Step 3: 修正画布与输出分辨率
        # OBS WS v5 SetVideoSettings 字段是顶层 kwargs，不能嵌套在 videoSettings={}
        canvas_needs_fix = canvas_w != monitor_w or canvas_h != monitor_h
        output_needs_fix = output_w != monitor_w or output_h != monitor_h
        if canvas_needs_fix or output_needs_fix:
            ws.call(obs_requests.SetVideoSettings(
                fpsNumerator=existing_fps_n,
                fpsDenominator=existing_fps_d,
                baseWidth=monitor_w,
                baseHeight=monitor_h,
                outputWidth=monitor_w,
                outputHeight=monitor_h,
            ))
            # 回读验证：避免静默失败时错误报告成功
            verify_vr = ws.call(obs_requests.GetVideoSettings())
            verify_vd = _parse_ws_video(verify_vr)
            canvas_ok = verify_vd["base_width"] == monitor_w and verify_vd["base_height"] == monitor_h
            output_ok = verify_vd["output_width"] == monitor_w and verify_vd["output_height"] == monitor_h
            if canvas_ok and output_ok:
                if canvas_needs_fix:
                    changed.append(f"已将画布分辨率从 {canvas_w}×{canvas_h} 修正为 {monitor_w}×{monitor_h}")
                if output_needs_fix:
                    changed.append(f"已将输出分辨率从 {output_w}×{output_h} 修正为 {monitor_w}×{monitor_h}")
            else:
                parts: list[str] = []
                if not canvas_ok:
                    parts.append(
                        f"画布仍为 {verify_vd['base_width']}×{verify_vd['base_height']}（应为 {monitor_w}×{monitor_h}）"
                    )
                if not output_ok:
                    parts.append(
                        f"输出仍为 {verify_vd['output_width']}×{verify_vd['output_height']}（应为 {monitor_w}×{monitor_h}）"
                    )
                raise ValueError(
                    "OBS 未接受分辨率修改（" + "；".join(parts) + "），"
                    f"请在 OBS 设置→视频中手动将基础（画布）与输出（缩放）分辨率改为 {monitor_w}×{monitor_h}"
                )
        else:
            already_ok.append(f"画布分辨率正确（{canvas_w}×{canvas_h}）")
            already_ok.append(f"输出分辨率正确（{output_w}×{output_h}）")

        # Step 4: 确保 CS2 Insight 场景存在
        scene_name = _dedicated_scene_name()
        scenes_resp = ws.call(obs_requests.GetSceneList())
        scenes_data = getattr(scenes_resp, "datain", None) or {}
        scene_names = [s.get("sceneName", "") for s in scenes_data.get("scenes", [])]

        if scene_name not in scene_names:
            ws.call(obs_requests.CreateScene(sceneName=scene_name))
            changed.append(f"已创建场景「{scene_name}」")
        else:
            already_ok.append(f"场景「{scene_name}」已存在")

        # Step 5: 确保 Game Capture 源存在
        capture_name = _dedicated_capture_name()
        items_resp = ws.call(obs_requests.GetSceneItemList(sceneName=scene_name))
        items_data = getattr(items_resp, "datain", None) or {}
        source_names = [item.get("sourceName", "") for item in items_data.get("sceneItems", [])]

        if capture_name not in source_names:
            ws.call(obs_requests.CreateInput(
                sceneName=scene_name,
                inputName=capture_name,
                inputKind="game_capture",
                inputSettings={"capture_mode": "window", "window": "cs2.exe"},
            ))
            changed.append(f"已创建 Game Capture 源「{capture_name}」")
        else:
            already_ok.append(f"Game Capture 源「{capture_name}」已存在")

        # Step 6: 设置拉伸填满画布
        item_id_resp = ws.call(obs_requests.GetSceneItemId(
            sceneName=scene_name, sourceName=capture_name
        ))
        item_id_data = getattr(item_id_resp, "datain", None) or {}
        item_id = item_id_data.get("sceneItemId")
        if item_id is not None:
            ws.call(obs_requests.SetSceneItemTransform(
                sceneName=scene_name,
                sceneItemId=int(item_id),
                sceneItemTransform={
                    "positionX": 0,
                    "positionY": 0,
                    "boundsType": "OBS_BOUNDS_STRETCH",
                    "boundsWidth": monitor_w,
                    "boundsHeight": monitor_h,
                },
            ))
            changed.append("已设置 Game Capture 拉伸填满画布")
        else:
            already_ok.append("Game Capture 拉伸变换跳过（无法获取 sceneItemId）")

        # Step 7: 修正输出设置（RecQuality / RecFormat2）
        rec_q_resp = ws.call(obs_requests.GetProfileParameter(
            parameterCategory="SimpleOutput", parameterName="RecQuality"
        ))
        rec_q_data = getattr(rec_q_resp, "datain", None) or {}
        rec_quality = rec_q_data.get("parameterValue", "")

        restart_required = False

        if rec_quality == "Stream":
            ws.call(obs_requests.SetProfileParameter(
                parameterCategory="SimpleOutput",
                parameterName="RecQuality",
                parameterValue="Small",
            ))
            # RecQuality="Stream" 时 OBS 忽略 RecEncoder；改为 "Small" 后必须有有效编码器
            # 否则 OBS 以空编码器启动录制会报「启动录像失败」
            rec_enc_resp = ws.call(obs_requests.GetProfileParameter(
                parameterCategory="SimpleOutput", parameterName="RecEncoder"
            ))
            rec_enc_val = ((getattr(rec_enc_resp, "datain", None) or {}).get("parameterValue") or "").strip()
            if not rec_enc_val or rec_enc_val.lower() in ("none", "null", "stream"):
                # 1. 优先用当前串流编码器（用户已确认可用的硬件编码器）
                try:
                    stream_enc_resp = ws.call(obs_requests.GetProfileParameter(
                        parameterCategory="SimpleOutput", parameterName="StreamEncoder"
                    ))
                    stream_enc = ((getattr(stream_enc_resp, "datain", None) or {}).get("parameterValue") or "").strip()
                except Exception:  # noqa: BLE001
                    stream_enc = ""
                # 2. 串流编码器无效时按硬件优先顺序选取
                _HW_PRIORITY = [
                    "jim_nvenc",        # NVENC（新版，推荐）
                    "ffmpeg_nvenc",     # NVENC（旧版）
                    "h264_texture_amf", # AMD AMF（新版）
                    "amd_amf_h264",    # AMD AMF（旧版）
                    "obs_qsv11_v2",    # Intel QSV（新版）
                    "obs_qsv11",       # Intel QSV（旧版）
                ]
                _INVALID = {"", "none", "null", "stream"}
                target_enc = stream_enc if stream_enc.lower() not in _INVALID else _HW_PRIORITY[0]
                ws.call(obs_requests.SetProfileParameter(
                    parameterCategory="SimpleOutput",
                    parameterName="RecEncoder",
                    parameterValue=target_enc,
                ))
                changed.append(f"录像编码器已设为「{target_enc}」（原质量为串流一致时未配置）")
            # 编码器/质量变更写入的是磁盘 Profile，OBS 输出管线不会热重载，必须重启生效
            restart_required = True
            changed.append("录像质量已从「与串流一致」改为「高质量，中等文件大小」")
        else:
            already_ok.append("录像质量设置正常")

        rec_f_resp = ws.call(obs_requests.GetProfileParameter(
            parameterCategory="SimpleOutput", parameterName="RecFormat2"
        ))
        rec_f_data = getattr(rec_f_resp, "datain", None) or {}
        rec_format = rec_f_data.get("parameterValue", "")

        if rec_format != "hybrid_mp4":
            ws.call(obs_requests.SetProfileParameter(
                parameterCategory="SimpleOutput",
                parameterName="RecFormat2",
                parameterValue="hybrid_mp4",
            ))
            changed.append("录像格式已改为「混合 MP4」")
        else:
            already_ok.append("录像格式正确（混合 MP4）")

        return {
            "success": True,
            "changed": changed,
            "already_ok": already_ok,
            "restart_obs_required": restart_required,
        }

    finally:
        _ws_disconnect(ws)


def restore_backup(backup_id: str, obs_cfg, *, project_profile: Optional[str] = None) -> dict[str, Any]:
    if sys.platform != "win32":
        raise ValueError("恢复备份仅支持 Windows")
    obs_root = _obs_studio_root()
    if obs_root is None:
        raise ValueError("无法定位 OBS 配置目录")
    pp = _effective_project_profile(obs_root, project_profile)
    bdir = _backup_root() / backup_id
    if not bdir.is_dir():
        raise ValueError("备份不存在")
    ws: Optional[obsws] = None
    try:
        ws = _ws_connect(obs_cfg)
        if _obs_is_recording(ws):
            raise ValueError("OBS 正在录制中，请停止录制后再恢复备份。")
    finally:
        _ws_disconnect(ws)
    _restore_backup_pack(bdir, obs_root, pp)
    return {
        "ok": True,
        "restored": True,
        "restart_obs_required": True,
        "message": "OBS 配置已恢复，请重启 OBS 后生效。",
    }


def delete_backup(backup_id: str) -> dict[str, Any]:
    bdir = _backup_root() / backup_id
    if not bdir.is_dir():
        raise ValueError("备份不存在")
    shutil.rmtree(bdir, ignore_errors=True)
    return {"ok": True}


def open_backup_folder() -> dict[str, Any]:
    root = _backup_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    path_str = str(root.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(path_str)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", path_str], check=False, timeout=30)
        else:
            subprocess.run(["xdg-open", path_str], check=False, timeout=30)
        return {"ok": True, "path": path_str}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "path": path_str, "message": str(e)}
