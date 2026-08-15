;(function CS2InsightHudAlertsSeekReset() {
    const alerts = $.GetContextPanel();
    const SUPPRESS_CLASS = "CS2InsightSeekSuppress";
    const SEEK_SETTLE_SAMPLES = 60;
    const HIDDEN_STABLE_SAMPLES = 10;
    let generation = 0;

    function nativeAlertIsHidden() {
        try {
            return alerts.BHasClass("AlertHidden")
                && !alerts.BHasClass("AlertVisible")
                && !alerts.BHasClass("FlashAnim")
                && !alerts.BHasClass("HideFlash");
        } catch (errClass) {
            return false;
        }
    }

    function waitForNativeHidden(currentGeneration, elapsedSamples, hiddenSamples) {
        if (currentGeneration !== generation || !alerts || !alerts.IsValid()) {
            return;
        }
        const seekHasSettled = elapsedSamples >= SEEK_SETTLE_SAMPLES;
        const nextHiddenSamples = seekHasSettled && nativeAlertIsHidden()
            ? hiddenSamples + 1
            : 0;
        if (nextHiddenSamples >= HIDDEN_STABLE_SAMPLES) {
            alerts.RemoveClass(SUPPRESS_CLASS);
            return;
        }
        $.Schedule(0.05, function () {
            waitForNativeHidden(
                currentGeneration,
                elapsedSamples + 1,
                nextHiddenSamples,
            );
        });
    }

    function suppressStaleAlertAfterTimeJump() {
        generation += 1;
        alerts.AddClass(SUPPRESS_CLASS);
        waitForNativeHidden(generation, 0, 0);
    }

    try {
        $.RegisterForUnhandledEvent(
            "PanoramaGameTimeJumpEvent",
            suppressStaleAlertAfterTimeJump,
        );
    } catch (errTimeJumpEvent) {}
})();
