import json
from pathlib import Path
import shutil
import subprocess

import pytest

from app.demo_voice_hud import (VOICE_SCRIPT_PATH, build_recording_controller_vpk,
                                inject_voice_payload, read_inline_vpk)
from app.recording.obs_controller import compose_recording_controller
from app.recording.obs_observer import compose_obs_observer, validate_timeline

ROOT = Path(__file__).resolve().parents[2]
TIMELINE = [{"tick": 1000, "slot": 11, "pawn": 2819},
            {"tick": 1050, "slot": 11, "pawn": 0},
            {"tick": 1100, "slot": 11, "pawn": 1625},
            {"tick": 1200, "slot": 12, "pawn": 2900}]


def control():
    return {"session_id": "obs_test", "segments": [{"operation_id": "op0",
        "start_tick": 1000, "end_tick": 1300, "target_slot": 11,
        "target_xuid": "76561198370760326", "spec_mode": 5, "obs_body_timeline": TIMELINE}]}


@pytest.mark.parametrize("template", ["pov_advanced_playback_template.vpk", "pov_voice_template.vpk"])
def test_real_template_receives_obs_tracking_only_when_requested(template):
    path = ROOT / "pov" / template
    if not path.exists():
        pytest.fail(f"missing shipped template {path}")
    original = path.read_bytes()
    before = read_inline_vpk(original)
    built = build_recording_controller_vpk(path, recording_control=control())
    after = read_inline_vpk(built.vpk_bytes)
    assert set(before) == set(after)
    assert all(before[k] == after[k] for k in before if k != VOICE_SCRIPT_PATH)
    script = after[VOICE_SCRIPT_PATH]
    assert b"obsObserverFollow(state, operation)" in script
    assert b'":body:"' in script
    assert b'"tick":1100,"slot":11,"pawn":1625' in script
    assert b"nativeRecordingTargets" not in script
    # Advanced playback/data-only injection and ordinary OBS remain unchanged.
    plain = read_inline_vpk(inject_voice_payload(original, b"[]"))[VOICE_SCRIPT_PATH]
    assert b"obsObserverTargets" not in plain


@pytest.mark.parametrize("rows", [[], TIMELINE[::-1], [{"tick": 999, "slot": 11, "pawn": 2819}],
    [{"tick": 1000, "slot": 65, "pawn": 2819}], [{"tick": 1000, "slot": 11, "pawn": 0}],
    TIMELINE + [{"tick": 1400, "slot": 11, "pawn": 7}]])
def test_invalid_timelines_are_rejected(rows):
    with pytest.raises(ValueError):
        validate_timeline(rows, 1000, 1300, 11, 2819)


def test_hlae_or_changed_templates_cannot_silently_accept_obs_adapter():
    source = compose_recording_controller((ROOT / "pov/voice_hud_injection.js").read_text(encoding="utf-8"))
    with pytest.raises(ValueError, match="native capture"):
        compose_obs_observer(source, {**control(), "capture_backend": "hlae"})
    with pytest.raises(ValueError, match="boundary changed"):
        compose_obs_observer(source.replace('if (recordingControlPhase === "seek")', 'if (false)'), control())


