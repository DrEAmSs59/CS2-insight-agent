import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import CommonParamsModal from "./CommonParamsModal.jsx";
import RecordWarmupModal, { RECORD_WARMUP_DEFAULT_OPTIONS } from "./RecordWarmupModal.jsx";
import { warmupApiPayloadToPersisted, warmupUiOptsToPersisted } from "../utils/warmupDefaults.js";
import { buildRecordingPresetFile, parseRecordingPresetFile } from "../utils/recordingPresetJson.js";

vi.mock("../api/api.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

function clanCheckbox() {
  return screen.getByText("隐藏战队队标").parentElement.parentElement.querySelector("input");
}

describe("recording clan tag visibility", () => {
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
      defaultOverrides={saved === undefined ? {} : { hide_clan_tags: saved }} />);
    const checkbox = clanCheckbox();
    expect(checkbox.checked).toBe(saved !== false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    const payload = onConfirm.mock.calls[0][0];
    expect(payload.hide_clan_tags).toBe(saved === false);
    expect(payload.console_cmds).toContain(`cl_show_clan_in_death_notice ${saved === false ? 0 : 1}`);
    expect(warmupApiPayloadToPersisted(payload).hide_clan_tags).toBe(saved === false);
  });

  it("saves the default-on preset checkbox and preserves an explicit off through export/import", async () => {
    let save;
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CommonParamsModal variant="page" open onClose={() => {}}
      onRegisterSave={(fn) => { save = fn; }} onSaveAllCommonParams={onSave} />);
    expect(clanCheckbox().checked).toBe(true);
    fireEvent.click(clanCheckbox());
    await act(async () => { await save(); });
    const preset = onSave.mock.calls[0][0];
    expect(preset.default_record_warmup.hide_clan_tags).toBe(false);
    const file = buildRecordingPresetFile(preset);
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.hide_clan_tags).toBe(false);
    delete file.preset.default_record_warmup.hide_clan_tags;
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.hide_clan_tags).toBe(true);
    expect(warmupUiOptsToPersisted({}).hide_clan_tags).toBe(true);
    expect(warmupApiPayloadToPersisted({}).hide_clan_tags).toBe(true);
  });
});
