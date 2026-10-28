"""实验档运行时 staging 的回归测试（不依赖 CS2 / ffmpeg）。"""

import json
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.experimental_nr_staging import (  # noqa: E402
    AGENT_FILES,
    GENERATED_PATTERNS,
    cs2_bin_dir,
    stage_runtime,
    unstage_runtime,
)

_RUNTIME_PAYLOAD = {
    "dxgi.dll": b"staged-reshade",
    "amd-nr.addon64": b"staged-addon",
    "dlssnr_amd_pass1.dll": b"staged-runtime",
    "dlssnr_on_amd_weights.bin": b"staged-weights",
}


def _make_env(tmp_path: Path) -> tuple[Path, Path]:
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    for name, data in _RUNTIME_PAYLOAD.items():
        (runtime_dir / name).write_bytes(data)
    cs2_bin = tmp_path / "cs2" / "game" / "bin" / "win64"
    cs2_bin.mkdir(parents=True)
    return runtime_dir, cs2_bin


def test_stage_unstage_roundtrip_restores_original_files(tmp_path: Path) -> None:
    runtime_dir, cs2_bin = _make_env(tmp_path)
    (cs2_bin / "dxgi.dll").write_bytes(b"original-dxgi")
    log_path = tmp_path / "run.log"

    manifest = stage_runtime(runtime_dir, cs2_bin, log_path)

    assert manifest["staged"] == list(_RUNTIME_PAYLOAD)
    assert (cs2_bin / "dxgi.dll").read_bytes() == b"staged-reshade"
    backup = cs2_bin / "dxgi.dll.cs2insight-bak"
    assert backup.is_file() and backup.read_bytes() == b"original-dxgi"
    assert (cs2_bin / ".cs2insight-staging.json").is_file()
    assert (cs2_bin / "amd-nr.addon64").read_bytes() == b"staged-addon"

    # 抓帧过程中 add-on 会生成日志与多 pass 副本，卸载时应一并清掉
    (cs2_bin / "amd-nr.log").write_text("frame 1 processed", encoding="utf-8")
    (cs2_bin / "amd-nr-pass1.dll").write_bytes(b"generated")

    unstage_runtime(manifest, log_path)

    assert (cs2_bin / "dxgi.dll").read_bytes() == b"original-dxgi"
    for name in _RUNTIME_PAYLOAD:
        if name == "dxgi.dll":
            continue
        assert not (cs2_bin / name).exists(), name
    for name in GENERATED_PATTERNS:
        assert not (cs2_bin / name).exists(), name
    assert not (cs2_bin / ".cs2insight-staging.json").exists()
    assert not (cs2_bin / "dxgi.dll.cs2insight-bak").exists()
    # 日志另存一份，便于排查
    assert (tmp_path / f"{log_path.name}.amd-nr.log").is_file()


def test_stage_twice_keeps_single_original_backup(tmp_path: Path) -> None:
    runtime_dir, cs2_bin = _make_env(tmp_path)
    (cs2_bin / "dxgi.dll").write_bytes(b"original-dxgi")

    manifest = stage_runtime(runtime_dir, cs2_bin)
    manifest_again = stage_runtime(runtime_dir, cs2_bin)

    backup = cs2_bin / "dxgi.dll.cs2insight-bak"
    assert backup.read_bytes() == b"original-dxgi"
    assert manifest_again["backups"] == []
    assert (cs2_bin / "dxgi.dll").read_bytes() == b"staged-reshade"

    unstage_runtime(manifest_again)
    assert (cs2_bin / "dxgi.dll").read_bytes() == b"original-dxgi"
    assert manifest["backups"], "首次 staging 应记录备份"


def test_stage_records_manifest_on_disk(tmp_path: Path) -> None:
    runtime_dir, cs2_bin = _make_env(tmp_path)
    stage_runtime(runtime_dir, cs2_bin)
    payload = json.loads((cs2_bin / ".cs2insight-staging.json").read_text(encoding="utf-8"))
    assert payload["cs2_bin"] == str(cs2_bin)
    assert sorted(payload["staged"]) == sorted(_RUNTIME_PAYLOAD)


def test_cs2_bin_dir_handles_missing_input() -> None:
    assert cs2_bin_dir(None) is None
    assert cs2_bin_dir(Path("Z:/definitely/missing/cs2.exe")) is None


def test_agent_files_contract() -> None:
    # 面板/文档/后端共享同一份清单；增删文件时三个地方一起改
    assert "dxgi.dll" in AGENT_FILES
    assert "amd-nr.addon64" in AGENT_FILES
    assert "dlssnr_amd_pass1.dll" in AGENT_FILES
    assert "dlssnr_on_amd_weights.bin" in AGENT_FILES
