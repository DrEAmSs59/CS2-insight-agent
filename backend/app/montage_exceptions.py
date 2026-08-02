"""Structured exceptions shared by montage and LiteCut export pipelines."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence


class MontageComposerError(Exception):
    """An export error that can be mapped to a stable API error code."""

    def __init__(self, code: str, **params: Any):
        self.code = code
        self.params = params
        super().__init__(code)


class HardwareEncoderFailure(MontageComposerError):
    """A retryable failure attributable to the active hardware encoder."""

    def __init__(
        self,
        *,
        codec: str,
        stage: str,
        returncode: int | None = None,
        stderr: str = "",
        artifact_path: str | Path | None = None,
        public_code: str = "MONTAGE_HARDWARE_ENCODER_FAILED",
        public_params: dict[str, Any] | None = None,
        command: Sequence[str] | None = None,
    ):
        params = dict(public_params or {})
        params.update(
            {
                "encoder": codec,
                "stage": stage,
            },
        )
        if artifact_path is not None:
            params["name"] = Path(artifact_path).name
        super().__init__(public_code, **params)
        self.codec = codec
        self.stage = stage
        self.returncode = returncode
        self.stderr = str(stderr or "")
        self.artifact_path = str(artifact_path) if artifact_path is not None else ""
        self.command = tuple(str(item) for item in (command or ()))
