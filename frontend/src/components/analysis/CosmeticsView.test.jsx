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
  test("shows only the selected player's evidence-owned inventory in the six-column grid", () => {
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

    expect(screen.getByText("“全角，测试！”")).toBeTruthy();
    expect(screen.getByText("AWP | 九头金蛇")).toBeTruthy();
    expect(screen.queryByText("“不属于 JW”")).toBeNull();
    expect(container.querySelector(".xl\\:grid-cols-6")).toBeTruthy();
    expect(container.querySelector(".items-start")).toBeTruthy();
    expect(container.querySelectorAll("[data-cosmetic-card]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-cosmetic-card-label].h-8")).toHaveLength(2);
  });

  test("opens item details on click and inspect actions on right click", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ custom_name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" })] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getByRole("button", { name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" });
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem")).toHaveLength(2);

    fireEvent.pointerDown(document.body);
    fireEvent.click(card);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Lᵒᵛᵉᵧₒᵤ 玫瑰の吻").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("53009600926")).toBeTruthy();
  });

  test("opens the hosted viewer without its light backdrop", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getByRole("button", { name: "M9 刺刀 | 多普勒" });
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
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ custom_name: "玫瑰の吻" })] } } }}
      />,
    );

    fireEvent.pointerEnter(screen.getByRole("button", { name: "玫瑰の吻" }));
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("“玫瑰の吻”")).toBeTruthy();
    expect(within(tooltip).getByText("80")).toBeTruthy();
    expect(within(tooltip).getByText("0.016897")).toBeTruthy();
    expect(within(tooltip).getByText("53009600926")).toBeTruthy();
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

    expect(screen.getByText("探员 | 血腥达里尔爵士（沉默）")).toBeTruthy();
    expect(screen.getByText("音乐盒 | Under Bright Lights")).toBeTruthy();
    expect(container.querySelectorAll("[data-cosmetic-card]")).toHaveLength(2);
  });

  test("keeps inspect actions disabled when a glove finish was not retained", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ type: "glove", finish_known: false, name_zh: "裹手", paint_index: 0, paint_seed: undefined, paint_wear: 0.19942 })] } } }}
      />,
    );

    const card = screen.getByRole("button", { name: "裹手" });
    fireEvent.pointerEnter(card);
    expect(screen.getByRole("tooltip").textContent).toContain("No finish is guessed");
    fireEvent.pointerLeave(card);
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    for (const action of within(screen.getByRole("menu")).getAllByRole("menuitem")) {
      expect(action.disabled).toBe(true);
    }
  });
});
