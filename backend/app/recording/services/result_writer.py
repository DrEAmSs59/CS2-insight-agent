import json
import logging
from datetime import datetime, timezone
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from ...recording.executor.recording_executor import ExecutionResult

logger = logging.getLogger(__name__)

_DEFAULT_RESULTS_DIR = Path(__file__).resolve().parents[4] / "data" / "recording_results"

def write_result(result: ExecutionResult, results_dir: Optional[Path] = None) -> Path:
    """Write an ExecutionResult to a JSON file in results_dir."""
    out_dir = results_dir or _DEFAULT_RESULTS_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{ts}_{(result.request_id or 'unknown')[:8]}.json"
    out_path = out_dir / filename
    data = {
        "written_at": ts,
        "request_id": result.request_id,
        "success": result.success,
        "output_path": result.output_path,
        "warnings": result.warnings,
        "error": result.error,
        "segments": [asdict(s) for s in result.segment_results],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info("Recording result written to %s", out_path)
    return out_path
