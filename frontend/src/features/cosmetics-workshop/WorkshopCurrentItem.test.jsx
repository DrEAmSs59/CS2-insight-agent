import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CosmeticsWorkshopPage from "./CosmeticsWorkshopPage.jsx";
import { readWorkshopSchemes, writeWorkshopSchemes } from "./workshopSchemeStorage.js";
import { CS2Team } from "@ianlucas/cs2-lib";
import { useLocaleStore } from "../../i18n/localeStore.js";
import WorkshopItemPicker from "./WorkshopItemPicker.jsx";
import { ALL_SKINS, WORKSHOP_CATEGORIES, schemeDefaults, schemeModelChoices } from "./workshopCatalog.js";
vi.mock("./WorkshopItemImage.jsx", async importOriginal => ({
  ...await importOriginal(), default: ({ item }) => <span data-appearance={JSON.stringify(item)} />,
}));
beforeEach(() => { localStorage.clear(); useLocaleStore.getState().hydrate("zh"); });
const appearance = { paint_seed: 661, paint_wear: .234567, custom_name: "我的当前配置",
  stickers: [{ definition_id: 100, name_zh: "保留贴纸", wear: .1, rotation: 33, x: .125 }],
  keychain: { definition_id: 12, seed: 90000, x: 1, y: 2, z: 3 }, attachment_edit_version: 1 };
const grid = () => within(document.querySelector(".lucas-grid"));

test.each(["weapon", "melee", "glove"])("%s pins the equipped snapshot at both picker levels and keeps its entire appearance when selected", category => {
  const team = CS2Team.T;
  const slot = schemeDefaults(category, team)[0];
  const models = schemeModelChoices(category, team, slot);
  const skin = ALL_SKINS.find(row => row.type === category && row.paint_index > 0 && models.some(model => model.def_index === row.def_index));
  const current = { ...skin, ...appearance };
  const choose = vi.fn();
  render(<WorkshopItemPicker category={category} team={team} slotItem={slot} current={current} locale="zh" onClose={() => {}} onChoose={choose} />);
  const first = grid().getAllByRole("button")[0];
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(first.textContent).toContain("正在使用");
  expect(JSON.parse(first.querySelector("[data-appearance]").dataset.appearance)).toEqual(current);
  fireEvent.click(first);
  expect(choose).toHaveBeenLastCalledWith(current);
  if (category !== "weapon") {
    // The model tile remains available for browsing its other finishes.
    const model = models.find(row => row.def_index === current.def_index);
    const modelButton = grid().getAllByRole("button").find(button => JSON.parse(button.querySelector("[data-appearance]").dataset.appearance).catalog_id === model.catalog_id && button !== first);
    fireEvent.click(modelButton);
    const pinnedFinish = grid().getAllByRole("button")[0];
    expect(pinnedFinish.textContent).toContain("正在使用");
    fireEvent.click(pinnedFinish);
    expect(choose).toHaveBeenLastCalledWith(current);
  }
});

if (WORKSHOP_CATEGORIES.includes("agent")) test.each(WORKSHOP_CATEGORIES.filter(category => ["agent", "musickit"].includes(category)))("%s shows the equipped item first without dropping its saved fields", category => {
  const team = CS2Team.T, slot = schemeDefaults(category, team)[0];
  const choices = schemeModelChoices(category, team, slot);
  const current = { ...choices.at(-1), custom_name: "保存的名称", style: 3, stattrak: 42 };
  const choose = vi.fn();
  render(<WorkshopItemPicker category={category} team={team} slotItem={slot} current={current} locale="zh" onClose={() => {}} onChoose={choose} />);
  const first = grid().getAllByRole("button")[0];
  expect(first.textContent).toContain("正在使用");
  expect(first.textContent.trim().length).toBeGreaterThan(4);
  fireEvent.click(first);
  expect(choose).toHaveBeenLastCalledWith(current);
  expect(grid().getAllByRole("button")).toHaveLength(choices.length);
});


test("selecting the first equipped tile and saving keeps attachments, name and parameters across a scheme reload", () => {
  const current = { ...ALL_SKINS.find(row => row.type === "weapon" && row.def_index === 7 && row.paint_index === 302), ...appearance };
  writeWorkshopSchemes([{ id: "current-plan", name: "当前方案", selections: { ct: {}, t: { "weapon:ak47": current } } }]);
  const page = () => <MemoryRouter><CosmeticsWorkshopPage /></MemoryRouter>;
  const view = render(page());
  fireEvent.click(within(screen.getByRole("group", { name: "阵营" })).getByRole("button", { name: "T", exact: true }));
  const slot = within(screen.getByRole("region", { name: "T 方案饰品" })).getAllByRole("button").find(button => button.getAttribute("aria-label").startsWith("AK-47"));
  fireEvent.click(slot);
  const equipped = grid().getAllByRole("button")[0];
  expect(equipped.textContent).toContain("正在使用");
  fireEvent.click(equipped);
  expect(screen.getByRole("textbox", { name: "图案模板" }).value).toBe("661");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存到方案" }));
  const saved = readWorkshopSchemes()[0].selections.t["weapon:ak47"];
  expect(saved).toMatchObject(current);
  expect(saved.stickers).toEqual(current.stickers);
  expect(saved.keychain).toEqual(current.keychain);
  view.unmount(); render(page());
  expect(readWorkshopSchemes()[0].selections.t["weapon:ak47"]).toEqual(saved);
});
