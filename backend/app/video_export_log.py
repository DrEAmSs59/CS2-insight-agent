"""Dedicated, bounded diagnostics for LiteCut and Montage video exports."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from functools import wraps
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, TypeVar


VIDEO_EXPORT_LOG_NAME = "backend-video-export.log"
VIDEO_EXPORT_LOG_MAX_BYTES = 20 * 1024 * 1024
VIDEO_EXPORT_LOG_BACKUP_COUNT = 5
VIDEO_EXPORT_PROGRESS_HEARTBEAT_SECONDS = 10.0
_MAX_TEXT_CHARS = 16_000
_HANDLER_MARKER = "_cs2_video_export_handler"
_EVENT_LOGGER_NAME = "app.video_export.event"


@dataclass
class VideoExportContext:
    session_id: str
    feature: str
    phase: str
    started_monotonic: float
    database_export_id: int | str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    progress_stage: str = ""
    progress_bucket: int = -1
    progress_emitted_at: float = 0.0
    first_frame_emitted: bool = False
    progress_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


_current_context: ContextVar[VideoExportContext | None] = ContextVar(
    "video_export_context",
    default=None,
)
_event_logger = logging.getLogger(_EVENT_LOGGER_NAME)
_event_logger.setLevel(logging.INFO)
_event_logger.propagate = False
_event_logger.addHandler(logging.NullHandler())
_configure_lock = threading.Lock()


def _truncate(value: object, limit: int = _MAX_TEXT_CHARS) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[-limit:]


def _json_safe(value: object, *, depth: int = 0) -> object:
    if depth >= 5:
        return _truncate(value, 1000)
    if value is None or isinstance(value, (bool, int, float, str)):
        return _truncate(value) if isinstance(value, str) else value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {
            _truncate(key, 200): _json_safe(item, depth=depth + 1)
            for key, item in list(value.items())[:100]
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item, depth=depth + 1) for item in list(value)[:100]]
    return _truncate(value)


def _exception_code(exc: BaseException) -> str:
    code = getattr(exc, "code", None)
    if code:
        return str(code)
    detail = getattr(exc, "detail", None)
    if isinstance(detail, Mapping) and detail.get("code"):
        return str(detail["code"])
    return type(exc).__name__


class _VideoExportContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        context = _current_context.get()
        if context is None:
            return False
        record.video_export_context = context  # type: ignore[attr-defined]
        return True


class _VideoExportJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        context = getattr(record, "video_export_context", None) or _current_context.get()
        if context is None:
            return ""
        payload: dict[str, object] = {
            "timestamp": datetime.now().astimezone().isoformat(timespec="milliseconds"),
            "session_id": context.session_id,
            "feature": context.feature,
            "phase": context.phase,
            "database_export_id": context.database_export_id,
            "session_elapsed_ms": round((time.monotonic() - context.started_monotonic) * 1000),
            "level": record.levelname,
            "event": getattr(record, "video_export_event", "log"),
            "logger": record.name,
            "thread": record.threadName,
            "process_id": os.getpid(),
        }
        payload.update({str(key): _json_safe(value) for key, value in context.metadata.items()})
        raw_fields = getattr(record, "video_export_fields", None)
        if isinstance(raw_fields, Mapping):
            payload.update({str(key): _json_safe(value) for key, value in raw_fields.items()})
        message = record.getMessage()
        if message:
            payload["message"] = _truncate(message)
        if record.exc_info:
            payload["exception"] = _truncate(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _video_export_handlers(logger: logging.Logger) -> list[logging.Handler]:
    return [
        handler
        for handler in logger.handlers
        if bool(getattr(handler, _HANDLER_MARKER, False))
    ]


def configure_video_export_logging(
    log_dir: Path,
    *,
    max_bytes: int = VIDEO_EXPORT_LOG_MAX_BYTES,
    backup_count: int = VIDEO_EXPORT_LOG_BACKUP_COUNT,
) -> Path:
    """Add a dedicated handler without changing any existing log handler."""

    destination = (Path(log_dir) / VIDEO_EXPORT_LOG_NAME).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    root_logger = logging.getLogger()
    with _configure_lock:
        existing = _video_export_handlers(root_logger)
        if existing and Path(getattr(existing[0], "baseFilename", "")).resolve() == destination:
            return destination

        for owner in (root_logger, _event_logger):
            for handler in _video_export_handlers(owner):
                owner.removeHandler(handler)
                handler.close()

        handler = RotatingFileHandler(
            destination,
            mode="a",
            maxBytes=max(1, int(max_bytes)),
            backupCount=max(1, int(backup_count)),
            encoding="utf-8",
        )
        setattr(handler, _HANDLER_MARKER, True)
        handler.setLevel(logging.INFO)
        handler.addFilter(_VideoExportContextFilter())
        handler.setFormatter(_VideoExportJsonFormatter())
        root_logger.addHandler(handler)
        _event_logger.addHandler(handler)
    return destination


def shutdown_video_export_logging() -> None:
    """Close only the dedicated export handler, primarily for orderly tests."""

    root_logger = logging.getLogger()
    with _configure_lock:
        handlers: dict[int, logging.Handler] = {}
        for owner in (root_logger, _event_logger):
            for handler in _video_export_handlers(owner):
                owner.removeHandler(handler)
                handlers[id(handler)] = handler
        for handler in handlers.values():
            handler.close()


def current_video_export_context() -> VideoExportContext | None:
    return _current_context.get()


def current_video_export_session_id() -> str | None:
    context = _current_context.get()
    return context.session_id if context is not None else None


def set_video_export_database_id(export_id: int | str) -> None:
    context = _current_context.get()
    if context is not None:
        context.database_export_id = export_id


def new_video_export_session_id(feature: str) -> str:
    timestamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    return f"{str(feature).strip().casefold()}-{timestamp}-{uuid.uuid4().hex[:8]}"


@contextmanager
def video_export_session(
    feature: str,
    *,
    session_id: str | None = None,
    database_export_id: int | str | None = None,
    phase: str = "request",
    metadata: Mapping[str, Any] | None = None,
    started_monotonic: float | None = None,
) -> Iterator[VideoExportContext]:
    context = VideoExportContext(
        session_id=session_id or new_video_export_session_id(feature),
        feature=str(feature),
        phase=str(phase),
        started_monotonic=(
            float(started_monotonic)
            if started_monotonic is not None
            else time.monotonic()
        ),
        database_export_id=database_export_id,
        metadata=dict(metadata or {}),
    )
    token = _current_context.set(context)
    try:
        yield context
    finally:
        _current_context.reset(token)


def export_event(
    event: str,
    *,
    level: int = logging.INFO,
    **fields: object,
) -> None:
    if _current_context.get() is None:
        return
    _event_logger.log(
        level,
        "",
        extra={
            "video_export_event": str(event),
            "video_export_fields": fields,
        },
    )


def export_gpu_inventory(adapters: object, *, source: str = "windows_dxgi_cim") -> None:
    """Record the complete host GPU inventory used by the encoder planner."""

    try:
        items = list(adapters)  # type: ignore[arg-type]
    except TypeError:
        items = []
    devices: list[dict[str, object]] = []
    for adapter in items:
        luid = getattr(adapter, "luid", "") or None
        pnp_device_id = getattr(adapter, "pnp_device_id", "") or None
        devices.append(
            {
                "enumeration_index": getattr(adapter, "enumeration_index", None),
                "performance_rank": getattr(adapter, "performance_rank", None),
                "name": getattr(adapter, "name", None),
                "vendor": getattr(adapter, "vendor", None),
                "kind": getattr(adapter, "kind", None),
                "device_id": getattr(adapter, "device_id", None) or None,
                "luid": luid,
                "pnp_device_id": pnp_device_id,
                "stable_id": getattr(adapter, "stable_id", None),
                "driver_version": getattr(adapter, "driver_version", None) or None,
                "dedicated_memory_bytes": getattr(adapter, "dedicated_memory_bytes", None),
                "encoder_device_index": getattr(adapter, "encoder_device_index", None),
                "identity_quality": (
                    "dxgi_luid" if luid else ("pnp_device_id" if pnp_device_id else "derived")
                ),
            }
        )
    export_event(
        "device_inventory",
        source=source,
        status="succeeded" if devices else "unavailable",
        device_count=len(devices),
        devices=devices,
    )


def export_progress(
    progress: float,
    stage: str,
    detail: Mapping[str, Any] | None = None,
) -> None:
    """Write at most one event per percentage point plus a stalled heartbeat."""

    context = _current_context.get()
    if context is None:
        return
    safe_progress = max(0.0, min(1.0, float(progress or 0.0)))
    normalized_stage = str(stage or "encoding")
    bucket = min(100, int(safe_progress * 100))
    now = time.monotonic()
    first_frame_fields: dict[str, object] | None = None
    with context.progress_lock:
        if (
            not context.first_frame_emitted
            and detail
            and int(detail.get("processed_frames") or 0) > 0
        ):
            context.first_frame_emitted = True
            first_frame_fields = {
                "source": "host_progress",
                "stage": normalized_stage,
                "processed_frames": detail.get("processed_frames"),
                "total_frames": detail.get("total_frames"),
                "elapsed_ms": round((now - context.started_monotonic) * 1000),
                "measurement": "first_host_progress_observation",
                "upper_bound": True,
            }
        stage_changed = normalized_stage != context.progress_stage
        heartbeat_due = now - context.progress_emitted_at >= VIDEO_EXPORT_PROGRESS_HEARTBEAT_SECONDS
        advanced = bucket > context.progress_bucket
        if not (stage_changed or heartbeat_due or advanced or first_frame_fields is not None):
            return
        if stage_changed:
            context.progress_bucket = -1
        context.progress_stage = normalized_stage
        context.progress_bucket = max(context.progress_bucket, bucket)
        context.progress_emitted_at = now
    if first_frame_fields is not None:
        export_event("first_frame", **first_frame_fields)
    fields: dict[str, object] = {
        "stage": normalized_stage,
        "progress": round(safe_progress, 6),
        "progress_percent": round(safe_progress * 100, 2),
    }
    if detail:
        for key in ("stage_progress", "processed_frames", "total_frames"):
            if key in detail:
                fields[key] = detail[key]
    export_event("progress", **fields)


F = TypeVar("F", bound=Callable[..., Any])


def video_export_endpoint(feature: str) -> Callable[[F], F]:
    """Create a request-scoped export session around an async API endpoint."""

    def decorate(func: F) -> F:
        @wraps(func)
        async def wrapped(*args: Any, **kwargs: Any) -> Any:
            with video_export_session(feature):
                export_event("request_received")
                try:
                    result = await func(*args, **kwargs)
                except BaseException as exc:
                    export_event(
                        "request_failed",
                        level=logging.ERROR,
                        error_code=_exception_code(exc),
                        error_type=type(exc).__name__,
                    )
                    raise
                response_status = (
                    str(result.get("status") or "completed")
                    if isinstance(result, Mapping)
                    else "completed"
                )
                export_event("request_completed", status=response_status)
                return result

        return wrapped  # type: ignore[return-value]

    return decorate
