import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import CosmeticsView from "./CosmeticsView";
import { loadCustomSkinPlan, saveCustomSkinPlan } from "./saveCustomSkinPlan.js";

vi.mock("./saveCustomSkinPlan.js", () => ({
  saveCustomSkinPlan: vi.fn(async () => ({ ok: true })),
  loadCustomSkinPlan: vi.fn(async () => ({ ok: true, plan: null })),
}));

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
                cosmetic({
                  catalog_id: 2002,
                  item_id: 53009600927,
                  type: "weapon",
                  model: "awp",
                  def_index: 9,
                  name_zh: "AWP | 九头金蛇",
                  name_en: "AWP | The Empress",
                }),
              ],
              76561198000000002: [cosmetic({ custom_name: "不属于 JW" })],
            },
          },
        }}
      />,
    );

    expect(screen.getAllByText("“全角，测试！”").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AWP").length).toBeGreaterThan(0);
    expect(screen.getAllByText("九头金蛇").length).toBeGreaterThan(0);
    expect(screen.queryByText("“不属于 JW”")).toBeNull();
    expect(screen.getByTestId("cosmetics-row-ct")).toBeTruthy();
    expect(screen.queryByTestId("cosmetics-row-t")).toBeNull();
    expect(screen.getByTestId("cosmetics-team-tab-ct")).toBeTruthy();
    expect(screen.getByTestId("cosmetics-team-tab-t")).toBeTruthy();
    // Evidence knife + AWP + natural glove placeholder (no default weapon rows).
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBe(3);
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
                cosmetic({ item_id: 2, observed_teams: ["t"], type: "weapon", model: "ak47", def_index: 7, name_zh: "T AK" }),
                cosmetic({ item_id: 3, observed_teams: ["ct", "t"], catalog_id: 2003, name_zh: "双阵营刀" }),
              ],
            },
          },
        }}
      />,
    );

    const ctRow = screen.getByTestId("cosmetics-row-ct");
    expect(within(ctRow).getByText("★ CT 刀")).toBeTruthy();
    expect(within(ctRow).getByText("★ 双阵营刀")).toBeTruthy();
    expect(within(ctRow).queryByText("T AK")).toBeNull();
    expect(screen.queryByTestId("cosmetics-row-t")).toBeNull();

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    const tRow = screen.getByTestId("cosmetics-row-t");
    expect(within(tRow).getByText("T AK")).toBeTruthy();
    expect(within(tRow).getByText("★ 双阵营刀")).toBeTruthy();
    expect(within(tRow).queryByText("★ CT 刀")).toBeNull();
    expect(screen.queryByTestId("cosmetics-row-ct")).toBeNull();
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

  test("opens item details on click", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ custom_name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" })] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getAllByRole("button", { name: "Lᵒᵛᵉᵧₒᵤ 玫瑰の吻" })[0];
    fireEvent.contextMenu(card, { clientX: 30, clientY: 40 });
    expect(screen.queryByRole("menu")).toBeNull();

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

    const card = screen.getAllByRole("button", { name: /★ M9 刺刀\s+多普勒/ })[0];
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

    expect(screen.getAllByText("★ 正确归属的刀").length).toBeGreaterThan(0);
    expect(screen.queryByText("★ 错误归属的刀")).toBeNull();
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

    expect(screen.getAllByText("探员").length).toBeGreaterThan(0);
    expect(screen.getAllByText("血腥达里尔爵士（沉默）").length).toBeGreaterThan(0);
    expect(screen.getAllByText("音乐盒").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Under Bright Lights").length).toBeGreaterThan(0);
    // Agent + music kit + natural knife/glove placeholders (no default guns).
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBe(4);
  });

  test("custom mode grays non-swappable items and opens picker for weapons", async () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ item_id: 10, type: "weapon", model: "ak47", def_index: 7, observed_teams: ["t"], name_zh: "AK原皮" }),
                cosmetic({ item_id: 11, type: "agent", observed_teams: ["t"], name_zh: "探员甲", paint_wear: undefined, paint_seed: undefined }),
              ],
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    expect(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i })).toBeTruthy();

    const agent = screen.getByRole("button", { name: "探员甲" });
    expect(agent.className).toMatch(/opacity|grayscale|cursor-not-allowed/);
    fireEvent.click(agent);
    expect(screen.queryByPlaceholderText(/搜索皮肤|Search skins/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    expect(screen.getByPlaceholderText(/搜索皮肤|Search skins/i)).toBeTruthy();
  });

  test("cancel discards local replacements; save posts plan with demoId and returns to browse", async () => {
    vi.mocked(saveCustomSkinPlan).mockClear();
    vi.mocked(loadCustomSkinPlan).mockClear();

    const { container } = render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                  paint_wear: 0.1,
                  paint_seed: 1,
                  image_url: "https://cdn.cstrike.app/images/weapon_ak47_4797ec49.webp",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));

    const candidates = screen.getByTestId("skin-candidate-list");
    const first = within(candidates).getAllByRole("button")[0];
    const replacementSrc = within(first).getByRole("img").getAttribute("src");
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    const cardImg = within(screen.getByRole("button", { name: "AK原皮" })).getByRole("img");
    const cardSrc = cardImg.getAttribute("src") || "";
    expect(cardSrc.replace(/_(light|medium|heavy)\.webp/i, ".webp")).toBe(
      String(replacementSrc || "").replace(/_(light|medium|heavy)\.webp/i, ".webp"),
    );
    expect(cardSrc).not.toContain("weapon_ak47_4797ec49");

    fireEvent.click(screen.getByRole("button", { name: /^取消$|^Cancel$/ }));
    expect(screen.getByRole("button", { name: /自定义饰品|Customize skins/i })).toBeTruthy();
    expect(screen.queryByText(/→\s*.+/)).toBeNull();
    expect(
      within(screen.getByRole("button", { name: "AK原皮" })).getByRole("img").getAttribute("src"),
    ).toContain("weapon_ak47_4797ec49");

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    fireEvent.click(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i }));

    await waitFor(() => {
      expect(saveCustomSkinPlan).toHaveBeenCalledWith({
        demoId: 42,
        steamid: STEAM_ID,
        replacements: expect.objectContaining({
          "id:10": expect.objectContaining({ catalog_id: expect.any(Number) }),
        }),
      });
    });
    expect(screen.getByRole("button", { name: /自定义饰品|Customize skins/i })).toBeTruthy();
    expect(screen.getByText(/自定义皮肤方案已保存|Custom skin plan saved/i)).toBeTruthy();
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBeGreaterThan(0);
  });

  test("shows saving loading state while save is in flight", async () => {
    let resolveSave;
    vi.mocked(saveCustomSkinPlan).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    expect(screen.getAllByText(/正在保存自定义饰品方案|Saving custom skin plan/i).length).toBeGreaterThanOrEqual(1);
    const saveButton = screen.getByTestId("cosmetics-save-plan");
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.getAttribute("aria-busy")).toBe("true");

    resolveSave({
      ok: true,
      plan: {
        items: [{
          slot_key: "id:10",
          replacement: {
            catalog_id: 1,
            def_index: 7,
            paint_index: 1,
            paint_wear: 0.1,
            paint_seed: 1,
            name_zh: "AK新皮",
            name_en: "AK New",
            image_url: "",
            type: "weapon",
            model: "ak47",
          },
        }],
      },
      succeeded: [{
        item_id64: "10",
        slot_key: "id:10",
        original_name_zh: "AK原皮",
        original_name_en: "AK Stock",
        replacement_name_zh: "AK新皮",
        replacement_name_en: "AK New",
        name_zh: "AK新皮",
        name_en: "AK New",
      }],
      failed: [],
    });

    await waitFor(() => {
      expect(screen.getByText(/自定义皮肤方案已保存|Custom skin plan saved/i)).toBeTruthy();
    });
    expect(screen.getByTestId("cosmetics-save-result")).toBeTruthy();
  });

  test("shows save result dialog listing succeeded and failed items", async () => {
    vi.mocked(saveCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      partial: true,
      plan: {
        steamid: STEAM_ID,
        items: [{
          slot_key: "id:10",
          replacement: {
            catalog_id: 1,
            def_index: 7,
            paint_index: 1,
            paint_wear: 0.1,
            paint_seed: 1,
            name_zh: "AK新皮",
            name_en: "AK New",
            image_url: "",
            type: "weapon",
            model: "ak47",
          },
        }],
      },
      succeeded: [{
        item_id64: "10",
        slot_key: "id:10",
        original_name_zh: "AK原皮",
        original_name_en: "AK Stock",
        replacement_name_zh: "AK新皮",
        replacement_name_en: "AK New",
        name_zh: "AK新皮",
        name_en: "AK New",
      }],
      failed: [{
        item_id64: "11",
        slot_key: "id:11",
        original_name_zh: "默认刀",
        original_name_en: "Default Knife",
        replacement_name_zh: "刺刀 | 多普勒",
        replacement_name_en: "Bayonet | Doppler",
        name_zh: "刺刀 | 多普勒",
        name_en: "Bayonet | Doppler",
        error: "need a donor knife",
      }],
    });

    render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    await waitFor(() => {
      expect(screen.getByTestId("cosmetics-save-result")).toBeTruthy();
    });
    expect(screen.getByText(/部分饰品已保存|Some skins were saved/i)).toBeTruthy();
    const result = screen.getByTestId("cosmetics-save-result");
    expect(within(result).getByText("AK原皮")).toBeTruthy();
    expect(within(result).getByText("AK新皮")).toBeTruthy();
    expect(within(result).getByText("默认刀")).toBeTruthy();
    expect(within(result).getByText("刺刀 | 多普勒")).toBeTruthy();
    expect(within(result).getByText(/need a donor knife/i)).toBeTruthy();
  });

  test("save result dialog enriches original names from inventory when API omits them", async () => {
    vi.mocked(saveCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      partial: false,
      plan: {
        steamid: STEAM_ID,
        items: [{
          slot_key: "id:10",
          original: { name_zh: "AK原皮", name_en: "AK Stock", item_id: 10 },
          replacement: {
            catalog_id: 1,
            def_index: 7,
            paint_index: 1,
            paint_wear: 0.1,
            paint_seed: 1,
            name_zh: "AK新皮",
            name_en: "AK New",
            image_url: "",
            type: "weapon",
            model: "ak47",
          },
        }],
      },
      // Legacy API shape: only replacement-ish name_zh, no original_name_*.
      succeeded: [{ item_id64: "10", slot_key: "id:10", name_zh: "AK新皮", name_en: "AK New" }],
      failed: [],
    });

    render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                  name_en: "AK Stock",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    await waitFor(() => {
      expect(screen.getByTestId("cosmetics-save-result")).toBeTruthy();
    });
    const result = screen.getByTestId("cosmetics-save-result");
    expect(within(result).getByText("AK原皮")).toBeTruthy();
    expect(within(result).getByText("AK新皮")).toBeTruthy();
  });

  test("seeds local replacements from persisted custom-plan on mount", async () => {
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "id:10",
            replacement: {
              catalog_id: 4797,
              def_index: 7,
              paint_index: 340,
              paint_wear: 0.01,
              paint_seed: 12,
              name_zh: "AK-47 | 红线",
              name_en: "AK-47 | Redline",
              image_url: "https://cdn.example/redline.webp",
            },
          },
        ],
      },
    });

    render(
      <CosmeticsView
        demoId={7}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                }),
              ],
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(loadCustomSkinPlan).toHaveBeenCalledWith({ demoId: 7, steamid: STEAM_ID });
    });

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    await waitFor(() => {
      expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    });
  });

  test("disables save when demoId is missing", async () => {
    vi.mocked(saveCustomSkinPlan).mockClear();
    vi.mocked(loadCustomSkinPlan).mockClear();

    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 10,
                  type: "weapon",
                  model: "ak47",
                  def_index: 7,
                  observed_teams: ["t"],
                  name_zh: "AK原皮",
                }),
              ],
            },
          },
        }}
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: "AK原皮" }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    const saveButton = screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i });
    expect(saveButton.disabled).toBe(true);
    expect(screen.getByText(/无法保存.*Demo|Save unavailable.*demo/i)).toBeTruthy();
    expect(saveCustomSkinPlan).not.toHaveBeenCalled();
  });

  test("clears seeded replacements when demoId changes", async () => {
    const workspace = {
      cosmetics: {
        players: {
          [STEAM_ID]: [
            cosmetic({
              item_id: 10,
              type: "weapon",
              model: "ak47",
              def_index: 7,
              observed_teams: ["t"],
              name_zh: "AK原皮",
            }),
          ],
        },
      },
    };
    const seededPlan = {
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "id:10",
            replacement: {
              catalog_id: 4797,
              def_index: 7,
              paint_index: 340,
              paint_wear: 0.01,
              paint_seed: 12,
              name_zh: "AK-47 | 红线",
              name_en: "AK-47 | Redline",
              image_url: "https://cdn.example/redline.webp",
            },
          },
        ],
      },
    };

    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce(seededPlan);

    const { rerender } = render(
      <CosmeticsView demoId={7} selectedPlayer={{ name: "JW", steamid: STEAM_ID }} workspace={workspace} />,
    );

    await waitFor(() => {
      expect(loadCustomSkinPlan).toHaveBeenCalledWith({ demoId: 7, steamid: STEAM_ID });
    });
    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    await waitFor(() => {
      expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    });

    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({ ok: true, plan: null });
    rerender(
      <CosmeticsView demoId={8} selectedPlayer={{ name: "JW", steamid: STEAM_ID }} workspace={workspace} />,
    );

    await waitFor(() => {
      expect(loadCustomSkinPlan).toHaveBeenCalledWith({ demoId: 8, steamid: STEAM_ID });
    });
    await waitFor(() => {
      expect(screen.queryByText(/→\s*.+/)).toBeNull();
    });
  });

  test("keeps hover notice when a glove finish was not retained", () => {
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
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("entering customize closes an open detail dialog", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ name_zh: "CT 刀", observed_teams: ["ct"] })] } } }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "★ CT 刀" })[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i })).toBeTruthy();
  });

  test("empty inventory still shows default CT/T loadout placeholders", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [] } } }}
        onlineAssetsEnabled
      />,
    );

    expect(screen.getByTestId("cosmetics-row-ct")).toBeTruthy();
    expect(screen.queryByTestId("cosmetics-row-t")).toBeNull();
    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText("★ 匕首")).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText(/手套/)).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-ct")).queryByText(/M4A4|P2000|USP|AK-47/)).toBeNull();

    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-t")).getByText(/手套/)).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-t")).queryByText("AK-47")).toBeNull();
    expect(screen.queryByText(/这个 Demo 没有留下可用的饰品记录|This demo contains no usable cosmetic records/)).toBeNull();
  });

  test("demo evidence overrides matching default placeholders", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ item_id: 1, observed_teams: ["ct"], name_zh: "CT 刀" }),
              ],
            },
          },
        }}
      />,
    );

    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText("★ CT 刀")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cosmetics-team-tab-t"));
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
  });
});
