import json
import logging
from datetime import datetime, timezone
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from ...recording.executor.recording_executor import ExecutionResult

logger = logging.getLogger(__name__)

def default_results_dir() -> Path:
    """产物目录：跟随 ``CS2_INSIGHT_DATA_DIR``。

    开发环境下就是仓库根的 ``data/recording_results``；安装版必须落到可写的应用数据目录，
    否则写在 ``Program Files`` 下的 ``resources`` 里会被拒绝——而写失败只有一条 warning
    日志，表现就是"录完了但没有产物"。
    """
    from ...env_utils import get_data_dir

    return get_data_dir() / "recording_results"


def write_result(
    result: ExecutionResult,
    results_dir: Optional[Path] = None,
    *,
    output_path: Optional[str] = None,
) -> Path:
    """Write an ExecutionResult to a JSON file in results_dir.

    ``output_path`` 用于覆盖成片路径：V3 流水线在执行结束后会按命名规则重命名成片，
    此时 ``result.output_path`` 已经指向不存在的旧文件，必须由调用方传入最终路径。
    """
    out_dir = results_dir or default_results_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{ts}_{(result.request_id or 'unknown')[:8]}.json"
    out_path = out_dir / filename
    data = {
        "written_at": ts,
        "request_id": result.request_id,
        "success": result.success,
        "output_path": output_path or result.output_path,
        "warnings": result.warnings,
        "error": result.error,
        "segments": [asdict(s) for s in result.segment_results],
        "kill_markers": result.kill_markers,
        "calibration_markers": result.calibration_markers,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("Recording result written to %s", out_path)
    return out_path
