"""Mutable process state shared by API routers and the application lifespan."""

from __future__ import annotations

from dataclasses import dataclass

from .demo_watcher import DemoWatcher


@dataclass(slots=True)
class ApplicationState:
    """Small, explicit home for resources whose lifetime is owned by FastAPI."""

    demo_watcher: DemoWatcher | None = None


application_state = ApplicationState()
