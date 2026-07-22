import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import DemoUpload from "./DemoUpload.jsx";

const desktopBridgeMock = vi.hoisted(() => ({
  chooseDemoFiles: vi.fn(),
}));

vi.mock("../desktop/desktopBridge.js", () => ({
  desktopBridge: desktopBridgeMock,
}));

describe("DemoUpload", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("uses the desktop native picker and forwards real local paths", async () => {
    const onUpload = vi.fn();
    desktopBridgeMock.chooseDemoFiles.mockResolvedValue(["C:\\Demos\\one.dem", "D:\\two.dem"]);

    render(<DemoUpload onUpload={onUpload} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(["C:\\Demos\\one.dem", "D:\\two.dem"]);
    });
  });

  test("keeps parsing progress inside the upload box and disables picking", async () => {
    const onUpload = vi.fn();
    render(<DemoUpload onUpload={onUpload} loading loadingText="正在自动解析 5 个 Demo（2/5）…" />);

    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在自动解析 5 个 Demo（2/5）…")).toBeTruthy();
    fireEvent.click(screen.getByRole("status"));
    expect(desktopBridgeMock.chooseDemoFiles).not.toHaveBeenCalled();
    expect(onUpload).not.toHaveBeenCalled();
  });
});
