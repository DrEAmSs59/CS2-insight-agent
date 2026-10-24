"""Reject a stale Skin Core before packaging the desktop app.

Exercise the real encrypted IPC and parent gate with intentionally empty requests.
No Demo is read or written; full rewrite acceptance is a separate check.
"""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True


def verify(executable: Path) -> None:
    crypto = runpy.run_path(str(Path(__file__).resolve().parents[2] / "backend/app/skin_core_crypto.py"))
    env = os.environ.copy()
    for name in ("CS2_SKIN_CORE_DEV", "CS2_INSIGHT_DEV"):
        env.pop(name, None)
    with tempfile.TemporaryDirectory(prefix="skin-core-contract-") as directory:
        root = Path(directory)
        source, output = str(root / "missing.dem"), str(root / "output.dem")
        for schema in (1, 2, 3):
            request = {"schema_version": schema, "steam_id64": "76561198000000001", "items": []}
            expected = "items must not be empty"
            if schema == 3:
                request["player_loadout"] = {}
                expected = "player_loadout must select an agent or music kit"
            key = os.urandom(32)
            request_path, response_path = root / f"request-{schema}.bin", root / f"response-{schema}.bin"
            request_path.write_bytes(crypto["encrypt_request"](key, source, output, json.dumps(request).encode()))
            process = subprocess.run(
                [str(executable), "rewrite-owned-batch", "--input", source, "--output", output,
                 "--request", str(request_path), "--response", str(response_path),
                 "--demoparser2-python", sys.executable],
                input=crypto["build_session_key_frame"](key), capture_output=True, timeout=30,
                env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if process.returncode != 1 or not response_path.is_file():
                raise RuntimeError(f"Skin Core schema {schema} IPC/gate check failed (exit {process.returncode})")
            result = json.loads(crypto["decrypt_response"](key, source, output, response_path.read_bytes()))
            if result.get("ok") is not False or result.get("error_message") != expected or Path(output).exists():
                raise RuntimeError(f"Incompatible Skin Core for schema {schema}: {result}")
    print("Skin Core encrypted IPC accepts schemas 1, 2 and 3; parent gate enabled.")


if __name__ == "__main__":
    verify(Path(sys.argv[1]).resolve())
