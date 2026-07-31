import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import CosmeticsView from "./CosmeticsView";

const STEAM_ID = "76561198000000001";

function cosmetic(overrides = {}) {
  return {
    catalog_id: 1001,
    def_index: 508,
    paint_index: 415,
    paint_seed: 80,
    paint_wear: 0.016897,
    item_id: 53009600926,
    type: "melee",
    name_en: "M9 Bayonet | Doppler",
    name_zh: "M9 刺刀 | 多普勒",
    rarity: "#eb4b4b",
    teams: 2,
    observed_teams: ["t", "ct"],
    catalog_exact: true,
    ownership_evidence: "demo_skin_table",
    stickers: [],
    ...overrides,
  };
}

describe("CosmeticsView", () => {
  test("shows only the selected player's evidence-owned inventory in CT/T team rows", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ custom_name: "全角，测试！" }),
                cosmetic({ catalog_id: 2002, item_id: 53009600927, type: "weapon", name_zh: "AWP | 九头金蛇" }),
              ],
              76561198000000002: [cosmetic({ custom_name: "不属于 JW" })],
            },
          },
        }}
      />,
    );

    expect(screen.getAllByText("“全角，测试！”").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AWP | 九头金蛇").length).toBeGreaterThan(0);
    expect(screen.queryByText("“不属于 JW”")).toBeNull();
    expect(screen.getByTestId("cosmetics-row-ct")).toBeTruthy();
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
    expect(container.querySelectorAll("[data-cosmetic-card]")).toHaveLength(4);
    expect(container.querySelectorAll("[data-cosmetic-card-label].h-8")).toHaveLength(4);
  });

  test("renders CT then T rows from observed_teams and dual-team items appear in both", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ item_id: 1, observed_teams: ["ct"], name_zh: "CT 刀" }),
                cosmetic({ item_id: 2, observed_teams: ["t"], type: "weapon", model: "ak47", name_zh: "T AK" }),
                cosmetic({ item_id: 3, observed_teams: ["ct", "t"], catalog_id: 2003, name_zh: "双阵营刀" }),
              ],
            },
          },
        }}
      />,
    );

    const ctRow = screen.getByTestId("cosmetics-row-ct");
    const tRow = screen.getByTestId("cosmetics-row-t");
    expect(ctRow.compareDocumentPosition(tRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(ctRow).getByText("CT 刀")).toBeTruthy();
    expect(within(ctRow).getByText("双阵营刀")).toBeTruthy();
    expect(within(ctRow).queryByText("T AK")).toBeNull();
    expect(within(tRow).getByText("T AK")).toBeTruthy();
    expect(within(tRow).getByText("双阵营刀")).toBeTruthy();
    expect(within(tRow).queryByText("CT 刀")).toBeNull();
    expect(screen.getAllByTestId("cosmetics-row-ct").length).toBe(1);
    expect(document.querySelectorAll("[data-cosmetic-card]")).toHaveLength(4);
  });

  test("replaces evidence count with customize entry and removes card team dots", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
      />,
    );

    expect(screen.getByRole("button", { name: /自定义饰品|Customize skins/i })).toBeTruthy();
    expect(screen.queryByText(/2 items|2 件饰品/)).toBeNull();
    for (const card of container.querySelectorAll("[data-cosmetic-card]")) {
      expect(within(card).queryByLabelText(/Equipped-team|装备阵营/)).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    expect(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^取消$|^Cancel$/ })).toBeTruthy();
  });

  test("opens item details on click and inspect actions on right click", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ custom_name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" })] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getAllByRole("button", { name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" })[0];
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(menu.className).toContain("bg-white");
    expect(menu.className).toContain("rounded-md");
    expect(menu.parentElement).toBe(document.body);

    fireEvent.pointerDown(document.body);
    fireEvent.click(card);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Lᵒᵛᵉᵧₒᵤ 玫瑰の吻").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("53009600926")).toBeTruthy();
    expect(dialog.textContent).not.toContain("OriginalOwner");
  });

  test("opens the hosted viewer without its light backdrop", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getAllByRole("button", { name: "M9 刺刀 | 多普勒" })[0];
    fireEvent.click(card);
    fireEvent.click(container.querySelector("[data-cosmetic-open-3d]"));

    const frame = container.querySelector("[data-cosmetic-inspect-stage] iframe");
    expect(new URL(frame.getAttribute("src")).searchParams.get("bg")).toBe("0");
    expect(container.querySelector("[data-cosmetic-inspect-stage]")).toBeTruthy();
  });

  test("shows seed, wear, asset id and custom name in the hover information card", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ custom_name: "玫瑰の吻", ownership_evidence: "active_weapon_original_owner" })] } } }}
      />,
    );

    fireEvent.pointerEnter(screen.getAllByRole("button", { name: "玫瑰の吻" })[0]);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("“玫瑰の吻”")).toBeTruthy();
    expect(within(tooltip).getByText("80")).toBeTruthy();
    expect(within(tooltip).getByText("0.016897")).toBeTruthy();
    expect(within(tooltip).getByText("53009600926")).toBeTruthy();
    expect(tooltip.textContent).not.toContain("OriginalOwner");
  });

  test("resolves the selected player against the workspace roster before reading cosmetics", () => {
    const currentSteamId = "76561198000000002";
    render(
      <CosmeticsView
        selectedPlayer={{ name: "magixx", steamid64: STEAM_ID }}
        workspace={{
          players: [{ name: "magixx", steam_id64: currentSteamId }],
          cosmetics: {
            players: {
              [STEAM_ID]: [cosmetic({ name_zh: "错误归属的刀", item_id: 1 })],
              [currentSteamId]: [cosmetic({ name_zh: "正确归属的刀", item_id: 2 })],
            },
          },
        }}
      />,
    );

    expect(screen.getAllByText("正确归属的刀").length).toBeGreaterThan(0);
    expect(screen.queryByText("错误归属的刀")).toBeNull();
  });

  test("renders agent and music-kit evidence alongside equipment", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ catalog_id: 8666, item_id: undefined, def_index: 4736, paint_index: 0, type: "agent", name_zh: "探员 | 血腥达里尔爵士（沉默）", paint_seed: undefined, paint_wear: undefined }),
                cosmetic({ catalog_id: 12000, item_id: undefined, def_index: 1314, paint_index: 76, type: "musickit", name_zh: "音乐盒 | Under Bright Lights", paint_seed: undefined, paint_wear: undefined }),
              ],
            },
          },
        }}
      />,
    );

    expect(screen.getAllByText("探员 | 血腥达里尔爵士（沉默）").length).toBeGreaterThan(0);
    expect(screen.getAllByText("音乐盒 | Under Bright Lights").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-cosmetic-card]")).toHaveLength(4);
  });

  test("keeps inspect actions disabled when a glove finish was not retained", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ type: "glove", finish_known: false, name_zh: "裹手", paint_index: 0, paint_seed: undefined, paint_wear: 0.19942 })] } } }}
      />,
    );

    const card = screen.getAllByRole("button", { name: "裹手" })[0];
    fireEvent.pointerEnter(card);
    expect(screen.getByRole("tooltip").textContent).toContain("No finish is guessed");
    fireEvent.pointerLeave(card);
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    for (const action of within(screen.getByRole("menu")).getAllByRole("menuitem")) {
      expect(action.disabled).toBe(true);
    }
  });
});
