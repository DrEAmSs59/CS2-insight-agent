# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.recording.executor import spec_controller as spec


def test_name_fallback_quotes_unicode_and_spaces(monkeypatch):
    inject = Mock()
    monkeypatch.setattr(spec, "inject_console_sequence", inject)
    monkeypatch.setattr(spec.asyncio, "sleep", AsyncMock())
    asyncio.run(spec.spec_player("京介 🦋"))
    inject.assert_called_once_with(["spec_mode 5", 'spec_player "京介 🦋"'])


@pytest.mark.parametrize("name", ["", " ", "x;quit", 'x";quit', "x\nquit", "x\rquit", "x\x00quit", "x\\"])
def test_unsafe_fallback_never_sends_a_console_command(monkeypatch, name):
    inject = Mock()
    monkeypatch.setattr(spec, "inject_console_sequence", inject)
    with pytest.raises(ValueError):
        asyncio.run(spec.spec_player(name))
    inject.assert_not_called()
