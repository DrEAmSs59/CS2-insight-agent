"""OBS 配置中心：诊断、推荐预设、.cs2obs 与原生文件导入、备份恢复（主要面向 Windows 本机 OBS 配置目录）。"""

from __future__ import annotations

import configparser
import filecmp
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from obswebsocket import obsws, requests as obs_requests

from .env_utils import get_data_dir, load_config
from .obs_director import OBSDirector

logger = logging.getLogger(__name__)

APP_VERSION = "V2.0.0"
DEFAULT_PROJECT_PROFILE = "未命名"  # 解析失败时的兜底目录名；正常由 resolve_default_project_profile_for_obs() 解析
BUNDLED_OBS_BASIC_INI_NAME = "basic.ini"
BACKUP_SUBDIR = ".obs_config_backups"
NATIVE_MAX_BYTES = 1_048_576
NATIVE_ALLOWLIST = frozenset({"basic.ini", "recordEncoder.json", "streamEncoder.json"})


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


def _bundled_obs_basic_ini_path() -> Path:
    """随应用提供的 OBS 预设模板路径：``data/basic.ini`` → 一键推荐预设时写入玩家本机 Profile。"""
    return get_data_dir() / BUNDLED_OBS_BASIC_INI_NAME


def _parse_basic_ini_video_dims(ini_path: Path) -> tuple[int, int, int, int, int]:
    """从 OBS Profile ``basic.ini`` 的 ``[Video]`` 读取画布/输出/FPS；缺失时回退 1080p60。"""
    bw, bh, ow, oh, fps = 1920, 1080, 1920, 1080, 60
    if not ini_path.is_file():
        return bw, bh, ow, oh, fps
    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(ini_path, encoding="utf-8-sig")
    except configparser.Error:
        return bw, bh, ow, oh, fps
    if "Video" not in cp:
        return bw, bh, ow, oh, fps
    v = cp["Video"]
    try:
        bw = int(v.get("BaseCX") or bw)
        bh = int(v.get("BaseCY") or bh)
        ow = int(v.get("OutputCX") or bw)
        oh = int(v.get("OutputCY") or bh)
        fps = int(v.get("FPSCommon") or fps)
    except (TypeError, ValueError):
        pass
    return bw, bh, ow, oh, fps


def _merge_write_simple_output(ini_path: Path, updates: dict[str, str]) -> None:
    cp = configparser.ConfigParser(interpolation=None)
    if ini_path.is_file():
        try:
            cp.read(ini_path, encoding="utf-8-sig")
        except configparser.Error:
            pass
    if "SimpleOutput" not in cp:
        cp.add_section("SimpleOutput")
    for k, v in updates.items():
        cp.set("SimpleOutput", k, v)
    ini_path.parent.mkdir(parents=True, exist_ok=True)
    with ini_path.open("w", encoding="utf-8", newline="\n") as f:
        cp.write(f)


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


def _pick_rec_encoder_from_simple(simple: dict[str, str], obs_ws: Optional[obsws]) -> str:
    # 保留用户当前独立录制编码器；无法判断时回退 x264
    cur = (simple.get("RecEncoder") or simple.get("recEncoder") or "").strip()
    if cur and "same" not in cur.lower():
        return cur
    if obs_ws is not None:
        for name in (
            "RecEncoder",
            "recEncoder",
        ):
            try:
                req = getattr(obs_requests, "GetProfileParameter", None)
                if req is None:
                    break
                r = obs_ws.call(
                    req(
                        parameterCategory="SimpleOutput",
                        parameterName=name,
                    )
                )
                d = getattr(r, "datain", {}) or {}
                v = d.get("parameterValue") or d.get("value")
                if v and str(v).strip():
                    return str(v).strip()
            except Exception as e:  # noqa: BLE001
                logger.debug("GetProfileParameter %s: %s", name, e)
    return "obs_x264"


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
    bw = int(float(t.get("boundsWidth") or 0))
    bh = int(float(t.get("boundsHeight") or 0))
    bt = str(t.get("boundsType") or "")
    ok_dims = bw >= base_w - 4 and bh >= base_h - 4 and bw > 0 and bh > 0
    ok_type = "STRETCH" in bt.upper() or "SCALE_INNER" in bt.upper() or "SCALE_OUTER" in bt.upper() or "SCALE_TO_INNER" in bt.upper()
    return ok_dims and ok_type


