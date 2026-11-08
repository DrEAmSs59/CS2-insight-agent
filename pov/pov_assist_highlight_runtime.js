const povAssistHighlight = createPovAssistHighlight(povAssistEvents, {
    findHud: function () { return findHudTraverse("HudDeathNotice"); },
});
function updatePovAssistHighlight() {
    try {
        const state = controller.GetDemoControllerState();
        const enabled = advancedPlayback
            ? advancedPovVisualsEnabled && !advancedHudHidden : recordingPovVisualsEnabled;
        povAssistHighlight.update(state, state ? currentPovXuid(state) : "", enabled);
    } catch (error) {
        povAssistHighlight.dispose();
        $.Msg("CS2I_HUD_ERROR:povAssistHighlight:" + String(error));
        return;
    }
    $.Schedule(0, updatePovAssistHighlight);
}
if (povAssistEvents.length) $.Schedule(0, updatePovAssistHighlight);
