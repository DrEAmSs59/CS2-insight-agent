"""OBS-only Panorama controller composed into existing Free session templates."""

OBS_CONTROLLER_JS = r'''
    const encodedRecordingControl = packed[21] || null;
    const recordingControllerOnly = Boolean(encodedRecordingControl && encodedRecordingControl[3]);
    const recordingControl = encodedRecordingControl && encodedRecordingControl[0] === 1 ? {
        sessionId: encodedRecordingControl[1],
        segments: encodedRecordingControl[2].map(function (row) {
            return {operationId: row[0], startTick: row[1], endTick: row[2],
                targetSlot: row[3], targetXuid: row[4], mode: row[5], seekTick: row[1]};
        }),
    } : null;
    let recordingControlIndex = 0;
    let recordingControlPhase = "boot";
    let recordingControlPhaseStartedMs = 0;
    let recordingControlLastCommandMs = 0;
    let recordingControlStableTick = -1;
    let recordingControlStableFrames = 0;
    let recordingControlReadyEmitted = false;
    let recordingControlEndArmed = false;


    function recordingControlNowMs() {
        return (new Date()).getTime();
    }

    function recordingControlOperation() {
        if (!recordingControl || recordingControlIndex < 0
                || recordingControlIndex >= recordingControl.segments.length) {
            return null;
        }
        return recordingControl.segments[recordingControlIndex];
    }

    function recordingControlEmit(eventName, operation, state) {
        const operationId = operation ? operation.operationId : "none";
        const tick = state && isFinite(Number(state.nTick)) ? (Number(state.nTick) | 0) : -1;
        const xuid = state ? currentPovXuid(state) : "";
        const line = "CS2I_RC:" + recordingControl.sessionId
            + ":" + eventName
            + ":" + operationId
            + ":" + tick
            + ":" + xuid;
        $.Msg(line);
        $.Msg(
            "[CS2 Insight Recording] event=" + eventName
            + " operation=" + operationId
            + " tick=" + tick,
        );
    }

    function recordingControlSetPhase(phase) {
        recordingControlPhase = phase;
        recordingControlPhaseStartedMs = recordingControlNowMs();
        recordingControlLastCommandMs = 0;
        recordingControlStableTick = -1;
        recordingControlStableFrames = 0;
    }

    function recordingControlFail(code, state) {
        const operation = recordingControlOperation();
        try {
            if (controller.SetPaused) {
                controller.SetPaused(true);
            }
        } catch (errPause) {}
        $.Msg("[CS2 Insight Recording] controller failure: " + code);
        recordingControlEmit("ERROR", operation, state);
        recordingControlPhase = "failed";
    }

    function recordingControlPause() {
        if (!controller.SetPaused) {
            throw new Error("SetPaused unavailable");
        }
        controller.SetPaused(true);
    }

    function recordingControlResume() {
        if (!controller.SetPaused) {
            throw new Error("SetPaused unavailable");
        }
        controller.SetPaused(false);
    }

    function recordingControlGotoTick(tick) {
        if (!controller.GotoTick) {
            throw new Error("GotoTick unavailable");
        }
        controller.GotoTick(Math.max(0, Number(tick) | 0));
    }

    function recordingControlSeekTick(operation) {
        return operation.startTick;
    }

    function recordingControlDisablePreroll(operation, reason) {
        $.Msg("[CS2 Insight Recording] preroll skipped: operation="
            + operation.operationId + " reason=" + reason);
        operation.seekTick = operation.startTick;
    }

    function recordingControlEmitReady(operation, state) {
        recordingControlReadyEmitted = true;
        recordingControlEmit("READY", operation, state);
    }

    function recordingControlTickInner() {
        if (!recordingControl || recordingControlPhase === "failed"
                || recordingControlPhase === "complete") {
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state || !isFinite(Number(state.nTick))) {
            return;
        }
        const now = recordingControlNowMs();
        const operation = recordingControlOperation();

        if (recordingControlPhase === "boot") {
            if (sessionConsoleCommands.length && sessionConsoleCommandPasses < 1) {
                applySessionConsoleCommandsAfterDemoLoad();
                return;
            }
            if (!controller.SetPaused || !controller.GotoTick) {
                recordingControlFail("demo_controller_api_missing", state);
                return;
            }
            {
                // demoui cycles hidden/minimal/full; its argument is not a
                // reliable hide flag. Hide only the playback controls panel.
                controller.style.opacity = "0";
                controller.hittest = false;
                controller.hittestchildren = false;
                const demoHud = controller.GetParent();
                demoHud.SetHasClass("DemoControllerMinimal", false);
                demoHud.SetHasClass("DemoControllerFull", false);
            }
            recordingControlEmit("BOOT", null, state);
            recordingControlSetPhase("target");
            return;
        }

        if (!operation) {
            recordingControlEmit("COMPLETE", null, state);
            recordingControlPhase = "complete";
            return;
        }

        if (recordingControlPhase === "target") {
            const targetReady = !operation.targetXuid
                || sameXuid(currentPovXuid(state), operation.targetXuid);
            if (targetReady) {
                recordingControlPause();
                recordingControlSetPhase("pause_before_seek");
                return;
            }
            if (now - recordingControlPhaseStartedMs > 12000) {
                recordingControlFail("target_timeout", state);
                return;
            }
            if (state.bIsPaused) {
                recordingControlResume();
                return;
            }
                if (operation.targetSlot < 1) {
                recordingControlFail("target_slot_missing", state);
                return;
            }
            if (!recordingControlLastCommandMs || now - recordingControlLastCommandMs >= 180) {
                recordingControlLastCommandMs = now;
                GameInterfaceAPI.ConsoleCommand("spec_mode " + operation.mode);
                GameInterfaceAPI.ConsoleCommand("spec_player " + operation.targetSlot);
            }
            return;
        }

        if (recordingControlPhase === "pause_before_seek") {
            if (!state.bIsPaused) {
                recordingControlPause();
                if (now - recordingControlPhaseStartedMs > 3000) {
                    recordingControlFail("pause_timeout", state);
                }
                return;
            }
            recordingControlGotoTick(recordingControlSeekTick(operation));
            recordingControlLastCommandMs = now;
            recordingControlSetPhase("seek");
            recordingControlLastCommandMs = now;
            return;
        }

        if (recordingControlPhase === "seek") {
            if (!state.bIsPaused) {
                recordingControlPause();
                return;
            }
            const tick = Number(state.nTick) | 0;
            const seekTick = recordingControlSeekTick(operation);
            const targetReady = !operation.targetXuid
                || sameXuid(currentPovXuid(state), operation.targetXuid);
            if (!targetReady) {
                // The target can be dead or absent before the clip, e.g. at a
                // round start; it was verified at the clip start itself.
                if (seekTick < operation.startTick) {
                    recordingControlDisablePreroll(operation, "target_not_observed");
                }
                recordingControlSetPhase("target");
                return;
            }
            if (Math.abs(tick - seekTick) <= 4) {
                if (tick === recordingControlStableTick) {
                    recordingControlStableFrames += 1;
                } else {
                    recordingControlStableTick = tick;
                    recordingControlStableFrames = 1;
                }
                if (recordingControlStableFrames >= 3) {
                    {
                        try {
                            GameInterfaceAPI.ConsoleCommand(
                                "demo_pauseatservertick " + operation.endTick,
                            );
                        } catch (errArmEnd) {}
                    }
                    // demo_pauseatservertick uses a different, offset clock.
                    recordingControlEndArmed = true;
                    recordingControlReadyEmitted = false;
                    recordingControlSetPhase(seekTick < operation.startTick ? "preroll" : "ready");
                }
                return;
            }
            recordingControlStableTick = -1;
            recordingControlStableFrames = 0;
            if (now - recordingControlPhaseStartedMs > 30000) {
                recordingControlFail("seek_timeout", state);
                return;
            }
            if (!recordingControlLastCommandMs || now - recordingControlLastCommandMs >= 1000) {
                recordingControlGotoTick(seekTick);
                recordingControlLastCommandMs = now;
            }
            return;
        }

        if (recordingControlPhase === "preroll") {
            const tick = Number(state.nTick) | 0;
            if (tick < operation.startTick) {
                if (now - recordingControlPhaseStartedMs > 15000) {
                    recordingControlFail("preroll_timeout", state);
                } else if (state.bIsPaused) {
                    recordingControlResume();
                }
                return;
            }
            const targetReady = !operation.targetXuid
                || sameXuid(currentPovXuid(state), operation.targetXuid);
            // Another seek would discard the warmed-up effects, so a missed
            // start falls back to capturing from a direct seek instead.
            if (!targetReady || state.bIsPaused || tick > operation.startTick + 8) {
                recordingControlDisablePreroll(operation,
                    !targetReady ? "target_changed" : state.bIsPaused ? "paused" : "start_missed");
                recordingControlPause();
                recordingControlSetPhase(targetReady ? "pause_before_seek" : "target");
                return;
            }
            recordingControlEmitReady(operation, state);
            recordingControlEmit("STARTED", operation, state);
            recordingControlSetPhase("running");
            return;
        }

        if (recordingControlPhase === "ready") {
            if (!recordingControlReadyEmitted) {
                recordingControlEmitReady(operation, state);
            }
            if (!state.bIsPaused) {
                recordingControlEmit("STARTED", operation, state);
                recordingControlSetPhase("running");
            }
            return;
        }

        if (recordingControlPhase === "running") {
            const tick = Number(state.nTick) | 0;
            if (state.bIsPaused && tick >= operation.endTick - 4) {
                recordingControlSetPhase("end_pause");
                return;
            }
            if (tick >= operation.endTick) {
                recordingControlPause();
                recordingControlSetPhase("end_pause");
                return;
            }
            if (state.bIsPaused) {
                recordingControlFail("unexpected_pause", state);
                return;
            }
            if (!recordingControlEndArmed) {
                try {
                    GameInterfaceAPI.ConsoleCommand(
                        "demo_pauseatservertick " + operation.endTick,
                    );
                } catch (errRearmEnd) {}
                recordingControlEndArmed = true;
            }
            return;
        }

        if (recordingControlPhase === "end_pause") {
            if (!state.bIsPaused) {
                recordingControlPause();
                return;
            }
            recordingControlEmit("ENDED", operation, state);
            recordingControlSetPhase("await_advance");
            return;
        }

        if (recordingControlPhase === "await_advance") {
            // Backend sends the same silent resume key only after OBS has paused
            // or stopped.  In this phase that edge means "advance", not record.
            if (!state.bIsPaused) {
                recordingControlPause();
                recordingControlIndex += 1;
                recordingControlReadyEmitted = false;
                recordingControlEndArmed = false;
                recordingControlSetPhase("target");
            }
        }
    }

    function recordingControlTick() {
        $.Schedule(0.01, recordingControlTick);
        try {
            recordingControlTickInner();
        } catch (errControl) {
            const state = controller.GetDemoControllerState();
            recordingControlFail("exception", state);
        }
    }

'''