def _apply_scale_inner_transform(ws: obsws, scene_name: str, source_name: str, base_w: int, base_h: int) -> bool:
    try:
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
            return False
        transform = {
            "positionX": 0,
            "positionY": 0,
            "rotation": 0,
            "scaleX": 1,
            "scaleY": 1,
            "cropTop": 0,
            "cropBottom": 0,
            "cropLeft": 0,
            "cropRight": 0,
            "boundsType": "OBS_BOUNDS_SCALE_INNER",
            "boundsAlignment": 5,
            "boundsWidth": float(base_w),
            "boundsHeight": float(base_h),
            "alignment": 5,
        }
        ws.call(
            obs_requests.SetSceneItemTransform(
                sceneName=scene_name,
                sceneItemId=int(sid),
                sceneItemTransform=transform,
            )
        )
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("SetSceneItemTransform failed: %s", e)
        return False


def _try_set_video_and_profile_params(
    ws: obsws,
    *,
    base_w: int,
    base_h: int,
    fps: int,
    encoder: str,
    output_width: Optional[int] = None,
    output_height: Optional[int] = None,
    rec_format: Optional[str] = None,
    project_profile: Optional[str] = None,
    basic_ini_path: Optional[Path] = None,
    sync_simple_output_from_disk: bool = False,
) -> None:
    """将画布/输出/FPS 推到 OBS；SimpleOutput 可从磁盘 ``basic.ini`` 读取（与一键内置预设一致）。"""
    ow = int(output_width or base_w)
    oh = int(output_height or base_h)
    prof = (project_profile or "").strip() or resolve_default_project_profile_for_obs()
    try:
        req = getattr(obs_requests, "SetVideoSettings", None)
        if req:
            ws.call(
                req(
                    videoSettings={
                        "baseWidth": base_w,
                        "baseHeight": base_h,
                        "outputWidth": ow,
                        "outputHeight": oh,
                        "fpsNumerator": fps,
                        "fpsDenominator": 1,
                    }
                )
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("SetVideoSettings failed: %s", e)

    if sync_simple_output_from_disk and basic_ini_path is not None:
        simple = _parse_simple_output(basic_ini_path)
        rus = str(simple.get("RecUseStreamEncoder") or "false").strip().lower() in ("1", "true", "yes")
        us = str(simple.get("UseStreamEncoder") or "false").strip().lower() in ("1", "true", "yes")
        enc = (simple.get("RecEncoder") or encoder or "obs_x264").strip()
        rf = (simple.get("RecFormat2") or "mkv").strip() or "mkv"
        loop = (
            ("RecUseStreamEncoder", rus, "bool"),
            ("UseStreamEncoder", us, "bool"),
            ("RecEncoder", enc, "string"),
            ("RecFormat2", rf, "string"),
        )
    else:
        rf = (rec_format or "mkv").strip() or "mkv"
        loop = (
            ("RecUseStreamEncoder", False, "bool"),
            ("UseStreamEncoder", False, "bool"),
            ("RecEncoder", encoder, "string"),
            ("RecFormat2", rf, "string"),
        )

    for pname, pval, ptype in loop:
        try:
            sreq = getattr(obs_requests, "SetProfileParameter", None)
            if sreq is None:
                break
            ws.call(
                sreq(
                    parameterCategory="SimpleOutput",
                    parameterName=pname,
                    parameterValue=pval,
                    parameterType=ptype,
                )
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("SetProfileParameter %s skipped: %s", pname, e)
    try:
        creq = getattr(obs_requests, "SetCurrentProfile", None)
        if creq:
            ws.call(creq(profileName=prof))
    except Exception as e:  # noqa: BLE001
        logger.debug("SetCurrentProfile: %s", e)


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


def validate_cs2obs_payload(data: dict[str, Any]) -> tuple[bool, str]:
    try:
        ver = int(data.get("version") or 0)
        if ver < 1:
            return False, "invalid version"
        v = data.get("video") or {}
        if not isinstance(v, dict):
            return False, "video must be object"
        bw = int(v.get("base_width") or 0)
        bh = int(v.get("base_height") or 0)
        ow = int(v.get("output_width") or 0)
        oh = int(v.get("output_height") or 0)
        fps = int(v.get("fps") or 0)
        if not (1280 <= bw <= 3840 and 720 <= bh <= 2160):
            return False, "video resolution out of range"
        if not (1280 <= ow <= 3840 and 720 <= oh <= 2160):
            return False, "output resolution out of range"
        if fps not in (30, 60, 120):
            return False, "fps must be 30, 60 or 120"
        rec = data.get("recording") or {}
        if rec.get("use_stream_encoder") is not None and not isinstance(rec.get("use_stream_encoder"), bool):
            return False, "recording.use_stream_encoder must be bool"
        scene = data.get("scene") or {}
        if scene.get("fit_to_screen") is not None and not isinstance(scene.get("fit_to_screen"), bool):
            return False, "scene.fit_to_screen must be bool"
        cq = data.get("recording", {}).get("cq_or_crf")
        if cq is not None:
            if int(cq) < 14 or int(cq) > 28:
                return False, "cq_or_crf out of range"
        return True, ""
    except (TypeError, ValueError):
        return False, "invalid preset fields"


def _reject_native_content_if_sensitive(text: str, filename: str) -> Optional[str]:
    low = filename.lower()
    if low == "service.json":
        return "不允许导入推流服务配置"
    if re.search(r"(?im)(stream[_-]?key|password)\s*=\s*\S+", text):
        return "文件疑似包含推流密钥或密码字段"
    return None


def _strip_sensitive_for_export(payload: dict[str, Any]) -> dict[str, Any]:
    def scrub(obj: Any) -> Any:
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                lk = str(k).lower()
                if lk in {"password", "stream_key", "server", "streamkey", "bind_ip"}:
                    continue
                out[k] = scrub(v)
            return out
        if isinstance(obj, list):
            return [scrub(x) for x in obj]
        return obj

    return scrub(payload)


def get_status_payload(obs_cfg) -> dict[str, Any]:
    obs_root = _obs_studio_root()
    prof_name, sc_name = (None, None)
    if obs_root:
        prof_name, sc_name = _read_global_profile_names(obs_root)

    latest = _latest_backup_summary()
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
        base["recording"]["format"] = (simple.get("RecFormat2") or simple.get("RecFormat") or "").strip()
        base["recording"]["output_path"] = _recording_output_path_from_simple(simple)
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
        vr = ws.call(obs_requests.GetVideoSettings())
        video_dims = _parse_ws_video(vr)
        fps = _fps_from_video_dict(video_dims)
        bw, bh = video_dims["base_width"], video_dims["base_height"]
        ow, oh = video_dims["output_width"], video_dims["output_height"]
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


def apply_recommended(
    obs_cfg,
    *,
    project_profile: Optional[str] = None,
    create_backup: bool = True,
    fix_scene: bool = True,
) -> dict[str, Any]:
    if sys.platform != "win32":
        raise ValueError("推荐预设应用仅支持 Windows（需要写入 %APPDATA%\\obs-studio）")
    obs_root = _obs_studio_root()
    if obs_root is None:
        raise ValueError("无法定位 OBS 配置目录")
    obs_root.mkdir(parents=True, exist_ok=True)

    pp = _effective_project_profile(obs_root, project_profile)

    cfg = load_config()
    backup_id = ""
    if create_backup:
        backup_id, _ = _create_backup(obs_root, reason="apply_recommended_preset", project_profile=pp)

    changed: list[str] = []
    prof_dir = _ensure_project_profile_folder(obs_root, pp)
    basic_ini = prof_dir / "basic.ini"

    bundled_src = _bundled_obs_basic_ini_path()
    bundled_used = bundled_src.is_file()

    if bundled_used:
        logger.info(
            "Applying OBS preset: template=%s -> profile_basic_ini=%s (profile=%s)",
            bundled_src.resolve(),
            basic_ini.resolve(),
            pp,
        )
        try:
            basic_ini.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(bundled_src, basic_ini)
        except OSError as e:
            raise ValueError(
                f"无法写入 OBS Profile（复制预设失败）。若 OBS 正在运行，请先完全退出 OBS 后再应用预设。详情：{e}"
            ) from e
        if not filecmp.cmp(bundled_src, basic_ini, shallow=False):
            raise ValueError(
                "预设未能正确写入磁盘（写入后校验失败）。请先关闭 OBS，再重新点击「一键应用推荐预设」。"
            )
        changed.append("copied_data_basic_ini_to_obs_profile")
    else:
        simple_merge = _parse_simple_output(basic_ini)
        enc_merge = _pick_rec_encoder_from_simple(simple_merge, None)
        _merge_write_simple_output(
            basic_ini,
            {
                "RecEncoder": enc_merge,
                "Encoder": simple_merge.get("Encoder") or enc_merge,
                "RecFormat2": "mkv",
                "RecUseStreamEncoder": "false",
                "UseStreamEncoder": "false",
            },
        )
        changed.append("updated_project_profile_ini")

    simple_before = _parse_simple_output(basic_ini)
    encoder_pick = _pick_rec_encoder_from_simple(simple_before, None)

    if _set_global_ini_current_profile(obs_root, pp):
        changed.append("set_active_profile_to_project")

    bw, bh, ow, oh, fps_v = _parse_basic_ini_video_dims(basic_ini)

    restart_obs_required = True
    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        cs2_fps_max=cfg.cs2_fps_max,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )
    try:
        if director.connect_obs() and director.obs_ws:
            ws = director.obs_ws
            if _obs_is_recording(ws):
                logger.warning("apply_recommended: OBS 正在录制，跳过 WebSocket 同步")
                changed.append("websocket_sync_skipped_recording")
            else:
                _try_set_video_and_profile_params(
                    ws,
                    base_w=bw,
                    base_h=bh,
                    fps=fps_v,
                    encoder=encoder_pick,
                    output_width=ow,
                    output_height=oh,
                    project_profile=pp,
                    basic_ini_path=basic_ini,
                    sync_simple_output_from_disk=bundled_used,
                )
                changed.append("websocket_video_and_simple_output")
                restart_obs_required = False

                if fix_scene:
                    sn = _dedicated_scene_name()
                    cn = _dedicated_capture_name()
                    vr = ws.call(obs_requests.GetVideoSettings())
                    vd = _parse_ws_video(vr)
                    bw_run = int(vd["base_width"] or bw)
                    bh_run = int(vd["base_height"] or bh)
                    if _apply_scale_inner_transform(ws, sn, cn, bw_run, bh_run):
                        changed.append("fixed_capture_source_transform")
        else:
            logger.info("apply_recommended: WebSocket 未连接，仅完成磁盘预设写入")
            changed.append("websocket_sync_skipped_no_connection")
    except Exception as e:
        logger.warning("apply_recommended: WebSocket 同步异常（磁盘已写入）: %s", e, exc_info=True)
        changed.append("websocket_sync_failed")
    finally:
        director.disconnect_obs()

    if bundled_used:
        restart_obs_required = True

    if bundled_used:
        summary_msg = (
            "已写入预设模板。若写入时 OBS 曾处于运行状态，配置可能不会完全生效；推荐在关闭 OBS 后重新应用一次，然后启动 OBS。"
            "（应用后请重启 OBS 查看完整效果。）"
        )
    else:
        summary_msg = (
            "已应用推荐 OBS 录制预设。修改配置文件时同样建议在 OBS 关闭后进行更稳妥；完成后重启 OBS。"
        )

    return {
        "ok": True,
        "backup_id": backup_id,
        "changed": changed,
        "restart_obs_required": restart_obs_required,
        "bundled_basic_ini_applied": bundled_used,
        "project_profile": pp,
        "basic_ini_path": str(basic_ini.resolve()),
        "preset_template_path": str(bundled_src.resolve()) if bundled_used else None,
        "message": summary_msg,
    }


def import_cs2obs_bytes(
    data: dict[str, Any],
    obs_cfg,
    *,
    project_profile: Optional[str] = None,
    create_backup: bool = True,
) -> dict[str, Any]:
    ok, err = validate_cs2obs_payload(data)
    if not ok:
        raise ValueError(err)
    if sys.platform != "win32":
        raise ValueError("导入预设仅支持 Windows（需要写入 OBS 配置目录）")
    obs_root = _obs_studio_root()
    if obs_root is None:
        raise ValueError("无法定位 OBS 配置目录")
    obs_root.mkdir(parents=True, exist_ok=True)

    pp = _effective_project_profile(obs_root, project_profile)

    cfg = load_config()
    backup_id = ""
    if create_backup:
        backup_id, _ = _create_backup(obs_root, reason="import_cs2obs_preset", project_profile=pp)

    v = data["video"]
    fps = int(v["fps"])
    bw = int(v["base_width"])
    bh = int(v["base_height"])
    ow = int(v.get("output_width") or bw)
    oh = int(v.get("output_height") or bh)
    rec = data.get("recording") or {}
    use_stream = bool(rec.get("use_stream_encoder", False))
    rec_fmt = str(rec.get("format") or "mkv").strip() or "mkv"

    prof_dir = _ensure_project_profile_folder(obs_root, pp)
    basic_ini = prof_dir / "basic.ini"
    simple_before = _parse_simple_output(basic_ini)
    encoder_pick = _pick_rec_encoder_from_simple(simple_before, None)

    _merge_write_simple_output(
        basic_ini,
        {
            "RecEncoder": encoder_pick,
            "RecUseStreamEncoder": "true" if use_stream else "false",
            "UseStreamEncoder": "true" if use_stream else "false",
            "RecFormat2": str(rec.get("format") or "mkv"),
        },
    )
    _set_global_ini_current_profile(obs_root, pp)

    changed = ["set_video", "set_recording_encoder_policy"]
    restart_obs_required = True
    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        cs2_fps_max=cfg.cs2_fps_max,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )
    try:
        if not director.connect_obs():
            raise ValueError("无法连接 OBS WebSocket")
        ws = director.obs_ws
        if not ws:
            raise ValueError("OBS WebSocket 未就绪")
        if _obs_is_recording(ws):
            raise ValueError("OBS 正在录制中，请停止录制后再修改配置。")
        _try_set_video_and_profile_params(
            ws,
            base_w=bw,
            base_h=bh,
            fps=fps,
            encoder=encoder_pick,
            output_width=ow,
            output_height=oh,
            rec_format=rec_fmt,
            project_profile=pp,
            sync_simple_output_from_disk=False,
        )
        restart_obs_required = False
        sn = _dedicated_scene_name()
        cn = _dedicated_capture_name()
        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        bwv = int(vd["base_width"] or bw)
        bhv = int(vd["base_height"] or bh)
        if _apply_scale_inner_transform(ws, sn, cn, bwv, bhv):
            changed.append("fixed_capture_source_transform")
    finally:
        director.disconnect_obs()

    return {
        "ok": True,
        "backup_id": backup_id,
        "preset_name": str(data.get("name") or ""),
        "changed": changed,
        "restart_obs_required": restart_obs_required,
    }


