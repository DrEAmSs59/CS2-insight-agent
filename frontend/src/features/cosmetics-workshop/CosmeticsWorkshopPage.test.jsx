import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useLocaleStore } from "../../i18n/localeStore.js";
import CosmeticsWorkshopPage from "./CosmeticsWorkshopPage.jsx";

describe("CosmeticsWorkshopPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useLocaleStore.getState().hydrate("zh");
  });

  const renderPage = () => render(
    <MemoryRouter initialEntries={["/cosmetics-workshop"]}>
      <CosmeticsWorkshopPage />
    </MemoryRouter>,
  );

  test("uses vanilla items as the catalogue entry instead of exposing skins immediately", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "饰品工坊" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "原皮目录" })).toBeNull();
    expect(screen.queryByText(/\d+ 种原皮/)).toBeNull();
    const butterfly = screen.getByRole("button", { name: /^★ 蝴蝶刀$/ });
    expect(within(butterfly).getByText(/\d+ 款皮肤/).className).toContain("text-[10px]");
    const preview = butterfly.querySelector("[data-workshop-preview]");
    expect(preview.className).toContain("h-[138px]");
    expect(preview.className).not.toContain("aspect-[4/3]");
    expect(preview.querySelector("img").className).toContain("p-2");
    expect(screen.queryByText(/^原皮$/)).toBeNull();
    expect(screen.getByText("点击物品，查看该物品的全部皮肤").className).toContain("text-[11px]");
    expect(screen.queryByText(/CS-LIB/)).toBeNull();
    expect(screen.queryByPlaceholderText("搜索原皮名称或武器…")).toBeNull();
    expect(screen.queryByText("多普勒")).toBeNull();
    expect(screen.queryByRole("heading", { name: "饰品检视" })).toBeNull();
  });

  test("opens a model skin list and only then launches on-demand inspect", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /^★ 蝴蝶刀$/ }));
    expect(screen.getByRole("heading", { name: "★ 蝴蝶刀 · 全部皮肤" })).toBeTruthy();
    expect(screen.getByText(/共 \d+ 款，点击卡片内的检视按钮按需预览/).className).toContain("text-[12px]");
    expect(within(screen.getByRole("dialog")).queryByText("当前原皮入口")).toBeNull();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "关闭" })).toBeNull();

    const list = screen.getByTestId("workshop-skin-list");
    expect(list.querySelector("[data-workshop-preview]").className).toContain("aspect-[4/3]");
    fireEvent.click(within(list).getAllByRole("button", { name: /^★ 蝴蝶刀 \|/ })[0]);
    expect(within(list).queryByRole("button", { pressed: true })).toBeNull();
    expect(within(list).getAllByRole("button", { name: "游戏内检视" }).length).toBeGreaterThan(0);
    expect(within(list).getAllByRole("button", { name: "3D 检视" }).length).toBeGreaterThan(0);

    fireEvent.click(within(list).getAllByRole("button", { name: "游戏内检视" })[0]);
    const gameInspectDialog = screen.getByRole("heading", { name: "游戏内检视" }).closest("[role='dialog']");
    expect(gameInspectDialog).toBeTruthy();
    expect(within(gameInspectDialog).getByRole("spinbutton", { name: "磨损" })).toBeTruthy();
    expect(within(gameInspectDialog).getByRole("spinbutton", { name: "模板" })).toBeTruthy();
    fireEvent.click(within(gameInspectDialog).getByRole("button", { name: "取消" }));

    fireEvent.click(within(list).getAllByRole("button", { name: "3D 检视" })[0]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "饰品检视" })).toBeTruthy());
    expect(screen.getByTitle("饰品检视")).toBeTruthy();
  });

  test("uses the replacement-style craft name for knives", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /^★ 暗影双匕$/ }));
    const list = screen.getByTestId("workshop-skin-list");

    expect(within(list).getByRole("button", {
      name: "★ 暗影双匕 | 多普勒 | Phase 2",
    })).toBeTruthy();
  });

  test("filters weapons by detailed subcategory", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "枪械" }));
    const categories = screen.getByLabelText("枪械子分类");
    expect(categories.parentElement.contains(screen.getByText("点击物品，查看该物品的全部皮肤"))).toBe(true);
    expect(within(categories).getByRole("button", { name: "狙击枪" })).toBeTruthy();
    expect(within(categories).getByRole("button", { name: "步枪" })).toBeTruthy();
    expect(within(categories).getByRole("button", { name: "冲锋枪" })).toBeTruthy();
    expect(within(categories).getByRole("button", { name: "手枪" })).toBeTruthy();
    expect(within(categories).getByRole("button", { name: "霰弹枪" })).toBeTruthy();

    fireEvent.click(within(categories).getByRole("button", { name: "狙击枪" }));
    expect(screen.getByRole("button", { name: "AWP" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AK-47" })).toBeNull();

    fireEvent.click(within(categories).getByRole("button", { name: "霰弹枪" }));
    expect(screen.getByRole("button", { name: "XM1014" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AWP" })).toBeNull();
  });

  test("maintains one CT/T plan and can delete then recreate it", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));
    expect(screen.getByRole("heading", { name: "饰品方案" })).toBeTruthy();
    expect(screen.getByTestId("scheme-layout").className).toContain("grid-cols-[190px_minmax(0,1fr)]");
    expect(screen.getByTestId("scheme-plan-card").querySelector(".lucide-gem")).toBeNull();
    expect(screen.getByRole("button", { name: "保存方案" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "一键套用" })).toBeNull();
    expect(screen.queryByText("当前为本地方案预览，不会修改游戏库存。")).toBeNull();
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^★ / })[0].className).toContain("min-h-[170px]");
    expect(screen.getByRole("button", { name: "CT · 28" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "T · 26" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新增方案" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "修改方案名称" }));
    const nameInput = screen.getByRole("textbox", { name: "方案名称" });
    fireEvent.change(nameInput, { target: { value: "主力方案" } });
    fireEvent.submit(nameInput.closest("form"));
    expect(screen.getAllByText("主力方案")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    expect(screen.getByRole("button", { name: "方案已保存" })).toBeTruthy();
    const savedPlans = JSON.parse(localStorage.getItem("cs2-insight:cosmetics-workshop-plan:v1"));
    expect(savedPlans).toHaveLength(1);
    expect(savedPlans[0].name).toBe("主力方案");

    fireEvent.click(screen.getByRole("button", { name: "删除方案" }));
    expect(screen.getByText("还没有饰品方案")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "新增方案" })[0].disabled).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: "新增方案" })[0]);
    expect(screen.getByRole("button", { name: "CT · 28" })).toBeTruthy();
    expect(screen.queryByText("CT / T 全部使用原皮")).toBeNull();
  });

  test("edits a T weapon slot through the same skin selection flow", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));
    fireEvent.click(screen.getByRole("button", { name: "T · 26" }));
    fireEvent.click(screen.getByRole("button", { name: /^AK-47$/ }));

    expect(screen.getByRole("heading", { name: "AK-47 · 全部皮肤" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("搜索皮肤、相位或英文名…"), { target: { value: "野荷" } });
    const candidate = await screen.findByRole("button", { name: "野荷" });
    expect(within(candidate).getByText("野荷").style.color).not.toBe("");
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");

    const config = screen.getByTestId("scheme-skin-config");
    const list = screen.getByTestId("workshop-skin-list");
    expect(within(list).queryByRole("button", { name: "游戏内检视" })).toBeNull();
    expect(within(list).queryByRole("button", { name: "3D 检视" })).toBeNull();
    expect(within(config).getByRole("button", { name: "游戏内检视" })).toBeTruthy();
    expect(within(config).getByRole("button", { name: "3D 检视" })).toBeTruthy();
    expect(within(config).getByText("图案模板")).toBeTruthy();
    const wearInput = within(config).getByRole("spinbutton", { name: "磨损" });
    const seedInput = within(config).getByRole("spinbutton", { name: "图案模板" });
    fireEvent.change(wearInput, { target: { value: "0.42" } });
    fireEvent.change(seedInput, { target: { value: "777" } });
    expect(wearInput.value).toBe("0.420000");
    expect(seedInput.value).toBe("777");
    fireEvent.click(within(config).getByRole("button", { name: "应用到方案" }));

    await waitFor(() => expect(screen.getByText("野荷")).toBeTruthy());
    expect(screen.queryByText("已换肤")).toBeNull();
    const equippedAk = screen.getByRole("button", { name: /^AK-47$/ });
    expect(equippedAk.className).not.toContain("border-cs2-accent/50");
    expect(within(equippedAk).getByText("AK-47").className).toContain("text-[12px]");
    expect(within(equippedAk).getByText("野荷").className).toContain("text-[10px]");

    fireEvent.click(screen.getByRole("button", { name: /^AK-47$/ }));
    fireEvent.change(screen.getByPlaceholderText("搜索皮肤、相位或英文名…"), { target: { value: "野荷" } });
    const savedCandidate = await screen.findByRole("button", { name: "野荷" });
    expect(savedCandidate.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(savedCandidate);
    const savedConfig = screen.getByTestId("scheme-skin-config");
    expect(within(savedConfig).getByRole("spinbutton", { name: "磨损" }).value).toBe("0.420000");
    expect(within(savedConfig).getByRole("spinbutton", { name: "图案模板" }).value).toBe("777");

    fireEvent.click(within(savedConfig).getByRole("button", { name: "应用到方案" }));
    await waitFor(() => expect(screen.queryByTestId("scheme-skin-config")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
    const persisted = JSON.parse(localStorage.getItem("cs2-insight:cosmetics-workshop-plan:v1"));
    const persistedWeapon = Object.values(persisted[0].selections.t).find((item) => item?.name_zh?.includes("野荷"));
    expect(persistedWeapon.paint_wear).toBe(0.42);
    expect(persistedWeapon.paint_seed).toBe(777);
  });

  test("filters scheme knife skins by knife type", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));

    const scheme = screen.getByRole("dialog");
    fireEvent.click(within(scheme).getAllByRole("button", { name: /^★ / })[0]);

    const types = screen.getByLabelText("刀具类型");
    expect(within(types).getByRole("button", { name: /^全部类型 · \d+$/ })).toBeTruthy();
    const butterflyType = within(types).getByRole("button", { name: /^蝴蝶刀 · \d+$/ });
    fireEvent.click(butterflyType);

    expect(butterflyType.getAttribute("aria-pressed")).toBe("true");
    const list = screen.getByTestId("workshop-skin-list");
    expect(within(list).getAllByRole("button", { name: /^★ 蝴蝶刀 \|/ }).length).toBeGreaterThan(0);
    expect(within(list).queryByRole("button", { name: /^★ 暗影双匕 \|/ })).toBeNull();
  });

  test("shows the shared type filter when choosing scheme gloves", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));

    const scheme = screen.getByRole("dialog");
    fireEvent.click(within(scheme).getByRole("button", { name: /默认.*手套/ }));

    const types = screen.getByLabelText("手套类型");
    expect(within(types).getByRole("button", { name: /^全部类型 · \d+$/ })).toBeTruthy();
    const specialistType = within(types).getByRole("button", { name: /^专业手套 · \d+$/ });
    fireEvent.click(specialistType);
    expect(specialistType.getAttribute("aria-pressed")).toBe("true");
  });
});
