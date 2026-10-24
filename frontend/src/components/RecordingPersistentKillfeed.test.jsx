import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import CommonParamsModal from "./CommonParamsModal.jsx";
import RecordWarmupModal, { RECORD_WARMUP_DEFAULT_OPTIONS } from "./RecordWarmupModal.jsx";
import { warmupApiPayloadToPersisted, warmupUiOptsToPersisted } from "../utils/warmupDefaults.js";
import { buildRecordingPresetFile, parseRecordingPresetFile } from "../utils/recordingPresetJson.js";

vi.mock("../api/api.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

function killfeedCheckbox() {
  return screen.getByText("击杀常驻").parentElement.parentElement.querySelector("input");
}

describe("recording persistent kill feed", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
    API.get.mockReturnValue(new Promise(() => {}));
    window.matchMedia = vi.fn(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
  });

  it.each([undefined, true, false])("loads preset %s and submits the toggled command", (saved) => {
    const onConfirm = vi.fn();
    render(<RecordWarmupModal open onClose={() => {}} onConfirm={onConfirm}
      defaultOverrides={saved === undefined ? {} : { persistent_killfeed: saved }} />);
    const checkbox = killfeedCheckbox();
    expect(checkbox.checked).toBe(saved === true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    const payload = onConfirm.mock.calls[0][0];
    expect(payload.persistent_killfeed).toBe(saved !== true);
    expect(warmupApiPayloadToPersisted(payload).persistent_killfeed).toBe(saved !== true);
  });

  it("saves the opt-in preset and preserves it through export/import", async () => {
    let save;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CommonParamsModal variant="page" open onClose={() => {}}
      onRegisterSave={(fn) => { save = fn; }} onSaveAllCommonParams={onSave} />);
    expect(killfeedCheckbox().checked).toBe(false);
    fireEvent.click(killfeedCheckbox());
    await act(async () => { await save(); });
    const preset = onSave.mock.calls[0][0];
    expect(preset.default_record_warmup.persistent_killfeed).toBe(true);
    const file = buildRecordingPresetFile(preset);
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.persistent_killfeed).toBe(true);
    delete file.preset.default_record_warmup.persistent_killfeed;
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.persistent_killfeed).toBe(false);
    expect(warmupUiOptsToPersisted({}).persistent_killfeed).toBe(false);
    expect(warmupApiPayloadToPersisted({}).persistent_killfeed).toBe(false);
  });
});