def export_cs2obs_dict(obs_cfg) -> dict[str, Any]:
    ws: Optional[obsws] = None
    try:
        ws = _ws_connect(obs_cfg)
        vr = ws.call(obs_requests.GetVideoSettings())
        vd = _parse_ws_video(vr)
        fps = _fps_from_video_dict(vd)
        payload = {
            "name": "Exported OBS preset",
            "version": 1,
            "video": {
                "base_width": int(vd["base_width"] or 1920),
                "base_height": int(vd["base_height"] or 1080),
                "output_width": int(vd["output_width"] or vd["base_width"] or 1920),
                "output_height": int(vd["output_height"] or vd["base_height"] or 1080),
                "fps": fps,
            },
            "recording": {
                "use_stream_encoder": False,
                "format": "mkv",
                "encoder": "auto",
            },
            "scene": {"fit_to_screen": True, "scale_filter": "bicubic", "bounds_type": "OBS_BOUNDS_SCALE_INNER"},
        }
        obs_root = _obs_studio_root()
        if obs_root:
            prof_name, _ = _read_global_profile_names(obs_root)
            if prof_name:
                simple = _parse_simple_output(obs_root / "basic" / "profiles" / prof_name / "basic.ini")
                payload["recording"]["use_stream_encoder"] = _detect_use_stream_encoder(simple, ws)
                payload["recording"]["format"] = (simple.get("RecFormat2") or "mkv").strip() or "mkv"
        return _strip_sensitive_for_export(payload)
    finally:
        _ws_disconnect(ws)


