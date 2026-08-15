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
            verification_mode: "strict",
            byte_verified: true,
            expected_gameinfo_sha256: "a".repeat(64),
            actual_gameinfo_sha256: "a".repeat(64),
          },
        }}
        onClose={onClose}
      />,
    );

    expect(screen.getByText("POV 文件已按备份完整恢复")).toBeTruthy();
    expect(screen.getByText(/SHA-256 一致/)).toBeTruthy();
    expect(screen.getByText("临时文件已删除。")).toBeTruthy();
    expect(screen.getByTestId("demo-playback-restore-content").className).toContain("space-y-3");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("describes semantic cleanup without claiming a backup hash match", () => {
    render(
      <DemoPlaybackRestoreModal
        open
        status={{
          state: "completed",
          restore: {
            verified: true,
            gameinfo_restored: true,
            pov_vpk_removed: true,
            verification_mode: "semantic",
            byte_verified: false,
            actual_gameinfo_sha256: "b".repeat(64),
          },
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("POV 残留已安全清理")).toBeTruthy();
    expect(screen.getByText(/其他现有内容保持不变/)).toBeTruthy();
    expect(screen.queryByText(/启动前 SHA-256/)).toBeNull();
    expect(screen.queryByText(/与启动前备份一致/)).toBeNull();
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
    expect(screen.getByText(/POV 加载项仍然存在/)).toBeTruthy();
    expect(screen.getByText(/文件仍然存在/)).toBeTruthy();
    expect(screen.getByText("hash mismatch")).toBeTruthy();
    expect(screen.queryByText("POV 文件已确认恢复")).toBeNull();
  });
});
