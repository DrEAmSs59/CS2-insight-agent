import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import CosmeticsView from "./CosmeticsView";
import { loadCustomSkinPlan, saveCustomSkinPlan } from "./saveCustomSkinPlan.js";

const desktopBridgeMock = vi.hoisted(() => ({
  writeClipboardText: vi.fn(async () => {}),
}));

vi.mock("../../../desktop/desktopBridge.js", () => ({
  desktopBridge: desktopBridgeMock,
}));

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
    expect(screen.getAllByText("AWP")).toHaveLength(2);
    expect(screen.getAllByText("九头金蛇")).toHaveLength(2);
    expect(screen.queryByText("“不属于 JW”")).toBeNull();
    expect(screen.getByTestId("cosmetics-row-ct")).toBeTruthy();
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
    expect(screen.getByTestId("cosmetics-row-heading-ct").className).toContain("inline-flex");
    expect(screen.getByTestId("cosmetics-row-heading-ct").className).not.toContain("w-36");
    expect(screen.getByTestId("cosmetics-row-heading-ct").className).toContain("bg-cs2-cyan-surface");
    expect(screen.getByTestId("cosmetics-row-heading-t").className).toContain("bg-cs2-amber-surface");
    expect(screen.getByTestId("cosmetics-row-heading-ct").className).not.toContain("border-l-2");
    expect(screen.getByTestId("cosmetics-row-heading-t").className).not.toContain("border-l-2");
    expect(screen.getByTestId("cosmetics-row-heading-ct").className).not.toContain("bg-sky-500/10");
    expect(screen.getByTestId("cosmetics-row-heading-t").className).not.toContain("bg-amber-500/10");
    expect(screen.getByTestId("cosmetics-row-heading-ct").textContent).toBe("CT");
    expect(screen.getByTestId("cosmetics-row-heading-t").textContent).toBe("T");
    expect(screen.getByTestId("cosmetics-team-stack").className).toContain("space-y-[18px]");
    expect(screen.queryByTestId("cosmetics-team-tab-ct")).toBeNull();
    expect(screen.queryByTestId("cosmetics-team-tab-t")).toBeNull();
    // Both team sections show the evidence knife + AWP + natural glove placeholder.
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBe(6);
    for (const preview of container.querySelectorAll("[data-cosmetic-card] .cosmetic-preview-surface")) {
      expect(preview.className).toContain("rounded-[10px]");
    }
    for (const label of container.querySelectorAll("[data-cosmetic-card-label]")) {
      expect(label.className).not.toContain("min-h-8");
    }
    expect(container.querySelectorAll("[data-cosmetic-card] [data-cosmetic-rarity-rail]")).toHaveLength(6);
    expect(container.querySelectorAll("[data-cosmetic-card] [data-cosmetic-rarity-label]")).toHaveLength(0);
    for (const rail of container.querySelectorAll("[data-cosmetic-card] [data-cosmetic-rarity-rail]")) {
      expect(rail.className).toContain("left-0");
      expect(rail.className).not.toContain("right-0");
      expect(rail.className).toContain("bottom-0");
      expect(rail.className).toContain("h-[3px]");
      expect(rail.className).toContain("w-full");
      expect(rail.className).not.toContain("top-1/2");
      expect(rail.className).not.toContain("-translate-y-1/2");
      expect(rail.className).not.toContain("ring-white");
      expect(rail.className).not.toContain("border-white");
    }
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
    expect(within(ctRow).getByText(/★ CT 刀/)).toBeTruthy();
    expect(within(ctRow).getByText(/★ 双阵营刀/)).toBeTruthy();
    expect(within(ctRow).queryByText(/T AK/)).toBeNull();
    const tRow = screen.getByTestId("cosmetics-row-t");
    expect(within(tRow).getByText(/T AK/)).toBeTruthy();
    expect(within(tRow).getByText(/★ 双阵营刀/)).toBeTruthy();
    expect(within(tRow).queryByText(/★ CT 刀/)).toBeNull();
    expect(screen.getByTestId("cosmetics-row-ct")).toBeTruthy();
  });

  test("editing a shared item in T does not change or submit its CT slot", async () => {
    vi.mocked(saveCustomSkinPlan).mockClear();
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({ ok: true, plan: null });

    render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [cosmetic({ item_id: 10, type: "weapon", model: "deagle", def_index: 1, name_zh: "共享沙鹰" })],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    const ctRow = screen.getByTestId("cosmetics-row-ct");
    const tRow = screen.getByTestId("cosmetics-row-t");
    fireEvent.click(within(tRow).getByRole("button", { name: /共享沙鹰/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    expect(within(tRow).getByText(/→\s*.+/)).toBeTruthy();
    expect(within(ctRow).queryByText(/→\s*.+/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i }));
    await waitFor(() => {
      const request = vi.mocked(saveCustomSkinPlan).mock.calls.at(-1)?.[0];
      expect(request.replacements).toHaveProperty("t:id:10");
      expect(request.replacements).not.toHaveProperty("ct:id:10");
      expect(request.originals["t:id:10"].observed_teams).toEqual(["t"]);
    });
  });

  test("replaces evidence count with customize entry and removes card team dots", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
      />,
    );

    const customizeButton = screen.getByRole("button", { name: /自定义饰品|Customize skins/i });
    expect(customizeButton.className).toContain("rounded-[10px]");
    expect(customizeButton.className).toContain("bg-cs2-accent-soft");
    expect(screen.getByTestId("cosmetics-customize-icon").className.baseVal).toContain("text-cs2-accent");
    expect(screen.queryByText(/2 items|2 件饰品/)).toBeNull();
    for (const card of container.querySelectorAll("[data-cosmetic-card]")) {
      expect(within(card).queryByLabelText(/Equipped-team|装备阵营/)).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    const saveButton = screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i });
    expect(saveButton.className).toContain("rounded-[10px]");
    expect(saveButton.className).toContain("bg-cs2-accent-soft");
    expect(screen.getByTestId("cosmetics-save-plan-icon")).toBeTruthy();
    const cancelButton = screen.getByRole("button", { name: /^取消$|^Cancel$/ });
    expect(cancelButton.className).toContain("rounded-[10px]");
    expect(cancelButton.className).toContain("bg-cs2-bg-input");
    expect(screen.getByTestId("cosmetics-cancel-icon")).toBeTruthy();
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
    expect(dialog.className).toContain("absolute");
    expect(dialog.className).not.toContain("fixed");
    expect(within(dialog).getAllByText("Lᵒᵛᵉᵧₒᵤ 玫瑰の吻").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("53009600926")).toBeTruthy();
    const detailRarity = dialog.querySelector("[data-cosmetic-detail-rarity-label]");
    expect(detailRarity?.textContent).toBeTruthy();
    expect(detailRarity?.style.color).not.toBe("");
    expect(dialog.querySelector("[data-cosmetic-rarity-rail]")).toBeNull();
    expect(within(dialog).queryByText(/Demo 没有提供可归属的贴纸数据|no attributable sticker data/i)).toBeNull();
    expect(dialog.textContent).not.toContain("OriginalOwner");
  });

  test("copies the generated inspect URL through the native desktop clipboard", async () => {
    desktopBridgeMock.writeClipboardText.mockClear();
    desktopBridgeMock.writeClipboardText.mockResolvedValueOnce();
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ catalog_id: 1376, base_catalog_id: 42 })] } } }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /★ M9 刺刀/ })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /复制检视 URL|Copy inspect URL/i }));

    await waitFor(() => expect(desktopBridgeMock.writeClipboardText).toHaveBeenCalledTimes(1));
    expect(desktopBridgeMock.writeClipboardText.mock.calls[0][0]).toMatch(/^steam:\/\/rungame\/730\//);
    const copiedButton = within(dialog).getByRole("button", { name: /检视 URL 已复制|Inspect URL copied/i });
    expect(copiedButton.dataset.copied).toBe("true");
  });

  test("reports a clipboard failure separately from inspect-data generation", async () => {
    desktopBridgeMock.writeClipboardText.mockClear();
    desktopBridgeMock.writeClipboardText.mockRejectedValueOnce(new Error("clipboard denied"));
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ catalog_id: 1376, base_catalog_id: 42 })] } } }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /★ M9 刺刀/ })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /复制检视 URL|Copy inspect URL/i }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/无法写入系统剪贴板|could not be written to the system clipboard/i);
    expect(screen.queryByText(/无法生成该物品的检视数据|Could not generate inspection data/i)).toBeNull();
  });

  test("uses a flat background for the item detail preview", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /★ M9 刺刀/ })[0]);
    const preview = container.querySelector("[data-cosmetic-detail-preview]");
    expect(preview).toBeTruthy();
    expect(preview.className).not.toContain("cosmetic-preview-surface");
  });

  test("shows missing sticker evidence only for guns, not knives or gloves", () => {
    render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic({ type: "weapon", model: "ak47", def_index: 7, name_zh: "AK原皮" })] } } }}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /AK原皮/ })[0]);
    expect(within(screen.getByRole("dialog")).getByText(/Demo 没有提供可归属的贴纸数据|no attributable sticker data/i)).toBeTruthy();
  });

  test("opens the hosted viewer without its light backdrop", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{ cosmetics: { players: { [STEAM_ID]: [cosmetic()] } } }}
        onlineAssetsEnabled
      />,
    );

    const card = screen.getAllByRole("button", { name: /★ M9 刺刀/ })[0];
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

    expect(screen.getAllByText(/★ 正确归属的刀/).length).toBeGreaterThan(0);
    expect(screen.queryByText("★ 错误归属的刀")).toBeNull();
    expect(screen.queryByText("错误归属的刀")).toBeNull();
  });

  test("omits agent, music-kit, and C4 rows", () => {
    const { container } = render(
      <CosmeticsView
        selectedPlayer={{ name: "JW", steamid64: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({ catalog_id: 8666, item_id: undefined, def_index: 4736, paint_index: 0, type: "agent", name_zh: "探员 | 血腥达里尔爵士（沉默）", paint_seed: undefined, paint_wear: undefined }),
                cosmetic({ catalog_id: 12000, item_id: undefined, def_index: 1314, paint_index: 76, type: "musickit", name_zh: "音乐盒 | Under Bright Lights", paint_seed: undefined, paint_wear: undefined }),
                cosmetic({ catalog_id: 49, item_id: undefined, def_index: 49, paint_index: 0, type: "utility", model: "c4", name_zh: "C4 炸弹", paint_seed: undefined, paint_wear: undefined }),
              ],
            },
          },
        }}
      />,
    );

    expect(screen.queryByText("探员")).toBeNull();
    expect(screen.queryByText("血腥达里尔爵士（沉默）")).toBeNull();
    expect(screen.queryByText("音乐盒")).toBeNull();
    expect(screen.queryByText("Under Bright Lights")).toBeNull();
    expect(screen.queryByText("C4 炸弹")).toBeNull();
    // Each team only shows the natural knife/glove placeholders.
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBe(4);
  });

  test("custom mode opens picker for weapons while agents remain hidden", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    expect(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i })).toBeTruthy();

    expect(screen.queryByRole("button", { name: "探员甲" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));

    const candidates = screen.getByTestId("skin-candidate-list");
    const first = within(candidates).getAllByRole("button")[0];
    const replacementSrc = within(first).getByRole("img").getAttribute("src");
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    const cardImg = within(screen.getByRole("button", { name: /AK原皮/ })).getByRole("img");
    const cardSrc = cardImg.getAttribute("src") || "";
    expect(cardSrc.replace(/_(light|medium|heavy)\.webp/i, ".webp")).toBe(
      String(replacementSrc || "").replace(/_(light|medium|heavy)\.webp/i, ".webp"),
    );
    expect(cardSrc).not.toContain("weapon_ak47_4797ec49");

    fireEvent.click(screen.getByRole("button", { name: /^取消$|^Cancel$/ }));
    expect(screen.getByRole("button", { name: /自定义饰品|Customize skins/i })).toBeTruthy();
    expect(screen.queryByText(/→\s*.+/)).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /AK原皮/ })).getByRole("img").getAttribute("src"),
    ).toContain("weapon_ak47_4797ec49");

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    fireEvent.click(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i }));

    await waitFor(() => {
      expect(saveCustomSkinPlan).toHaveBeenCalledWith({
        demoId: 42,
        steamid: STEAM_ID,
        replacements: expect.objectContaining({
          "t:id:10": expect.objectContaining({ catalog_id: expect.any(Number) }),
        }),
        originals: expect.objectContaining({
          "t:id:10": expect.objectContaining({ name_zh: "AK原皮", observed_teams: ["t"] }),
        }),
      });
    });
    expect(screen.getByRole("button", { name: /自定义饰品|Customize skins/i })).toBeTruthy();
    expect(screen.getByText(/自定义皮肤方案已保存|Custom skin plan saved/i)).toBeTruthy();
    expect(container.querySelectorAll("[data-cosmetic-card]").length).toBeGreaterThan(0);
  });

  test("ignores a save result from the previous demo after switching a batch with the same player", async () => {
    let resolveSave;
    vi.mocked(loadCustomSkinPlan).mockResolvedValue({ ok: true, plan: null });
    vi.mocked(saveCustomSkinPlan).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSave = resolve;
    }));
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

    const { rerender } = render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={workspace}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    await waitFor(() => expect(saveCustomSkinPlan).toHaveBeenCalledWith(
      expect.objectContaining({ demoId: 42, steamid: STEAM_ID }),
    ));

    rerender(
      <CosmeticsView
        demoId={43}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={workspace}
      />,
    );
    await waitFor(() => {
      expect(loadCustomSkinPlan).toHaveBeenCalledWith({ demoId: 43, steamid: STEAM_ID });
      expect(screen.queryByText(/→\s*.+/)).toBeNull();
    });

    resolveSave({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [{
          slot_key: "t:id:10",
          replacement: {
            catalog_id: 4797,
            def_index: 7,
            paint_index: 340,
            name_zh: "AK-47 | 迟到的红线",
            name_en: "AK-47 | Late Redline",
          },
        }],
      },
      succeeded: [],
      failed: [],
    });

    await waitFor(() => {
      expect(screen.queryByText(/迟到的红线|Late Redline/)).toBeNull();
      expect(screen.queryByText(/→\s*.+/)).toBeNull();
    });
  });

  test("custom mode shows clear-X on replaced cards and restore posts original on save", async () => {
    vi.mocked(saveCustomSkinPlan).mockClear();
    vi.mocked(loadCustomSkinPlan).mockClear();

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
                  paint_index: 282,
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    const clear = screen.getByTestId("cosmetics-clear-replacement");
    fireEvent.click(clear);
    expect(screen.queryByText(/→\s*.+/)).toBeNull();
    expect(screen.queryByTestId("cosmetics-clear-replacement")).toBeNull();
    expect(
      within(screen.getByRole("button", { name: /AK原皮/ })).getByRole("img").getAttribute("src"),
    ).toContain("weapon_ak47_4797ec49");

    fireEvent.click(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i }));
    await waitFor(() => {
      expect(saveCustomSkinPlan).toHaveBeenCalledWith({
        demoId: 42,
        steamid: STEAM_ID,
        replacements: expect.objectContaining({
          "t:id:10": expect.objectContaining({
            paint_index: 282,
            paint_seed: 1,
            paint_wear: 0.1,
            name_zh: "AK原皮",
          }),
        }),
        originals: expect.objectContaining({
          "t:id:10": expect.objectContaining({ name_zh: "AK原皮", observed_teams: ["t"] }),
        }),
      });
    });
    const posted = vi.mocked(saveCustomSkinPlan).mock.calls.at(-1)?.[0]?.replacements?.["t:id:10"];
    expect(posted).not.toHaveProperty("restore");
  });

  test("second customize confirm keeps demo-original → new label (not new → new)", async () => {
    vi.mocked(saveCustomSkinPlan).mockClear();
    vi.mocked(loadCustomSkinPlan).mockClear();

    // Simulate inventory already rewritten to Wild Lotus after a prior save.
    const wildLotus = {
      catalog_id: 4797,
      def_index: 7,
      paint_index: 403,
      paint_wear: 0.07,
      paint_seed: 661,
      name_zh: "AK-47 | 野荷",
      name_en: "AK-47 | Wild Lotus",
      image_url: "https://cdn.cstrike.app/images/weapon_ak47_wildlotus.webp",
      type: "weapon",
      model: "ak47",
      rarity: "#eb4b4b",
    };
    const demoOriginal = {
      item_id: 10,
      def_index: 7,
      paint_index: 282,
      paint_seed: 1,
      paint_wear: 0.1,
      name_zh: "AK原皮",
      name_en: "AK Stock",
      image_url: "https://cdn.cstrike.app/images/weapon_ak47_4797ec49.webp",
      type: "weapon",
      model: "ak47",
    };

    vi.mocked(loadCustomSkinPlan).mockResolvedValue({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [{
          slot_key: "id:10",
          original: demoOriginal,
          replacement: wildLotus,
        }],
      },
    });
    vi.mocked(saveCustomSkinPlan).mockImplementation(async ({ originals }) => ({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [{
          slot_key: "id:10",
          original: originals?.["id:10"] || wildLotus,
          replacement: wildLotus,
        }],
      },
      succeeded: [{ item_id64: "10", slot_key: "id:10" }],
      failed: [],
    }));

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
                  name_zh: "AK-47 | 野荷",
                  paint_index: 403,
                  paint_wear: 0.07,
                  paint_seed: 661,
                  image_url: "https://cdn.cstrike.app/images/weapon_ak47_wildlotus.webp",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("→ AK-47 | 野荷")).toBeTruthy();
    });
    expect(screen.getByText("AK原皮")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    // Top label must stay demo original; never collapse to 野荷 → 野荷.
    const cardLabel = screen.getByRole("button", { name: /AK原皮/ }).querySelector("[data-cosmetic-card-label]");
    expect(cardLabel?.textContent).toContain("AK原皮");
    expect(cardLabel?.textContent).toMatch(/→/);
    expect(cardLabel?.textContent?.startsWith("AK-47 | 野荷")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i }));
    await waitFor(() => {
      expect(saveCustomSkinPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          originals: expect.objectContaining({
            "t:id:10": expect.objectContaining({ name_zh: "AK原皮", paint_index: 282 }),
          }),
        }),
      );
    });
    expect(screen.getByText("AK原皮")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));

    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    expect(screen.getAllByText(/正在保存自定义饰品方案|Saving custom skin plan/i).length).toBeGreaterThanOrEqual(1);
    const rewriteOverlay = screen.getByTestId("skin-rewrite-overlay");
    expect(rewriteOverlay.className).toContain("fixed");
    expect(rewriteOverlay.className).toContain("inset-0");
    expect(within(rewriteOverlay).getByText(/玩家 JW|Player JW/i)).toBeTruthy();
    expect(within(rewriteOverlay).getByTestId("skin-rewrite-operation").textContent).toMatch(/正在换|Applying/i);
    expect(within(rewriteOverlay).getByTestId("skin-rewrite-arrow")).toBeTruthy();
    expect(within(rewriteOverlay).getByRole("progressbar")).toBeTruthy();
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
    expect(screen.queryByTestId("skin-rewrite-overlay")).toBeNull();
    expect(screen.getByTestId("cosmetics-save-result")).toBeTruthy();
  });

  test("explains when an incomplete demo cannot be safely rewritten", async () => {
    vi.mocked(saveCustomSkinPlan).mockResolvedValueOnce({
      ok: false,
      partial: false,
      plan: null,
      succeeded: [],
      failed: [],
      error_code: "COSMETICS_DEMO_INCOMPLETE_FOR_SKIN_REWRITE",
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
                  name_zh: "AK-47",
                  name_en: "AK-47",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByTestId("cosmetics-customize"));
    fireEvent.click(screen.getByRole("button", { name: /AK-47/ }));
    fireEvent.click(within(screen.getByTestId("skin-candidate-list")).getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: /确认|Confirm/i }));
    fireEvent.click(screen.getByTestId("cosmetics-save-plan"));

    await waitFor(() => {
      expect(screen.getByText(/这个 Demo 文件结尾不完整|This demo is incomplete at the end/i)).toBeTruthy();
    });
    expect(screen.queryByText(/DEM_FileInfo/i)).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
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
    expect(within(result).getByText(/该饰品无法修改|could not be changed/i)).toBeTruthy();
    expect(within(result).queryByText(/need a donor knife/i)).toBeNull();
    fireEvent.click(screen.getByTestId("cosmetics-save-result-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("cosmetics-save-result")).toBeNull();
    });
    // Succeeded overlays must stay visible without remounting / switching players.
    expect(screen.getByText(/→\s*AK新皮|AK新皮/)).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
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

    await waitFor(() => {
      expect(screen.getByText(/→\s*.+/)).toBeTruthy();
    });
  });


  test("card label prefers plan original when inventory already matches replacement", async () => {
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "id:25219118902",
            original: {
              type: "weapon",
              def_index: 60,
              paint_index: 100,
              name_zh: "M4A1消音版 | 二西莫夫",
              name_en: "M4A1-S | Asiimov",
              rarity: "#eb4b4b",
            },
            replacement: {
              type: "weapon",
              def_index: 60,
              paint_index: 984,
              name_zh: "M4A1消音版 | 印花集",
              name_en: "M4A1-S | Printstream",
              rarity: "#eb4b4b",
              image_url: "https://cdn.example/printstream.webp",
            },
          },
        ],
      },
    });

    render(
      <CosmeticsView
        demoId={8}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 25219118902,
                  type: "weapon",
                  model: "m4a1_silencer",
                  def_index: 60,
                  paint_index: 984,
                  observed_teams: ["ct"],
                  name_zh: "M4A1消音版 | 印花集",
                  name_en: "M4A1-S | Printstream",
                }),
              ],
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/二西莫夫/)).toBeTruthy();
    });
    expect(screen.getByText(/→\s*M4A1消音版 \| 印花集/)).toBeTruthy();
  });

  test("keeps default T/CT glove originals after rewritten gloves are re-analyzed", async () => {
    const hedgeMaze = {
      catalog_id: 1718,
      type: "glove",
      def_index: 5030,
      paint_index: 10038,
      paint_seed: 0,
      paint_wear: 0.06,
      name_zh: "运动手套 | 树篱迷宫",
      name_en: "Sport Gloves | Hedge Maze",
      rarity: "#eb4b4b",
    };
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "ct:placeholder:5029",
            original: {
              type: "glove",
              def_index: 5029,
              paint_index: 0,
              is_placeholder: true,
              observed_teams: ["ct"],
              name_zh: "默认反恐精英手套",
              name_en: "Default CT Gloves",
            },
            replacement: hedgeMaze,
          },
          {
            slot_key: "t:placeholder:5028",
            original: {
              type: "glove",
              def_index: 5028,
              paint_index: 0,
              is_placeholder: true,
              observed_teams: ["t"],
              name_zh: "默认T手套",
              name_en: "Default T Gloves",
            },
            replacement: hedgeMaze,
          },
        ],
      },
    });

    render(
      <CosmeticsView
        demoId={10}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  ...hedgeMaze,
                  item_id: 9001,
                  observed_teams: ["ct"],
                  custom_name: "CS2 INSIGHT AGENT",
                }),
                cosmetic({
                  ...hedgeMaze,
                  item_id: 9002,
                  observed_teams: ["t"],
                  custom_name: "CS2 INSIGHT AGENT",
                }),
              ],
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      const ctRow = screen.getByTestId("cosmetics-row-ct");
      const tRow = screen.getByTestId("cosmetics-row-t");
      expect(within(ctRow).getByText("默认反恐精英手套")).toBeTruthy();
      expect(within(ctRow).getByText(/→\s*运动手套 \| 树篱迷宫/)).toBeTruthy();
      expect(within(tRow).getByText("默认T手套")).toBeTruthy();
      expect(within(tRow).getByText(/→\s*运动手套 \| 树篱迷宫/)).toBeTruthy();
      expect(screen.queryByText(/CS2 INSIGHT AGENT/)).toBeNull();
    });
  });

  test("keeps zero-id Deagle and owned glove originals after synthetic IDs are re-analyzed", async () => {
    const hypnotic = {
      catalog_id: 69,
      type: "weapon",
      model: "deagle",
      def_index: 1,
      paint_index: 61,
      paint_seed: 0,
      paint_wear: 0,
      name_zh: "沙漠之鹰 | 蛊惑之色",
      name_en: "Desert Eagle | Hypnotic",
      rarity: "#d32ce6",
    };
    const arid = {
      catalog_id: 1716,
      type: "glove",
      model: "sporty_gloves",
      def_index: 5030,
      paint_index: 10019,
      paint_seed: 0,
      paint_wear: 0.06,
      name_zh: "运动手套 | 干旱",
      name_en: "Sport Gloves | Arid",
      rarity: "#eb4b4b",
    };
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "ct:def:1:0:0:0",
            original: {
              catalog_id: 0,
              type: "weapon",
              model: "deagle",
              def_index: 1,
              paint_index: 0,
              paint_seed: 0,
              paint_wear: 0,
              observed_teams: ["ct"],
              name_zh: "沙漠之鹰",
              name_en: "Desert Eagle",
            },
            replacement: hypnotic,
          },
          {
            slot_key: "ct:id:53188157085",
            original: {
              catalog_id: 1710,
              item_id: 53188157085,
              type: "glove",
              model: "studded_brokenfang_gloves",
              def_index: 4725,
              paint_index: 10088,
              paint_seed: 36,
              paint_wear: 0.142666,
              observed_teams: ["ct"],
              name_zh: "狂牙手套 | 精神错乱",
              name_en: "Broken Fang Gloves | Unhinged",
            },
            replacement: arid,
          },
        ],
      },
    });

    render(
      <CosmeticsView
        demoId={11}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        locale="en"
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                // The original owned glove remains as provenance but is no
                // longer visible on either side after materialization.
                cosmetic({
                  catalog_id: 1710,
                  item_id: 53188157085,
                  type: "glove",
                  model: "studded_brokenfang_gloves",
                  def_index: 4725,
                  paint_index: 10088,
                  observed_teams: [],
                  name_en: "Broken Fang Gloves | Unhinged",
                }),
                cosmetic({
                  ...hypnotic,
                  item_id: 9101,
                  observed_teams: ["ct"],
                  custom_name: "CS2 INSIGHT AGENT",
                }),
                cosmetic({
                  ...arid,
                  item_id: 9102,
                  observed_teams: ["ct"],
                  custom_name: "CS2 INSIGHT AGENT",
                }),
              ],
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      const ctRow = screen.getByTestId("cosmetics-row-ct");
      expect(within(ctRow).getByText("Desert Eagle")).toBeTruthy();
      expect(within(ctRow).getByText(/Hypnotic/)).toBeTruthy();
      expect(within(ctRow).getByText(/Broken Fang Gloves/)).toBeTruthy();
      expect(within(ctRow).getByText(/Sport Gloves \| Arid/)).toBeTruthy();
      expect(screen.queryByText(/CS2 INSIGHT AGENT/)).toBeNull();
    });
  });

  test("hover shows replaced knife instead of unfinished original", async () => {
    vi.mocked(loadCustomSkinPlan).mockResolvedValueOnce({
      ok: true,
      plan: {
        steamid: STEAM_ID,
        items: [
          {
            slot_key: "id:47420920830",
            original: {
              type: "melee",
              def_index: 512,
              paint_index: 0,
              name_zh: "系绳匕首",
              name_en: "Paracord Knife",
              finish_known: false,
            },
            replacement: {
              type: "melee",
              def_index: 508,
              paint_index: 568,
              paint_seed: 12,
              name_zh: "M9 刺刀 | 伽玛多普勒",
              name_en: "M9 Bayonet | Gamma Doppler",
              alt_name: "Emerald",
              rarity: "#eb4b4b",
              finish_known: true,
              image_url: "https://cdn.example/m9.webp",
            },
          },
        ],
      },
    });

    render(
      <CosmeticsView
        demoId={9}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: 47420920830,
                  type: "melee",
                  def_index: 512,
                  paint_index: 0,
                  paint_seed: undefined,
                  paint_wear: undefined,
                  observed_teams: ["ct"],
                  name_zh: "系绳匕首",
                  name_en: "Paracord Knife",
                  finish_known: false,
                  custom_name: "Ave",
                }),
              ],
            },
          },
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/→\s*★ M9 刺刀/)).toBeTruthy();
    });

    fireEvent.pointerEnter(screen.getByRole("button", { name: /Ave|系绳匕首/ }));
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText(/M9 刺刀/)).toBeTruthy();
    expect(within(tooltip).queryByText(/系绳匕首/)).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    fireEvent.click(screen.getByRole("button", { name: /AK原皮/ }));
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

    fireEvent.click(screen.getAllByRole("button", { name: /★ CT 刀/ })[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /保存自定义皮肤方案|Save custom skin plan/i })).toBeTruthy();
  });

  test("custom mode opens picker for vanilla evidence gun", async () => {
    render(
      <CosmeticsView
        demoId={42}
        selectedPlayer={{ name: "JW", steamid: STEAM_ID }}
        workspace={{
          cosmetics: {
            players: {
              [STEAM_ID]: [
                cosmetic({
                  item_id: undefined,
                  type: "weapon",
                  model: "m4a1",
                  def_index: 16,
                  paint_index: 0,
                  paint_seed: 0,
                  paint_wear: 0,
                  observed_teams: ["ct"],
                  name_zh: "M4A4",
                  ownership_evidence: "default_weapon_no_econ_id",
                }),
              ],
            },
          },
        }}
        onlineAssetsEnabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /自定义饰品|Customize skins/i }));
    const m4 = screen.getByRole("button", { name: /M4A4/ });
    expect(m4.className).not.toMatch(/opacity-50|grayscale|cursor-not-allowed/);
    fireEvent.click(m4);
    expect(screen.getByPlaceholderText(/搜索皮肤|Search skins/i)).toBeTruthy();
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
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText("★ 匕首")).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText(/手套/)).toBeTruthy();
    expect(within(screen.getByTestId("cosmetics-row-ct")).queryByText(/M4A4|P2000|USP|AK-47/)).toBeNull();

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

    expect(within(screen.getByTestId("cosmetics-row-ct")).getByText(/★ CT 刀/)).toBeTruthy();
    expect(screen.getByTestId("cosmetics-row-t")).toBeTruthy();
  });
});
