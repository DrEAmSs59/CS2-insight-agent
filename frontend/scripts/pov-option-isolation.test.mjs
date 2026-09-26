// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const source = readFileSync(new URL("../../pov/voice_hud_injection.js", import.meta.url), "utf8");

function runtime({ recordingPov = false, advanced = false, advancedPov = false } = {}) {
  const alert = { style: {}, IsValid: () => true };
  const chat = { style: {}, visible: true, IsValid: () => true };
  const context = {
    recordingPovVisualsEnabled: recordingPov,
    advancedPlayback: advanced ? {} : null,
    advancedPovVisualsEnabled: advancedPov,
    advancedNativeMessagesRestored: false,
    nativeLowerLeftAlertPanels: () => [alert],
    findHudTraverse: () => chat,
    nativeChatHistoryText: null,
    radioTrack: {}, killFeedbackTrack: null,
    hideRadioHud: vi.fn(), ensureRadioHud: vi.fn(),
    controller: { GetDemoControllerState: vi.fn(() => null) },
    RADIO_IDLE_REFRESH_SECONDS: 0.1,
    $: { Schedule: vi.fn() },
  };
  const functions = ["advancedPovVisualsActive", "suppressNativeLowerLeft", "updateRadioHud"];
  runInNewContext(functions.map((name) => {
    const match = source.match(new RegExp(`^    function ${name}\\([^]*?^    }`, "m"));
    if (!match) throw new Error(`Missing production function ${name}`);
    return match[0];
  }).join("\n"), context);
  return { context, alert, chat };
}

describe("POV visuals are independent of voice and keyboard overlays", () => {
  test("auxiliary-only recording preserves native messages and hides reconstructed radio", () => {
    const { context, alert, chat } = runtime();
    context.suppressNativeLowerLeft();
    context.updateRadioHud();
    expect(alert.style.opacity).not.toBe("0");
    expect(alert.style.visibility).not.toBe("collapse");
    expect(chat.visible).toBe(true);
    expect(context.controller.GetDemoControllerState).not.toHaveBeenCalled();
    expect(context.hideRadioHud).toHaveBeenCalled();
  });

  test.each([
    [{ recordingPov: true }, true],
    [{ recordingPov: false }, false],
    [{ recordingPov: true, advanced: true, advancedPov: false }, false],
    [{ recordingPov: false, advanced: true, advancedPov: true }, true],
  ])("respects the recording switch and advanced playback profile: %j", (mode, enabled) => {
    const { context, alert, chat } = runtime(mode);
    expect(context.advancedPovVisualsActive()).toBe(enabled);
    context.suppressNativeLowerLeft();
    expect(alert.style.visibility === "collapse").toBe(enabled);
    expect(chat.visible).toBe(!enabled);
  });
});
