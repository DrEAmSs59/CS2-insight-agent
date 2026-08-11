from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass, field

from app.features.lite_cut.job_runtime import JobRegistry


@dataclass
class FakeJob:
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    error: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


def test_job_registry_preserves_type_specific_payload_behind_common_handle():
    registry = JobRegistry()
    job = FakeJob(status="running", stage="probing", progress=0.4)
    handle = registry.register("proxy", 12, job)

    assert registry.bucket("proxy")[12] is job
    assert handle.snapshot() == {
        "id": 12,
        "type": "proxy",
        "status": "running",
        "stage": "probing",
        "progress": 0.4,
        "error": "",
    }


def test_job_registry_shutdown_cancels_and_waits_for_owned_tasks():
    async def scenario():
        registry = JobRegistry()
        job = FakeJob(status="running")

        async def worker():
            while not job.cancel_event.is_set():
                await asyncio.sleep(0)

        job.task = asyncio.create_task(worker())
        registry.register("portable", "job-1", job)
        assert await registry.shutdown(1) is True
        assert job.cancel_event.is_set()
        assert job.task.done()

    asyncio.run(scenario())


def test_job_registry_recreates_semaphore_for_each_event_loop():
    registry = JobRegistry()

    async def acquire_identity():
        first = registry.semaphore("proxy", 2)
        assert first is registry.semaphore("proxy", 2)
        return id(first)

    first_id = asyncio.run(acquire_identity())
    second_id = asyncio.run(acquire_identity())
    assert first_id != second_id
