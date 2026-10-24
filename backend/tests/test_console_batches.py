from app.win_cs2_console import _console_batches


def test_comments_do_not_disable_following_commands():
    commands = ["hud_scaling 1", "volume 0.5 // quieter", "demo_resume", "// note", "hideconsole"]
    assert _console_batches(commands, 900) == commands


def test_batches_preserve_quotes_and_do_not_split_commands():
    commands = ['bind F1 "echo one;echo two"', "demo_pause", "hideconsole"]
    assert _console_batches(commands, 900) == [';'.join(commands)]
    assert _console_batches(commands, 12) == commands


def test_only_obs_wrapper_enables_batching(monkeypatch):
    from unittest.mock import Mock
    from app import win_cs2_console as console

    inject = Mock(return_value=True)
    monkeypatch.setattr(console, "inject_console_sequence", inject)
    commands = ["sv_cheats 1", "fov_cs_debug 90"]
    assert console.inject_obs_console_sequence(commands, close_console=False)
    inject.assert_called_once_with(commands, batch_commands=True, close_console=False)


def test_newlines_stay_separate_and_length_limit_flushes_in_order():
    commands = ["echo 1", "echo 2", "echo 3\necho 4", "echo 5", "echo 6"]
    assert _console_batches(commands, 13) == ["echo 1;echo 2", "echo 3\necho 4", "echo 5;echo 6"]
