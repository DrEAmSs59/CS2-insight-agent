import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const historyMocks = vi.hoisted(() => ({
  beginPropertyEdit: vi.fn(),
  endPropertyEdit: vi.fn(),
}));

vi.mock("../state/timelineStore.js", () => ({
  useLiteCutTimelineStore: (selector) => selector(historyMocks),
}));

import { NumericPairCard, PaneSection, ProSlider } from "./PropertyControls.jsx";

describe("PropertyControls", () => {
  beforeEach(() => {
    historyMocks.beginPropertyEdit.mockClear();
    historyMocks.endPropertyEdit.mockClear();
  });

  it("toggles a property pane without a component-library wrapper", () => {
    render(<PaneSection title="Transform"><div>Pane body</div></PaneSection>);

    const toggle = screen.getByRole("button", { name: "Transform" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Pane body")).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Pane body").closest(".litecut-property-collapse-content")?.hidden).toBe(true);
  });

  it("keeps slider, numeric input, and history edit callbacks connected", () => {
    const onChange = vi.fn();
    render(<ProSlider label="Opacity" value={25} min={0} max={100} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "Opacity" });
    expect(slider.className).toContain("cs2-data-slider");
    expect(slider.style.getPropertyValue("--cs2-range-progress")).toBe("25%");
    expect(screen.getByRole("spinbutton").className).toContain("litecut-property-number");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.pointerUp(slider);

    expect(historyMocks.beginPropertyEdit).toHaveBeenCalled();
    expect(historyMocks.endPropertyEdit).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(40);

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "55" } });
    expect(onChange).toHaveBeenCalledWith(55);
  });

  it("updates both values in a numeric pair", () => {
    const onFirstChange = vi.fn();
    const onSecondChange = vi.fn();
    render(
      <NumericPairCard
        title="Size"
        firstLabel="W"
        firstValue={100}
        onFirstChange={onFirstChange}
        secondLabel="H"
        secondValue={50}
        onSecondChange={onSecondChange}
      />,
    );

    const inputs = screen.getAllByRole("spinbutton");
    fireEvent.change(inputs[0], { target: { value: "120" } });
    fireEvent.change(inputs[1], { target: { value: "60" } });

    expect(onFirstChange).toHaveBeenCalledWith(120);
    expect(onSecondChange).toHaveBeenCalledWith(60);
  });
});
