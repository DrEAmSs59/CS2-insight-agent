/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextEncoder } from "node:util";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import RecordWarmupModal from "./RecordWarmupModal.jsx";

globalThis.TextEncoder ||= TextEncoder;
vi.mock("../api/api.js", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

describe("recording aliases opt-in", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
    API.get.mockReturnValue(new Promise(() => {}));
    API.post.mockReset();
  });
  it("submits aliases with POV off and does not reuse them in a new recording", async () => {
    API.post.mockResolvedValue({ data: { players: [{ steamid64: "76561199032006224", name: "Etagekax", team_number: 2 }] } });
    const onConfirm = vi.fn();
    const props = { onConfirm, onClose: vi.fn(), aliasDemos: [{ key: "a.dem", path: "a.dem", label: "a.dem" }] };
    const { rerender } = render(<RecordWarmupModal open {...props} />);
    expect(screen.getByRole("checkbox", { name: "启用改名" }).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用改名" }));
    expect(screen.getByRole("button", { name: "开始录制" }).disabled).toBe(true);
    const input = await screen.findByRole("textbox", { name: "Etagekax 的自定义昵称" });
    fireEvent.change(input, { target: { value: "x".repeat(33) } });
    expect(screen.getByRole("button", { name: "开始录制" }).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "京介 🦋" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      experimental_pov_enabled: false,
      player_aliases_by_demo: { "a.dem": { "76561199032006224": "京介 🦋" } },
    }));
    rerender(<RecordWarmupModal open={false} {...props} />);
    rerender(<RecordWarmupModal open {...props} />);
    expect(screen.getByRole("checkbox", { name: "启用改名" }).checked).toBe(false);
    expect(API.post).toHaveBeenCalledTimes(1);
  });
});
