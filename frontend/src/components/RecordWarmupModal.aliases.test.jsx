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

describe("recording aliases entry", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
    API.get.mockReturnValue(new Promise(() => {}));
    API.post.mockReset();
  });
  it("stays hidden and submits no aliases", () => {
    const onConfirm = vi.fn();
    const props = { onConfirm, onClose: vi.fn(), aliasDemos: [{ key: "a.dem", path: "a.dem", label: "a.dem" }] };
    render(<RecordWarmupModal open {...props} />);
    expect(screen.queryByText("自定义玩家昵称")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "启用改名" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      experimental_pov_enabled: false,
      player_aliases_by_demo: {},
    }));
    expect(API.post).not.toHaveBeenCalled();
  });
});
