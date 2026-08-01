import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import SkinReplacementPicker from "./SkinReplacementPicker.jsx";

test("renders candidate search under title, fills grid, defaults replacement wear/seed to 0", async () => {
  const onConfirm = vi.fn();
  render(
    <SkinReplacementPicker
      open
      locale="zh"
      onlineAssetsEnabled={false}
      sourceItem={{
        type: "weapon",
        def_index: 7,
        model: "ak47",
        name_zh: "AK-47 | 红线",
        name_en: "AK-47 | Redline",
        paint_wear: 0.25,
        paint_seed: 412,
        image_url: "",
      }}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );

  const search = screen.getByPlaceholderText(/搜索皮肤|Search skins/i);
  const currentColumn = screen.getByTestId("skin-picker-current-column");
  expect(currentColumn.className).toMatch(/overflow-y-auto/);
  const candidates = screen.getByTestId("skin-candidate-list");
  expect(candidates.className).toMatch(/grid-cols-3/);
  expect(candidates.className).toMatch(/flex-1/);
  // Search stays in the candidate panel, above the grid.
  expect(search.compareDocumentPosition(candidates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(search.parentElement?.contains(candidates)).toBe(true);

  const sized = document.querySelectorAll("[data-skin-tile]");
  expect(sized.length).toBeGreaterThan(2);
  for (const el of sized) {
    expect(el.className).toMatch(/h-\[192px\]/);
  }

  expect(screen.getByDisplayValue("0.250000")).toBeTruthy();
  expect(screen.getAllByDisplayValue("0.000000").length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByDisplayValue("0").some((input) => !input.readOnly && !input.disabled)).toBe(true);

  const first = within(candidates).getAllByRole("button")[0];
  fireEvent.click(first);
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0].paint_wear).toBe(0);
  expect(onConfirm.mock.calls[0][0].paint_seed).toBe(0);
});

test("replacement seed must be an integer between 0 and 1000", () => {
  const onConfirm = vi.fn();
  render(
    <SkinReplacementPicker
      open
      locale="zh"
      onlineAssetsEnabled={false}
      sourceItem={{
        type: "weapon",
        def_index: 7,
        model: "ak47",
        name_zh: "AK-47 | 红线",
        name_en: "AK-47 | Redline",
        paint_wear: 0.25,
        paint_seed: 412,
        image_url: "",
      }}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );

  const candidates = screen.getByTestId("skin-candidate-list");
  fireEvent.click(within(candidates).getAllByRole("button")[0]);

  const editableSeed = screen
    .getAllByDisplayValue("0")
    .find((input) => input.tagName === "INPUT" && input.type === "text" && !input.readOnly && !input.disabled);
  expect(editableSeed).toBeTruthy();
  fireEvent.change(editableSeed, { target: { value: "1001" } });
  expect(screen.getByRole("button", { name: /确认|Confirm/i }).disabled).toBe(true);
  expect(screen.getByText(/0–1000|0 to 1000/i)).toBeTruthy();

  fireEvent.change(editableSeed, { target: { value: "999" } });
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0].paint_seed).toBe(999);
});
