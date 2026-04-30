"""Run demoparser work in a child process so native crashes do not kill FastAPI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


class IsolatedParseError(RuntimeError):
    pass


def _timeout_seconds() -> float:
    raw = (os.environ.get("CS2_INSIGHT_PARSE_WORKER_TIMEOUT_SEC") or "240").strip()
    try:
        return max(10.0, float(raw))
    except ValueError:
        return 240.0


def run_parse_worker(action: str, **payload: Any) -> Any:
    req = {"action": action, **payload}
    timeout = _timeout_seconds()
    tmp_dir = Path(tempfile.gettempdir()) / "cs2_insight_parse_workers"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", dir=tmp_dir, delete=False) as rf:
        json.dump(req, rf, ensure_ascii=False)
        req_path = Path(rf.name)
    out_path = tmp_dir / f"{req_path.stem}.out.json"
    err_path = tmp_dir / f"{req_path.stem}.err.txt"
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    worker_path = Path(__file__).with_name("parse_worker.py")
    cmd = [sys.executable, str(worker_path), str(req_path), str(out_path)]
    try:
        with err_path.open("w", encoding="utf-8", errors="replace") as err_file:
            cp = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=err_file,
                text=False,
                timeout=timeout,
                env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
    except subprocess.TimeoutExpired as e:
        raise IsolatedParseError(f"解析超时（>{timeout:.0f}s），worker 已被终止") from e
    finally:
        try:
            req_path.unlink()
        except OSError:
            pass

    stderr_tail = ""
    try:
        stderr_tail = err_path.read_text(encoding="utf-8", errors="replace")[-2000:].strip()
    except OSError:
        pass
    finally:
        try:
            err_path.unlink()
        except OSError:
            pass

    if cp.returncode != 0:
        detail = f"解析 worker 退出码 {cp.returncode}"
        if stderr_tail:
            detail += f": {stderr_tail}"
        raise IsolatedParseError(detail)
    if not out_path.is_file():
        raise IsolatedParseError("解析 worker 未返回结果")
    try:
        data = json.loads(out_path.read_text(encoding="utf-8"))
    finally:
        try:
            out_path.unlink()
        except OSError:
            pass
    if not data.get("ok"):
        raise IsolatedParseError(str(data.get("error") or "解析失败"))
    return data.get("result")


def analyze_demo_isolated(dem_path: str, target_player: str) -> dict:
    result = run_parse_worker("analyze", dem_path=dem_path, target_player=target_player)
    if not isinstance(result, dict):
        raise IsolatedParseError("解析 worker 返回了无效结果")
    return result


def get_player_list_isolated(dem_path: str) -> list[dict]:
    result = run_parse_worker("players", dem_path=dem_path)
    if not isinstance(result, list):
        raise IsolatedParseError("玩家列表 worker 返回了无效结果")
    return result


def get_demo_match_summary_isolated(dem_path: str) -> dict:
    result = run_parse_worker("summary", dem_path=dem_path)
    if not isinstance(result, dict):
        raise IsolatedParseError("Demo 摘要 worker 返回了无效结果")
    return result
