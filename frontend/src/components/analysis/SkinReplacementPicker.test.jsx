import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import SkinReplacementPicker from "./SkinReplacementPicker.jsx";

test("renders 256x192 current/replacement/candidate tiles, search, and confirms selection", async () => {
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

  expect(screen.getByPlaceholderText(/搜索皮肤|Search skins/i)).toBeTruthy();
  const sized = document.querySelectorAll("[data-skin-tile]");
  expect(sized.length).toBeGreaterThan(2);
  for (const el of sized) {
    expect(el.className).toMatch(/w-\[256px\]/);
    expect(el.className).toMatch(/h-\[192px\]/);
  }

  const candidates = screen.getByTestId("skin-candidate-list");
  const first = within(candidates).getAllByRole("button")[0];
  fireEvent.click(first);
  fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm.mock.calls[0][0].paint_seed).toBe(412);
});
