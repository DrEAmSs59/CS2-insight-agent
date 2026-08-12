"""Versioned, read-only LiteCut contracts packaged with the backend."""

from __future__ import annotations

from importlib.resources import files
from importlib.resources.abc import Traversable


def contract_resource(filename: str) -> Traversable:
    """Return a packaged LiteCut contract without depending on the repository layout."""
    return files(__package__).joinpath(filename)


__all__ = ["contract_resource"]
