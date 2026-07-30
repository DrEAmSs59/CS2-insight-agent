"""产物 JSON 是时序自检唯一的落盘出口，两条录制路径都必须写。

``calibration_markers`` 只存在于 ``ExecutionResult`` 里，不进 ``clip_meta``。V3 流水线
(``obs_director``) 原本执行完根本不写产物 JSON，表现是"录制完全正常但没有任何东西可测"，
而且不报错。这里把两件容易再次走丢的事钉住：V3 有调用、且传的是重命名之后的路径。
"""

import json
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.recording.executor.recording_executor import ExecutionResult
from app.recording.services.result_writer import default_results_dir, write_result


def _result(**kwargs) -> ExecutionResult:
    base = {
        "request_id": "req-1234567890",
        "success": True,
        "output_path": r"C:\obs\raw.mp4",
    }
    base.update(kwargs)
    return ExecutionResult(**base)


class TestWriteResult:
    def test_persists_the_calibration_markers(self, tmp_path):
        result = _result(
            calibration_markers=[{"video_sec": 1.5, "tick": 100, "offset_ticks": 6}],
            kill_markers=[{"video_sec": 2.0}],
        )

        out = write_result(result, tmp_path)
        data = json.loads(out.read_text(encoding="utf-8"))

        assert data["calibration_markers"] == [
            {"video_sec": 1.5, "tick": 100, "offset_ticks": 6}
        ]
        assert data["kill_markers"] == [{"video_sec": 2.0}]

    def test_filename_carries_the_request_id_prefix(self, tmp_path):
        out = write_result(_result(), tmp_path)

        assert out.name.endswith("_req-1234.json")

    def test_output_path_override_wins(self, tmp_path):
        """V3 重命名之后，result 里的路径已经指向不存在的文件。"""
        renamed = r"D:\clips\ace_on_mirage.mp4"

        out = write_result(_result(), tmp_path, output_path=renamed)

        assert json.loads(out.read_text(encoding="utf-8"))["output_path"] == renamed

    def test_falls_back_to_the_executor_path(self, tmp_path):
        out = write_result(_result(), tmp_path, output_path=None)

        assert json.loads(out.read_text(encoding="utf-8"))["output_path"] == r"C:\obs\raw.mp4"

    def test_creates_the_directory(self, tmp_path):
        target = tmp_path / "nested" / "results"

        out = write_result(_result(), target)

        assert out.parent == target


class TestDefaultResultsDir:
    def test_follows_the_data_dir_override(self, tmp_path, monkeypatch):
        """安装版的 resources 目录不可写，产物必须跟着可写数据目录走。"""
        monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))

        assert default_results_dir() == tmp_path.resolve() / "recording_results"

    def test_defaults_under_the_repo_data_dir(self, monkeypatch):
        monkeypatch.delenv("CS2_INSIGHT_DATA_DIR", raising=False)

        resolved = default_results_dir()

        assert resolved.name == "recording_results"
        assert resolved.parent.name == "data"


def test_v3_pipeline_writes_the_result_with_the_renamed_path():
    """守住结构：V3 执行完必须写产物，且传的是 final_output_path。

    这条不是单元测试而是源码断言——V3 的执行体嵌在一个需要 CS2、OBS、GSI 的长流程里，
    没法在单测里跑到；但"忘记写产物"这个疏漏本身完全可以在源码层面挡住。
    """
    source = (_BACKEND_ROOT / "app" / "obs_director.py").read_text(encoding="utf-8")

    assert "write_result(result, output_path=final_output_path)" in source
    assert "from .recording.services.result_writer import write_result" in source
