"""Remove retired Insight overlays from the active OBS scene collection."""

from __future__ import annotations

import logging

from obswebsocket import obsws, requests as obs_requests

logger = logging.getLogger(__name__)

_RETIRED_OVERLAY_NAMES = frozenset({
    "CS2 Keyboard Overlay",
    "CS2 Kill FX Overlay",
})


def cleanup_legacy_overlay_sources(ws: obsws) -> None:
    """Best-effort migration after connection; retry on every new connection.

    Match the exact names and browser kind used by older Insight versions.
    RemoveInput also removes references in every scene of the active collection.
    """
    try:
        response = ws.call(obs_requests.GetInputList())
        if response.status is False:
            logger.warning("OBS rejected the retired overlay source lookup")
            return
        inputs = (response.datain or {}).get("inputs") or []
        names = {
            item.get("inputName")
            for item in inputs
            if isinstance(item, dict)
            and item.get("inputName") in _RETIRED_OVERLAY_NAMES
            and (item.get("unversionedInputKind") or item.get("inputKind")) == "browser_source"
        }
    except Exception as exc:
        logger.warning("Could not check retired OBS overlay sources: %s", exc)
        return

    for name in sorted(names):
        try:
            response = ws.call(obs_requests.RemoveInput(inputName=name))
            if response.status is False:
                logger.warning("OBS rejected removal of retired overlay source %r", name)
                continue
            logger.info("Removed retired OBS overlay source %r", name)
        except Exception as exc:
            logger.warning("Could not remove retired OBS overlay source %r: %s", name, exc)