def compose_recording_controller(source):
    anchor = "    $.Schedule(0, ensureDemoVoicesUnmuted);"
    if source.count(anchor) != 1:
        raise ValueError("OBS recording template startup boundary changed")
    startup = """
    if (recordingControl) $.Schedule(0, recordingControlTick);
    if (recordingControllerOnly) {
        if (sessionConsoleCommands.length) $.Schedule(0, applySessionConsoleCommandsAfterDemoLoad);
        return;
    }
"""
    begin = source.index("    function applySessionConsoleCommandsAfterDemoLoad() {")
    end = source.index("    function advancedLocalizedUtilityName", begin)
    source = source[:begin] + SESSION_COMMAND_JS + source[end:]
    source = source.replace("const SESSION_CONSOLE_COMMAND_PASSES = 3", "const SESSION_CONSOLE_COMMAND_PASSES = 1")
    return source.replace(anchor, OBS_CONTROLLER_JS + startup + anchor)


SESSION_COMMAND_JS = r'''
    function applySessionConsoleCommandsAfterDemoLoad() {
        if (!sessionConsoleCommands.length
                || sessionConsoleCommandPasses >= SESSION_CONSOLE_COMMAND_PASSES) {
            return;
        }
        const state = controller.GetDemoControllerState();
        if (!state) {
            $.Schedule(0.1, applySessionConsoleCommandsAfterDemoLoad);
            return;
        }
        // Commands are validated server-side to contain no semicolons/newlines.
        // Dispatch the immutable demo-session setup in one engine call instead
        // of simulating one console submission per cvar.
        try {
            GameInterfaceAPI.ConsoleCommand(sessionConsoleCommands.join(";"));
        } catch (errCommand) {}
        sessionConsoleCommandPasses += 1;
    }

'''
