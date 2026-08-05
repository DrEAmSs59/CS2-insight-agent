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
  expect(candidates.className).toMatch(/grid-cols-5/);
  expect(candidates.className).toMatch(/flex-1/);
  // Search stays in the candidate panel, above the grid.
  expect(search.compareDocumentPosition(candidates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(search.parentElement?.contains(candidates)).toBe(true);

  const sized = candidates.querySelectorAll("[data-skin-tile]");
  expect(sized.length).toBeGreaterThan(2);
  for (const el of sized) {
    expect(el.className).toMatch(/h-\[128px\]/);
  }

  const currentSkin = screen.getByTestId("skin-picker-current");
  expect(within(currentSkin).getByText("0.250000")).toBeTruthy();
  expect(within(currentSkin).getByText("412")).toBeTruthy();
  expect(within(currentSkin).queryByRole("slider")).toBeNull();
  expect(within(currentSkin).queryByRole("textbox")).toBeNull();
  expect(screen.getAllByDisplayValue("0.000000").length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByDisplayValue("0").some((input) => !input.readOnly && !input.disabled)).toBe(true);

  const first = within(candidates).getAllByRole("button")[0];
  fireEvent.click(first);
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0].paint_wear).toBe(0);
  expect(onConfirm.mock.calls[0][0].paint_seed).toBe(0);
});

test("groups knife candidates by model tag before showing finishes", () => {
  render(
    <SkinReplacementPicker
      open
      locale="zh"
      onlineAssetsEnabled={false}
      sourceItem={{
        type: "melee",
        def_index: 507,
        model: "knife_karambit",
        name_zh: "爪子刀 | 多普勒",
        name_en: "Karambit | Doppler",
        paint_wear: 0.023656,
        paint_seed: 701,
        image_url: "",
      }}
      onClose={() => {}}
      onConfirm={() => {}}
    />,
  );

  const filters = screen.getByTestId("skin-type-filters");
  expect(within(filters).getByRole("button", { name: /爪子刀/ }).getAttribute("aria-pressed")).toBe("true");
  const butterfly = within(filters).getByRole("button", { name: /蝴蝶刀/ });
  fireEvent.click(butterfly);

  expect(butterfly.getAttribute("aria-pressed")).toBe("true");
  const candidates = within(screen.getByTestId("skin-candidate-list")).getAllByRole("button");
  expect(candidates.length).toBeGreaterThan(1);
  expect(candidates.every((candidate) => /蝴蝶刀/.test(candidate.getAttribute("aria-label") || ""))).toBe(true);
});

test("keeps Specialist Gloves catalog identity when replacing Sport Gloves", () => {
  const onConfirm = vi.fn();
  render(
    <SkinReplacementPicker
      open
      locale="zh"
      onlineAssetsEnabled={false}
      sourceItem={{
        type: "glove",
        def_index: 5030,
        model: "sporty_gloves",
        name_zh: "运动手套 | 欧米伽",
        name_en: "Sport Gloves | Omega",
        paint_wear: 0.600376,
        paint_seed: 278,
        image_url: "",
      }}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );

  fireEvent.click(within(screen.getByTestId("skin-type-filters")).getByRole("button", { name: /专业手套/ }));
  fireEvent.click(
    within(screen.getByTestId("skin-candidate-list")).getByRole("button", { name: /专业手套 \| 深红和服/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0]).toMatchObject({
    catalog_id: 1764,
    def_index: 5034,
    paint_index: 10033,
    model: "specialist_gloves",
    type: "glove",
  });
});

test("uses the selected finish wear range and rejects out-of-range input", () => {
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
        name_zh: "AK-47 | 表面淬火",
        name_en: "AK-47 | Case Hardened",
        paint_wear: 0.25,
        paint_seed: 412,
        image_url: "",
      }}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );

  const candidates = screen.getByTestId("skin-candidate-list");
  fireEvent.click(within(candidates).getByRole("button", { name: /AK-47 \| 红线|AK-47 \| Redline/i }));

  const replacement = screen.getByTestId("skin-picker-replacement");
  const wearInput = within(replacement).getByDisplayValue("0.100000");
  const wearSlider = within(replacement).getAllByRole("slider")[0];
  expect(wearSlider.getAttribute("min")).toBe("0.1");
  expect(wearSlider.getAttribute("max")).toBe("0.7");
  expect(within(replacement).getByText("0.100000–0.700000")).toBeTruthy();

  fireEvent.change(wearInput, { target: { value: "0.099999" } });
  expect(screen.getByRole("button", { name: /确认|Confirm/i }).disabled).toBe(true);
  expect(screen.getByText(/0.100000–0.700000/)).toBeTruthy();

  fireEvent.change(wearInput, { target: { value: "0.700000" } });
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0]).toMatchObject({
    paint_wear: 0.7,
    wear_min: 0.1,
    wear_max: 0.7,
  });
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