def test_javascript_controller_seeks_verifies_body_follows_takeover_and_fails_closed(tmp_path):
    node = shutil.which("node")
    assert node, "Node is required to exercise the Panorama state machine"
    source = compose_obs_observer(compose_recording_controller((ROOT / "pov/voice_hud_injection.js").read_text(encoding="utf-8")), control())
    source = source[source.index("    let recordingControlIndex = 0;"):source.index("    if (recordingControl) $.Schedule")]
    harness = r'''
const assert = require("node:assert/strict");
let now = 10000;
const commands = [], failures = [], seeks = [], logs = [];
let state = {nTick: 500, nSpectatingPlayerId: 77, nObserverMode: 2, bIsPaused: false};
const operation = {operationId: "op0", startTick: 1000, endTick: 1300,
    targetSlot: 11, targetXuid: "76561198370760326", mode: 5};
const recordingControl = {sessionId: "obs_test", segments: [operation], nativeCapture: false};
const sessionConsoleCommands = [];
let sessionConsoleCommandPasses = 0;
const controller = {
    style: {}, GetParent: () => ({SetHasClass: () => {}}),
    GetDemoControllerState: () => state,
    SetPaused: value => { state.bIsPaused = value; },
    GotoTick: tick => { seeks.push(tick); state.nTick = tick; state.nSpectatingPlayerId = 77; },
};
const GameInterfaceAPI = {ConsoleCommand: line => commands.push(line)};
const $ = {Msg: line => { logs.push(line); if (line.includes("failure")) failures.push(line); }, Schedule: () => {}};
const sameXuid = (a,b) => a === b;
const currentPovXuid = () => "0"; // Real BOT view does not report the human's ID.
''' + source + r'''
recordingControlNowMs = () => now;
const step = () => { now += 20; recordingControlTickInner(); };
step(); // BOOT
assert.equal(controller.style.opacity, "0");
step(); // Seek to verified alive cut, not the prior dead scene.
assert.deepEqual(seeks, [1000]);
step(); // Issue selection after seek.
assert(commands.includes("spec_player 11"));
state.nSpectatingPlayerId = 2819;
step(); // Pause before seek.
step(); // Actual cut seek resets camera.
step(); // Reselect after cut seek.
assert.equal(commands.filter(x => x === "spec_player 11").length, 2);
state.nSpectatingPlayerId = 2819;
for (let i=0;i<7;i++) step();
assert.equal(recordingControlPhase, "ready");
assert(logs.includes("CS2I_RC:obs_test:READY:op0:1000:0:body:2819:2"));
assert(!commands.some(line => line.startsWith("echo CS2I_RC:")));
state.bIsPaused = false;
step();
assert.equal(recordingControlPhase, "running");
state.nTick = 1050; state.nSpectatingPlayerId = 99; state.nObserverMode = 3;
let count = commands.length; step();
assert.equal(commands.length, count); // Death camera left alone.
state.nTick = 1100; step(); // Reacquire BOT.
assert.equal(commands.at(-1), "spec_player 11");
state.nSpectatingPlayerId = 1625; state.nObserverMode = 2;
state.nTick = 1101; step();
assert.equal(recordingControlPhase, "running");
state.nTick = 1200; step(); // New controller/respawn.
assert.equal(commands.at(-1), "spec_player 12");
state.nSpectatingPlayerId = 2900; state.nTick = 1201; step();
assert.equal(obsObserverBody(operation, 1001).pawn, 2819); // Rewind never uses a future body.
assert.equal(obsObserverBody(operation, 1099).pawn, 0);
state.nTick = 1210; state.nSpectatingPlayerId = 77; step();
state.nTick = 1227; step();
assert.equal(recordingControlPhase, "failed");
assert(state.bIsPaused);
assert(failures.some(x => x.includes("obs_takeover_observer_mismatch")));
// Even a stalled demo clock must not hold an unverified view indefinitely.
recordingControlPhase = "running"; obsObserverRetry = null;
state.bIsPaused = false; state.nTick = 1230;
step(); now += 2100; step();
assert.equal(recordingControlPhase, "failed");
// Starting already in a BOT body uses that body's pawn, not the human XUID.
obsObserverTargets.op0 = [{tick: 1000, slot: 11, pawn: 1625}];
state = {nTick: 1000, nSpectatingPlayerId: 1625, nObserverMode: 2};
assert(obsObserverReady(state, operation));
assert(!obsObserverReady({...state, nObserverMode: 3}, operation));
assert(!obsObserverReady({...state, nSpectatingPlayerId: 2819}, operation));
console.log("OBS observer state machine passed");
'''
    path = tmp_path / "obs-controller.cjs"
    path.write_text(harness, encoding="utf-8")
    run = subprocess.run([node, str(path)], capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stdout + run.stderr
