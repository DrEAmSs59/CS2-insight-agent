import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import DemoUpload from "./DemoUpload.jsx";


describe("DemoUpload", () => {
  afterEach(() => {
    delete window.electron;
  });

  test("uses Electron's native picker and forwards real local paths", async () => {
    const onUpload = vi.fn();
    window.electron = {
      chooseDemoFiles: vi.fn().mockResolvedValue(["C:\\Demos\\one.dem", "D:\\two.dem"]),
    };

    render(<DemoUpload onUpload={onUpload} />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(["C:\\Demos\\one.dem", "D:\\two.dem"]);
    });
  });
});