def import_native_files(
    files: list[tuple[str, bytes]],
    obs_cfg,
    *,
    project_profile: Optional[str] = None,
    create_backup: bool = True,
) -> dict[str, Any]:
    if sys.platform != "win32":
        raise ValueError("原生配置导入仅支持 Windows")
    obs_root = _obs_studio_root()
    if obs_root is None:
        raise ValueError("无法定位 OBS 配置目录")
    obs_root.mkdir(parents=True, exist_ok=True)

    pp = _effective_project_profile(obs_root, project_profile)

    imported: list[str] = []
    skipped: list[dict[str, str]] = []
    prof_dir = _ensure_project_profile_folder(obs_root, pp)

    backup_id = ""
    if create_backup:
        backup_id, _ = _create_backup(obs_root, reason="import_native_config", project_profile=pp)

    for name, raw in files:
        base = Path(name).name
        if base not in NATIVE_ALLOWLIST:
            skipped.append({"file": base, "reason": "文件名不在白名单"})
            continue
        if len(raw) > NATIVE_MAX_BYTES:
            skipped.append({"file": base, "reason": "文件超过 1MB 限制"})
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            skipped.append({"file": base, "reason": "无法按 UTF-8 解码"})
            continue
        bad = _reject_native_content_if_sensitive(text, base)
        if bad:
            skipped.append({"file": base, "reason": bad})
            continue
        if base.endswith(".json"):
            try:
                json.loads(text)
            except json.JSONDecodeError:
                skipped.append({"file": base, "reason": "JSON 格式无效"})
                continue
        else:
            cp = configparser.ConfigParser(interpolation=None)
            try:
                cp.read_string(text)
            except configparser.Error:
                skipped.append({"file": base, "reason": "INI 格式无效"})
                continue
        dest = prof_dir / base
        dest.write_bytes(raw)
        imported.append(base)

    ws_flags: list[str] = []
    ws: Optional[obsws] = None
    if imported:
        try:
            try:
                ws = _ws_connect(obs_cfg)
                if _obs_is_recording(ws):
                    logger.warning("import_native_files: OBS 正在录制，文件已写入 Profile")
                    ws_flags.append("recording_active")
            except Exception as e:
                logger.info("import_native_files: WebSocket 不可用，跳过录制检测（磁盘已写入）: %s", e)
                ws_flags.append("websocket_skipped")
        finally:
            _ws_disconnect(ws)

    if imported:
        msg_parts = [
            "已将所选文件写入当前 OBS Profile 目录。",
            "为保证生效，建议先完全退出 OBS 再导入；完成后重新启动 OBS。",
        ]
        if "websocket_skipped" in ws_flags:
            msg_parts.append("（未连接 WebSocket，仅完成磁盘写入。）")
        if "recording_active" in ws_flags:
            msg_parts.append("（检测到 OBS 正在录制，文件已落盘，建议停止录制并重启 OBS 后再试。）")
        message = "".join(msg_parts)
    else:
        message = (
            "没有文件被写入（全部被跳过或校验失败）。请确认文件名在白名单内且格式有效。"
            "若曾备份，可在下方备份列表中恢复。"
        )

    return {
        "ok": True,
        "backup_id": backup_id,
        "imported": imported,
        "skipped": skipped,
        "restart_obs_required": bool(imported),
        "message": message,
    }


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
