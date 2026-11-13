// App-owned session addon for OBS and HLAE; never an extension template patch.
function createRoundBannerReset(roundEnds, findPanel, clockEvents, findTimer, getTimeData) {
    let lastTick = null, lastOperation = null, pendingJump = false;
    let suppressUntil = null, hiddenPanel = null;
    function release() {
        if (hiddenPanel && hiddenPanel.IsValid()) hiddenPanel.ClearPropertyFromCode("opacity");
        hiddenPanel = null;
    }
    function arm(tick) {
        suppressUntil = Infinity;
        for (let i = 0; i < roundEnds.length; i++) {
            // Landing on an end is a seek, not a newly played round_end event.
            if (roundEnds[i] > tick) { suppressUntil = roundEnds[i]; break; }
        }
    }
    return {
        seek: function () { pendingJump = true; },
        update: function (state, operation) {
            if (!state || !isFinite(Number(state.nTick))) return;
            const tick = Number(state.nTick);
            const jumped = pendingJump || lastTick === null || operation !== lastOperation
                || tick + 2 < lastTick || tick - lastTick > 64;
            if (jumped) arm(tick);
            pendingJump = false;
            lastTick = tick;
            lastOperation = operation;
            if (suppressUntil === null || tick >= suppressUntil) {
                suppressUntil = null;
                release();
                return;
            }
            // round_end collapses TimerText and stops its native text updates.
            // A rewind can retain both. Use the current game clock in the stock
            // label, never wall time or a separately reconstructed HUD.
            let clockVisible = null, freezing = false;
            for (let i = 0; i < (clockEvents || []).length && clockEvents[i][0] <= tick; i++) {
                clockVisible = clockEvents[i][1];
                freezing = Boolean(clockEvents[i][2]);
            }
            const timer = findTimer ? findTimer() : null;
            if (clockVisible !== null && timer && timer.IsValid()) {
                const time = getTimeData ? getTimeData() : null;
                timer.visible = clockVisible && !(time && time.hide);
                if (timer.visible && time && typeof time.roundtime_remaining === "number"
                        && isFinite(time.roundtime_remaining) && typeof time.roundtime === "number") {
                    // The API truncates seconds; the stock label rounds up.
                    // During freeze time it includes the upcoming round length.
                    let remaining = time.roundtime_remaining;
                    if (freezing) remaining -= time.roundtime;
                    const seconds = Math.max(0, Math.floor(remaining) + 1);
                    timer.text = Math.floor(seconds / 60) + ":" + (seconds % 60 < 10 ? "0" : "") + seconds % 60;
                }
            }
            const panel = findPanel();
            if (hiddenPanel !== panel) release();
            if (!panel || !panel.IsValid()) return;
            // Both result and MVP are gated by this stock class. Clear it even
            // after delayed native callbacks or spec_player rebuild the panel.
            panel.RemoveClass("winpanel-basic-round-result-visible");
            panel.style.opacity = "0";
            hiddenPanel = panel;
        },
        dispose: release,
    };
}
function findSharedRoundBanner() {
    let panel = findHudTraverse("MVP");
    while (panel && panel.IsValid()) {
        if (panel.BHasClass("WinPanelRoot")) return panel;
        panel = panel.GetParent();
    }
    return null;
}
const sharedRoundBanner = createRoundBannerReset(sharedRoundEndTicks, findSharedRoundBanner,
    sharedRoundClockEvents, function () { return findHudTraverse("TimerText"); },
    function () { return GameStateAPI.GetTimeDataJSO(); });
// Paused GotoTick does not always dispatch this event, so also inspect the
// controller tick and operation in every frame (including legacy OBS seeks).
$.RegisterForUnhandledEvent("PanoramaGameTimeJumpEvent", function () { sharedRoundBanner.seek(); });
function updateSharedRoundBanner() {
    try {
        // Legacy OBS and the stock-HUD killfeed context have no queue controller.
        const operation = typeof recordingControlOperation === "function" ? recordingControlOperation() : null;
        sharedRoundBanner.update(controller.GetDemoControllerState(), operation ? operation.operationId : null);
    } catch (error) {
        sharedRoundBanner.dispose();
        $.Msg("CS2I_HUD_ERROR:roundBanner:" + String(error));
        return;
    }
    $.Schedule(0, updateSharedRoundBanner);
}
$.Schedule(0, updateSharedRoundBanner);
