"""Application-owned OBS observer tracking composed into the session VPK.

Only cuts with a verified offline body timeline use this adapter. HLAE's
precompiled extension and advanced playback templates are left untouched.
"""
import json
import re


def validate_timeline(rows, start, end, slot, pawn):
    if not isinstance(rows, list) or not rows:
        raise ValueError("OBS 身体时间线缺失")
    result = []
    previous = start - 1
    for row in rows:
        if (not isinstance(row, dict)
                or any(type(row.get(k)) is not int for k in ("tick", "slot", "pawn"))
                or not previous < row["tick"] <= end or row["tick"] < start
                or not 1 <= row["slot"] <= 64 or not 0 <= row["pawn"] < 0x4000):
            raise ValueError("OBS 身体时间线无效")
        result.append({k: row[k] for k in ("tick", "slot", "pawn")})
        previous = row["tick"]
    if result[0] != {"tick": start, "slot": slot, "pawn": pawn} or pawn <= 0:
        raise ValueError("OBS 身体时间线起点与录制目标不一致")
    return result


def expected_body(rows, tick):
    return next((row for row in reversed(rows) if row["tick"] <= tick), None)


# This is code owned by the app, bundled with Python like other recording
# orchestration. No extension file, DLL export or game-memory address is used.
OBS_OBSERVER_JS = r'''
    let obsObserverSeekOperation = "";
    let obsObserverSelectionPending = false;
    let obsObserverRetry = null;

    function obsObserverBody(operation, tick) {
        const rows = obsObserverTargets[operation.operationId];
        if (!rows) return null;
        let result = null;
        for (const row of rows) {
            if (row.tick > tick) break;
            result = row;
        }
        return result;
    }

    function obsObserverPawn(state) {
        const pawn = state && state.nSpectatingPlayerId;
        return Number.isInteger(pawn) && pawn > 0 && pawn < 16384 ? pawn : 0;
    }

    function obsObserverReady(state, operation) {
        const rows = obsObserverTargets[operation.operationId];
        if (!rows) return sameXuid(currentPovXuid(state), operation.targetXuid);
        const tick = Number(state.nTick);
        const body = obsObserverBody(operation, tick)
            || (Math.abs(tick - operation.startTick) <= 4 ? rows[0] : null);
        return Boolean(body && body.pawn > 0 && state.nObserverMode === 2
            && obsObserverPawn(state) === body.pawn);
    }

    function obsObserverReselect(state, operation) {
        if (!obsObserverTargets[operation.operationId] || !obsObserverSelectionPending) return false;
        const body = obsObserverBody(operation, Number(state.nTick))
            || obsObserverTargets[operation.operationId][0];
        if (state.bIsPaused) recordingControlResume();
        GameInterfaceAPI.ConsoleCommand("spec_mode " + operation.mode);
        GameInterfaceAPI.ConsoleCommand("spec_player " + body.slot);
        obsObserverSelectionPending = false;
        recordingControlLastCommandMs = recordingControlNowMs();
        return true;
    }

    function obsObserverPrepare(state, operation) {
        if (!obsObserverTargets[operation.operationId]) return false;
        // The preceding cut can end after this player died. Select only after
        // seeking into this cut, where the offline reader verified a live body.
        if (obsObserverSeekOperation !== operation.operationId) {
            obsObserverSeekOperation = operation.operationId;
            obsObserverRetry = null;
            recordingControlPause();
            recordingControlGotoTick(operation.startTick);
            return true;
        }
        if (obsObserverSelectionPending) {
            if (Math.abs(Number(state.nTick) - operation.startTick) > 4) {
                if (recordingControlNowMs() - recordingControlPhaseStartedMs > 12000) {
                    recordingControlFail("obs_target_seek_timeout", state);
                }
                return true;
            }
            return obsObserverReselect(state, operation);
        }
        return false;
    }

    function obsObserverFollow(state, operation) {
        if (!obsObserverTargets[operation.operationId]) return false;
        const tick = Number(state.nTick);
        const body = obsObserverBody(operation, tick);
        if (!body) {
            recordingControlFail("obs_body_timeline_missing", state);
            return true;
        }
        // A verified dead interval keeps CS2's death camera; reacquire on
        // the next live spawn or takeover, including a different controller.
        if (!body.pawn || (state.nObserverMode === 2 && obsObserverPawn(state) === body.pawn)) {
            obsObserverRetry = null;
            return false;
        }
        const now = recordingControlNowMs();
        const key = operation.operationId + ":" + body.tick;
        if (!obsObserverRetry || obsObserverRetry.key !== key || tick < obsObserverRetry.last) {
            obsObserverRetry = {key: key, first: tick, started: now, last: -1};
        }
        const retry = obsObserverRetry;
        if (tick - retry.first > 16 || now - retry.started > 2000) {
            recordingControlFail("obs_takeover_observer_mismatch", state);
            return true;
        }
        if (retry.last < 0 || tick - retry.last >= 4) {
            GameInterfaceAPI.ConsoleCommand("spec_mode " + operation.mode);
            GameInterfaceAPI.ConsoleCommand("spec_player " + body.slot);
            retry.last = tick;
        }
        return false;
    }
'''


