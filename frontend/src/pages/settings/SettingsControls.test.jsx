import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumberInput, RangeField } from "./SettingsControls.jsx";

function NumericField({ component: Component = NumberInput, initialValue = 7, onChange, ...props }) {
  const [value, setValue] = useState(initialValue);
  return <Component ariaLabel="Amount" value={value} {...props} onChange={(next) => {
    onChange?.(next);
    if (typeof next === "number") setValue(next);
  }} />;
}

describe("shared numeric input editing", () => {
  it("keeps a cleared field empty without changing its parent until blur restores the default", () => {
    const onChange = vi.fn();
    render(<NumericField defaultValue={2} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe("2");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(2);
  });

  it.each([0, 1.5, -2])("accepts %s after clearing and keeps it on blur", (value) => {
    const onChange = vi.fn();
    render(<NumericField defaultValue={2} step="any" onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: String(value) } });
    fireEvent.blur(input);
    expect(input.value).toBe(String(value));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(value);
  });

  it.each([[0, 0], [-5, 0], [20, 10]])("restores default %s within the field bounds", (defaultValue, expected) => {
    render(<NumericField defaultValue={defaultValue} min={0} max={10} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe(String(expected));
  });

  it("uses the current value for older callers without an explicit default", () => {
    render(<NumericField />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("7");
  });

  it("shows an external reset even while the draft is empty", () => {
    const onChange = vi.fn();
    const view = render(<NumberInput ariaLabel="Amount" value={7} defaultValue={2} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    view.rerender(<NumberInput ariaLabel="Amount" value={9} defaultValue={2} onChange={onChange} />);
    expect(screen.getByRole("spinbutton").value).toBe("9");
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the range slider at the accepted value until the cleared number is restored", () => {
    render(<NumericField component={RangeField} initialValue={5} defaultValue={2} min={0} max={6} step={0.1} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    const slider = screen.getByRole("slider", { name: "Amount" });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(slider.value).toBe("5");
    fireEvent.blur(input);
    expect(input.value).toBe("2");
    expect(slider.value).toBe("2");

    fireEvent.change(input, { target: { value: "9" } });
    expect(input.value).toBe("9");
    expect(slider.value).toBe("2");
    fireEvent.blur(input);
    expect(input.value).toBe("6");
    expect(slider.value).toBe("6");
    fireEvent.change(slider, { target: { value: "3" } });
    expect(input.value).toBe("3");
  });

  it("keeps a below-minimum prefix while entering 150 and clamps an unfinished value on blur", () => {
    const onChange = vi.fn();
    render(<NumericField component={RangeField} initialValue={12} defaultValue={12} min={2} max={150} step={0.5} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Amount" });
    const slider = screen.getByRole("slider", { name: "Amount" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "1" } });
    expect(input.value).toBe("1");
    expect(slider.value).toBe("12");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.blur(input);
    expect(input.value).toBe("150");
    expect(slider.value).toBe("150");
    expect(onChange).toHaveBeenLastCalledWith(150);

    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    expect(input.value).toBe("2");
    expect(slider.value).toBe("2");
  });
});
