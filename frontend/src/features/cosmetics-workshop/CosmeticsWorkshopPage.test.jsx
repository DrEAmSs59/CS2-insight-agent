import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useLocaleStore } from "../../i18n/localeStore.js";
import CosmeticsWorkshopPage from "./CosmeticsWorkshopPage.jsx";
import { WORKSHOP_SCHEME_STORAGE_KEY, readWorkshopSchemes, writeWorkshopSchemes } from "./workshopSchemeStorage.js";

function createScheme(name = "我的方案") {
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  fireEvent.change(screen.getByRole("textbox", { name: "方案名称" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
}

describe("Free workshop UI and edition boundary", () => {
  beforeEach(() => { localStorage.clear(); useLocaleStore.getState().hydrate("zh"); });

  it("browses models before skins and keeps the original three item kinds", () => {
    render(<CosmeticsWorkshopPage />);
    fireEvent.click(screen.getByRole("button", { name: "饰品大全" }));
    expect(screen.getByRole("button", { name: "AK-47" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "探员" })).toBeNull();
    expect(screen.queryByRole("button", { name: "音乐盒" })).toBeNull();
    expect(screen.queryByTitle("3D 检视")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "AK-47" }));
    const skins = screen.getAllByRole("button", { name: /^AK-47 \|/ });
    expect(skins.length).toBeGreaterThan(0);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(skins[0]);
    fireEvent.click(screen.getByRole("button", { name: "3D 检视" }));
    expect(document.querySelector("iframe").src).toMatch(/^https:/);
  });

  it("keeps one scheme and allows deleting then recreating it", () => {
    render(<CosmeticsWorkshopPage />);
    createScheme();
    expect(readWorkshopSchemes()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "创建" }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /检视链接导入/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(readWorkshopSchemes()).toHaveLength(0);
    createScheme("新的方案");
    expect(readWorkshopSchemes()[0].name).toBe("新的方案");
  });

  it("edits a T weapon's wear and pattern without adding Pro appearance fields", () => {
    render(<CosmeticsWorkshopPage />);
    createScheme();
    fireEvent.click(screen.getByRole("button", { name: "T", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "AK-47", exact: true }));
    fireEvent.click(screen.getAllByRole("button", { name: /^AK-47 \|/ })[0]);
    const dialog = screen.getByRole("dialog");
    const pattern = within(dialog).getByRole("textbox", { name: "图案模板" });
    fireEvent.change(pattern, { target: { value: "42" } });
    const wear = within(dialog).getAllByRole("textbox").find(input => input !== pattern);
    fireEvent.change(wear, { target: { value: "0.2" } });
    expect(within(dialog).queryByText(/贴纸|挂件|名称标签|实验性/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存到方案" }));
    const item = readWorkshopSchemes()[0].selections.t["weapon:ak47"];
    expect(item.paint_seed).toBe(42);
    expect(item.paint_wear).toBe(0.2);
    expect(item).not.toHaveProperty("attachment_edit_version");
    expect(item).not.toHaveProperty("experimental_paint_source_catalog_id");
  });

  it("does not expose extra stored schemes or overwrite storage on an invalid multi-scheme save", () => {
    const first = { id: "first", name: "第一套", selections: { ct: {}, t: {} } };
    const second = { ...first, id: "second", name: "第二套" };
    localStorage.setItem(WORKSHOP_SCHEME_STORAGE_KEY, JSON.stringify([first, second]));
    expect(readWorkshopSchemes()).toHaveLength(1);
    const saved = localStorage.getItem(WORKSHOP_SCHEME_STORAGE_KEY);
    expect(writeWorkshopSchemes([first, second])).toBe(false);
    expect(localStorage.getItem(WORKSHOP_SCHEME_STORAGE_KEY)).toBe(saved);
    render(<CosmeticsWorkshopPage />);
    expect(screen.queryByRole("option", { name: "第二套" })).toBeNull();
  });
});
