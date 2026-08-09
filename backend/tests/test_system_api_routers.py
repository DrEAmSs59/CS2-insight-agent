from __future__ import annotations

from app.api.config_backup import router as config_backup_router
from app.api.gsi import router as gsi_router


def _route_methods(router) -> dict[str, set[str]]:
    return {
        route.path: set(route.methods or set())
        for route in router.routes
    }


def test_config_backup_router_preserves_public_contract():
    assert _route_methods(config_backup_router) == {
        "/api/config-backup/status": {"GET"},
        "/api/config-backup/restore": {"POST"},
        "/api/config-backup/open-dir": {"POST"},
    }


def test_gsi_router_preserves_public_contract():
    assert _route_methods(gsi_router) == {
        "/api/gsi/cs2": {"POST"},
        "/api/gsi/status": {"GET"},
    }
