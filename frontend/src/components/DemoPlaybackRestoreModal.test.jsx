import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import DemoPlaybackRestoreModal from "./DemoPlaybackRestoreModal.jsx";

describe("DemoPlaybackRestoreModal", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("shows success only when both disk facts are verified", () => {
    const onClose = vi.fn();
    render(
      <DemoPlaybackRestoreModal
        open
        status={{
          state: "completed",
          restore: {
            verified: true,
            gameinfo_restored: true,
            pov_vpk_removed: true,
            expected_gameinfo_sha256: "a".repeat(64),
            actual_gameinfo_sha256: "a".repeat(64),
          },
        }}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("POV 文件已确认恢复")).toBeTruthy();
    expect(screen.getByText(/SHA-256 与启动前备份一致/)).toBeTruthy();
    expect(screen.getByText("临时文件已删除。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the actual failed file facts without claiming restoration", () => {
    render(
      <DemoPlaybackRestoreModal
        open
        status={{
          state: "restore_failed",
          restore: {
            verified: false,
            gameinfo_restored: false,
            pov_vpk_removed: false,
            error: "hash mismatch",
          },
        }}
        onClose={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText("POV 文件未能确认恢复")).toBeTruthy();
    expect(screen.getByText(/未恢复或哈希不一致/)).toBeTruthy();
    expect(screen.getByText(/文件仍然存在/)).toBeTruthy();
    expect(screen.getByText("hash mismatch")).toBeTruthy();
    expect(screen.queryByText("POV 文件已确认恢复")).toBeNull();
  });
});
