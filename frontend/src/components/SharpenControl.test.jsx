/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SharpenControl from "./SharpenControl.jsx";

afterEach(cleanup);
const t = (key) => key;
describe("Independent sharpening", () => {
  it("starts off at 0.15 and allows independent enable", () => {
    const onChange = vi.fn();
    render(<SharpenControl t={t} available onChange={onChange} />);
    const toggle = screen.getByRole("button", { name: "montage.sharpenTitle" });
    const slider = screen.getByRole("slider");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(slider.value).toBe("0.15");
    expect(slider.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith({ sharpen_enabled: true });
  });
  it("adjusts from 0.10 to 0.30 without touching frame blending", () => {
    const onChange = vi.fn();
    render(<SharpenControl t={t} available enabled onChange={onChange} />);
    const slider = screen.getByRole("slider");
    expect([slider.min, slider.max, slider.step]).toEqual(["0.1", "0.3", "0.01"]);
    for (const value of ["0.1", "0.3"]) {
      fireEvent.change(slider, { target: { value } });
      expect(onChange).toHaveBeenLastCalledWith({ sharpen_amount: Number(value) });
    }
    fireEvent.click(screen.getByRole("button", { name: "montage.sharpenTitle" }));
    expect(onChange).toHaveBeenLastCalledWith({ sharpen_enabled: false });
  });
  it.each([false, true])("locks unavailable controls and describes legacy=%s", (legacy) => {
    const onChange = vi.fn();
    render(<SharpenControl t={t} legacy={legacy} enabled onChange={onChange} />);
    const toggle = screen.getByRole("button", { name: "montage.sharpenTitle" });
    expect(toggle.disabled).toBe(true);
    expect(screen.getByRole("slider").disabled).toBe(true);
    expect(screen.getByText(legacy ? "montage.sharpenLegacy" : "montage.sharpenUnavailable")).toBeTruthy();
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
