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
});