def compose_obs_observer(source, control):
    segments = (control or {}).get("segments", [])
    targets = {s["operation_id"]: validate_timeline(s["obs_body_timeline"],
               s["start_tick"], s["end_tick"], s["target_slot"], s["obs_body_timeline"][0]["pawn"])
               for s in segments if s.get("obs_body_timeline")}
    if not targets:
        return source
    if control.get("capture_backend"):
        raise ValueError("OBS observer cannot be composed into native capture")

    def replace(old, new, count=1):
        nonlocal source
        if source.count(old) != count:
            raise ValueError("OBS observer controller boundary changed: " + old[:70])
        source = source.replace(old, new)

    ready = r"!operation\.targetXuid\s*\|\|\s*sameXuid\(currentPovXuid\(state\), operation.targetXuid\)"
    source, count = re.subn(ready, "obsObserverReady(state, operation)", source)
    if count != 3:
        raise ValueError("OBS observer readiness boundary changed")
    anchor = "    function recordingControlOperation() {"
    replace(anchor, "    const obsObserverTargets = " + json.dumps(targets, separators=(",", ":"))
            + ";\n" + OBS_OBSERVER_JS + "\n" + anchor)
    seek = "        controller.GotoTick(Math.max(0, Number(tick) | 0));"
    replace(seek, seek + "\n        obsObserverSelectionPending = true;")
    boundary = '        if (recordingControlPhase === "target") {'
    replace(boundary, boundary + "\n            if (obsObserverPrepare(state, operation)) return;")
    boundary = '        if (recordingControlPhase === "seek") {'
    replace(boundary, boundary + '''
            if (Math.abs(Number(state.nTick) - operation.startTick) <= 4
                    && obsObserverReselect(state, operation)) return;''')
    boundary = '        if (recordingControlPhase === "ready") {'
    replace(boundary, boundary + '''
            if (obsObserverTargets[operation.operationId] && !obsObserverReady(state, operation)) {
                recordingControlFail("obs_ready_body_changed", state);
                return;
            }''')
    boundary = '        if (recordingControlPhase === "running") {'
    replace(boundary, boundary + '''
            if (Number(state.nTick) < operation.endTick && obsObserverFollow(state, operation)) return;''')
    # Carry the real observer state in the receipt. BOT XUIDs may legitimately
    # differ from the human controller; never forge/replace the reported XUID.
    replace('            + ":" + xuid;', '''            + ":" + xuid
            + ":body:" + obsObserverPawn(state)
            + ":" + (state && Number.isInteger(state.nObserverMode) ? state.nObserverMode : -1);''')
    return source
