import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import RecordWarmupModal from "./RecordWarmupModal.jsx";

vi.mock("../api/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe("RecordWarmupModal skybox override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockReturnValue(new Promise(() => {}));
    useLocaleStore.getState().hydrate("zh");
  });

  it("starts from the saved preset and submits the dialog selection", () => {
    const onConfirm = vi.fn();
    render(
      <RecordWarmupModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        recordingSkybox="xuejing"
      />,
    );

    const selector = screen.getByRole("combobox", { name: "录制天空盒" });
    expect(screen.queryByText(/以下命令在首次跳转 tick 前/)).toBeNull();
    expect(screen.queryByTestId("experimental-pov-disclaimer")).toBeNull();
    expect(screen.queryByText(/默认已预填 5 条性能\/预测 cvar/)).toBeNull();
    expect(screen.queryByText(/首片段预热/)).toBeNull();
    expect(screen.getByText(/此处修改仅作用于本次录制/)).toBeTruthy();
    expect(selector.value).toBe("xuejing");
    fireEvent.change(selector, { target: { value: "cartoon3" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ recording_skybox: "cartoon3" }),
    );
  });
});
