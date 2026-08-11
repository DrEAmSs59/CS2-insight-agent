"""Unified in-process ownership for LiteCut background jobs."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable, Protocol


class OwnedJob(Protocol):
    status: str
    error: str
    cancel_event: Any
    task: asyncio.Task | None


@dataclass(frozen=True)
class JobHandle:
    job_type: str
    job_id: int | str
    job: OwnedJob

    @property
    def status(self) -> str:
        return str(getattr(self.job, "status", "unknown"))

    @property
    def stage(self) -> str:
        return str(getattr(self.job, "stage", self.status))

    @property
    def progress(self) -> float:
        return max(0.0, min(1.0, float(getattr(self.job, "progress", 0.0) or 0.0)))

    @property
    def error(self) -> str:
        return str(getattr(self.job, "error", "") or "")

    @property
    def task(self) -> asyncio.Task | None:
        return getattr(self.job, "task", None)

    def cancel(self) -> None:
        self.job.cancel_event.set()

    def snapshot(self, snapshotter: Callable[[Any], dict[str, Any]] | None = None) -> dict[str, Any]:
        if snapshotter is not None:
            return snapshotter(self.job)
        return {
            "id": self.job_id,
            "type": self.job_type,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "error": self.error,
        }


class JobRegistry:
    """Event-loop-safe registry; persistence/restart recovery remains adapter-owned."""

    def __init__(self):
        self._jobs: dict[str, dict[int | str, OwnedJob]] = {}
        self._semaphores: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Semaphore, int]] = {}

    def bucket(self, job_type: str) -> dict[int | str, OwnedJob]:
        return self._jobs.setdefault(str(job_type), {})

    def register(self, job_type: str, job_id: int | str, job: OwnedJob) -> JobHandle:
        self.bucket(job_type)[job_id] = job
        return JobHandle(job_type, job_id, job)

    def get(self, job_type: str, job_id: int | str) -> JobHandle | None:
        job = self.bucket(job_type).get(job_id)
        return JobHandle(job_type, job_id, job) if job is not None else None

    def remove(self, job_type: str, job_id: int | str) -> OwnedJob | None:
        return self.bucket(job_type).pop(job_id, None)

    def handles(self) -> list[JobHandle]:
        return [JobHandle(job_type, job_id, job) for job_type, jobs in self._jobs.items() for job_id, job in jobs.items()]

    def semaphore(self, name: str, limit: int) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        current = self._semaphores.get(name)
        if current is None or current[0] is not loop or current[2] != limit:
            semaphore = asyncio.Semaphore(limit)
            self._semaphores[name] = (loop, semaphore, limit)
            return semaphore
        return current[1]

    async def shutdown(self, timeout_sec: float = 10.0) -> bool:
        active = [handle for handle in self.handles() if handle.task is not None and not handle.task.done()]
        for handle in active:
            handle.cancel()
        if not active:
            return True
        _done, pending = await asyncio.wait(
            [handle.task for handle in active if handle.task is not None],
            timeout=max(0.0, timeout_sec),
        )
        return not pending
