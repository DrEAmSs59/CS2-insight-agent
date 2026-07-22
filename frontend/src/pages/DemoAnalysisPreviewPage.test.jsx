import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppShellProvider } from "../context/AppShellContext";
import DemoAnalysisPreviewPage from "./DemoAnalysisPreviewPage";
import API from "../api/api";

vi.mock("../api/api", () => ({
  default: {
    post: vi.fn().mockResolvedValue({
      data: {
        frames: [
          { tick: 200, time_sec: 0, players: [{ name: "ZywOo", team: "CT", x: 500, y: 500, yaw: 90, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 600, time_sec: 6.25, players: [{ name: "ZywOo", team: "CT", x: 502, y: 502, yaw: 80, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 700, time_sec: 7.8, players: [{ name: "ZywOo", team: "CT", x: 504, y: 504, yaw: 70, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 800, time_sec: 9.4, players: [{ name: "ZywOo", team: "CT", x: 506, y: 506, yaw: 60, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 860, time_sec: 10.3, players: [{ name: "ZywOo", team: "CT", x: 507, y: 507, yaw: 55, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 900, time_sec: 10.9, players: [{ name: "ZywOo", team: "CT", x: 508, y: 508, yaw: 50, health: 100, weapon: "ak47", is_alive: true, has_defuser: true }] },
          { tick: 1000, time_sec: 12.5, players: [{ name: "ZywOo", team: "CT", x: 512, y: 512, yaw: 45, health: 0, weapon: "16777215", is_alive: false, has_defuser: false }], shots: [{ tick: 1000, actor: "ZywOo", weapon: "ak47", x: 512, y: 512, yaw: 45, pitch: 0 }] },
        ],
      },
    }),
  },
}));

function buildShell(overrides = {}) {
  const players = [
    { name: "ZywOo", team: 2, team_name: "Vitality", kills: 23, deaths: 12, assists: 2, kd: 1.917, steam_id64: "1" },
    { name: "flameZ", team: 2, team_name: "Vitality", kills: 16, deaths: 16, assists: 4, kd: 1, steam_id64: "2" },
    { name: "b1t", team: 3, team_name: "NAVI", kills: 18, deaths: 16, assists: 3, kd: 1.125, steam_id64: "3" },
    { name: "iM", team: 3, team_name: "NAVI", kills: 14, deaths: 18, assists: 5, kd: 0.778, steam_id64: "4" },
  ];
  const stats = players.map((player, index) => ({
    ...player,
    team_key: index < 2 ? "a" : "b",
    kd: player.kills / player.deaths,
    adr: 96 - index * 8,
    kast: 82 - index * 5,
    hs_percent: 58 - index * 3,
    first_kills: 5 - index,
    first_deaths: index,
    trade_kills: 4 - Math.min(index, 3),
    trade_deaths: index,
    trade_kill_rate: 40,
    kpr: player.kills / 2,
    dpr: player.deaths / 2,
    survival_rate: 50,
    two_kill_rounds: 2,
    three_kill_rounds: 1,
    four_kill_rounds: 0,
    five_kill_rounds: 0,
    awp_kills: index === 0 ? 3 : 0,
    utility_damage: 90 - index * 10,
    utility_damage_per_round: 8,
    average_equipment_value: 4300,
    rating: 1.2 - index * 0.1,
  }));
  const analysisWorkspace = {
    version: 1,
    map_name: "de_mirage",
    tick_rate: 64,
    map_transform: { pos_x: 0, pos_y: 1024, scale: 1 },
    team_a_name: "Vitality",
    team_b_name: "NAVI",
    team_a_score: 13,
    team_b_score: 9,
    players: stats,
    rounds: [
      {
        round_number: 1,
        start_tick: 100,
        freeze_end_tick: 200,
        end_tick: 4200,
        duration_seconds: 62,
        winner_team_key: "a",
        team_a_score_after: 1,
        team_b_score_after: 0,
        team_a_side: "CT",
        team_b_side: "T",
        team_a_economy: "pistol",
        team_b_economy: "pistol",
        team_a_equipment_value: 4000,
        team_b_equipment_value: 4000,
        headline: "ZywOo 双杀守住 B 区",
        site: "B",
        tags: ["首杀", "2K"],
        bomb_initial_carrier: "ZywOo",
        shots: [{ tick: 1000, actor: "ZywOo", weapon: "ak47", x: 512, y: 512, yaw: 45, pitch: 0 }],
        events: [
          { type: "bomb_pickup", tick: 150, time_text: "00:00", actor: "ZywOo", x: 500, y: 500 },
          { type: "grenade", tick: 600, throw_tick: 520, time_text: "00:06", actor: "ZywOo", kind: "HE 手雷", x: 500, y: 500, trajectory: [{ tick: 520, x: 480, y: 480 }, { tick: 560, x: 490, y: 490 }, { tick: 600, x: 500, y: 500 }] },
          { type: "grenade", tick: 700, time_text: "00:07", actor: "ZywOo", kind: "燃烧弹", x: 504, y: 504 },
          { type: "grenade", tick: 800, time_text: "00:08", actor: "ZywOo", kind: "闪光弹", x: 508, y: 508 },
          { type: "grenade", tick: 900, throw_tick: 820, time_text: "00:10", actor: "ZywOo", kind: "烟雾弹", x: 512, y: 512, trajectory: [{ tick: 820, x: 490, y: 490 }, { tick: 860, x: 500, y: 500 }, { tick: 900, x: 512, y: 512 }] },
          { type: "plant", tick: 950, time_text: "00:11", actor: "ZywOo", site: "B", x: 516, y: 516 },
          { type: "kill", tick: 1000, time_text: "00:12", actor: "ZywOo", target: "b1t", weapon: "ak47", headshot: true },
          { type: "explode", tick: 1100, time_text: "00:14", actor: "ZywOo" },
          { type: "explode", tick: 1200, time_text: "00:16", actor: "ZywOo" },
          { type: "kill", tick: 4300, time_text: "01:04", actor: "b1t", target: "ZywOo", weapon: "glock" },
        ],
      },
      {
        round_number: 2,
        start_tick: 4300,
        freeze_end_tick: 4500,
        end_tick: 8000,
        duration_seconds: 55,
        winner_team_key: "b",
        team_a_score_after: 1,
        team_b_score_after: 1,
        team_a_side: "CT",
        team_b_side: "T",
        team_a_economy: "full",
        team_b_economy: "force",
        team_a_equipment_value: 21500,
        team_b_equipment_value: 14200,
        headline: "NAVI 强起翻盘",
        tags: ["翻盘"],
        events: [],
      },
    ],
    summary: { mvp_player: "ZywOo", total_rounds: 2 },
  };
  return {
    aiMode: false,
    hasDemos: true,
    uploadedDemos: [
      { id: 7, filename: "1. ZywOo 23/12/2", path: "C:/demos/one.dem", players, match_meta: { map_name: "de_mirage", team_a_score: 13, team_b_score: 9, total_rounds: 22 } },
      { id: 12, filename: "6. 9208350252586674188_0.dem", path: "C:/demos/two.dem", players, match_meta: { map_name: "de_nuke", team_a_score: 11, team_b_score: 13, total_rounds: 24 } },
    ],
    matchTabsData: [
      { filename: "1. ZywOo 23/12/2", demo_filename: "one.dem", match_meta: { map_name: "de_mirage" }, parsed: true },
      { filename: "6. 9208350252586674188_0.dem", demo_filename: "two.dem", match_meta: { map_name: "de_nuke" }, parsed: true },
    ],
    currentMatchIndex: 0,
    setCurrentMatchIndex: vi.fn(),
    currentFilename: "1. ZywOo 23/12/2",
    players,
    matchMeta: { map_name: "de_mirage", team_a_name: "Vitality", team_b_name: "NAVI", team_a_score: 13, team_b_score: 9, total_rounds: 22 },
    currentParsed: null,
    analysisWorkspace,
    selectedPlayersList: players.map((player) => player.name),
    setSelectedPlayers: vi.fn(),
    handleParse: vi.fn().mockResolvedValue(undefined),
    parsing: false,
    parsingByIndex: {},
    anyDemoParsing: false,
    progressText: "",
    batchRecording: false,
    analysisInlineProgress: null,
    parsedPlayerNames: [],
    clips: [],
    roundTimeline: [],
    selectedClientClipUids: new Set(),
    queuedClientClipUidsForCurrentDemo: new Set(),
    currentActivePlayer: "",
    setActivePlayerTabs: vi.fn(),
    ensurePlayerAiReview: vi.fn().mockResolvedValue(true),
    aiReviewingPlayers: {},
    roundMontageMaxRounds: 24,
    freezeToDeathDraft: { picked: [] },
    setFreezeToDeathDraft: vi.fn(),
    handleToggleClip: vi.fn(),
    handleDequeueClip: vi.fn(),
    handleAddTimelineEventToQueue: vi.fn(),
    handleAddTimelineRoundToQueue: vi.fn(),
    handleAddTimelineEventsBatchToQueue: vi.fn(),
    handleRemoveTimelineEventFromQueue: vi.fn(),
    handleRemoveTimelineRoundFromQueue: vi.fn(),
    handleAddWeaponKillsToQueue: vi.fn(),
    selectedRegularCount: 0,
    regularSelectableTotal: 0,
    handleSelectAll: vi.fn(),
    handleDeselectAll: vi.fn(),
    handleAddSelectedToQueue: vi.fn(),
    handleAddCurrentPlayerHighlights: vi.fn(),
    canAddCurrentPlayerHighlights: false,
    queue: [],
    handleUpload: vi.fn(),
    handleResetDemo: vi.fn(),
    ...overrides,
  };
}

function renderPage(shell) {
  return render(
    <MemoryRouter>
      <AppShellProvider value={shell}><DemoAnalysisPreviewPage /></AppShellProvider>
    </MemoryRouter>,
  );
}

describe("DemoAnalysisPreviewPage Insight Agent flow", () => {
  beforeEach(() => vi.clearAllMocks());

  test("the selector only contains demos uploaded or selected for this session", () => {
    const shell = buildShell();
    renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "切换 Demo" }));
    const listbox = screen.getByRole("listbox", { name: "本次载入的 Demo" });
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(within(listbox).getByText("one.dem")).toBeTruthy();
    expect(within(listbox).getByText("two.dem")).toBeTruthy();
    expect(screen.getByText("本次载入的 Demo · 2")).toBeTruthy();

    fireEvent.click(options[1]);
    expect(shell.setCurrentMatchIndex).toHaveBeenCalledWith(1);
  });

  test("keeps batch parsing inside the upload box until every demo is ready", () => {
    const shell = buildShell({
      parsingByIndex: { 0: true },
      anyDemoParsing: true,
      analysisInlineProgress: { active: true, text: "正在自动解析每个 Demo 的全部玩家（1/2）…" },
      matchTabsData: [
        { filename: "one.dem", parsed: true },
        { filename: "two.dem", parsed: true },
      ],
    });
    renderPage(shell);

    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在自动解析每个 Demo 的全部玩家（1/2）…")).toBeTruthy();
    expect(screen.queryByText("PREVIEW")).toBeNull();
    expect(screen.queryByRole("button", { name: "2D 回放" })).toBeNull();
    expect(screen.queryByText("13")).toBeNull();
    expect(screen.queryByText(/DAK|analysis-kit|数据包/i)).toBeNull();
  });

  test("removes the preview label and resets the loaded demo set from the header", () => {
    const shell = buildShell();
    renderPage(shell);

    expect(screen.queryByText("PREVIEW")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重置 Demo" }));
    expect(shell.handleResetDemo).toHaveBeenCalledTimes(1);
  });

  test("renders real roster and match summary from the original parser state", () => {
    renderPage(buildShell());
    fireEvent.click(screen.getByRole("button", { name: "概览" }));

    expect(screen.getByRole("heading", { name: "Vitality" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "NAVI" })).toBeTruthy();
    expect(screen.getByText("23", { selector: "td" })).toBeTruthy();
    const mainlineHeading = screen.getByRole("heading", { name: "比赛主线" });
    expect(mainlineHeading).toBeTruthy();
    expect(mainlineHeading.closest("section")?.querySelector("svg")).toBeNull();
    expect(mainlineHeading.closest("section")?.querySelector("article")).toBeNull();
    expect(screen.queryByText(/Vitality 的.*半场奠定比赛走势/)).toBeNull();
    expect(screen.getByRole("heading", { name: "全场计分板" })).toBeTruthy();
    expect(screen.getByText("详细战报")).toBeTruthy();
    expect(screen.queryByText(/DAK|analysis-kit|数据包/i)).toBeNull();
  });

  test("keeps all six prototype workspaces backed by parsed match data", async () => {
    const view = renderPage(buildShell());

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    expect(screen.getByRole("slider", { name: "回放时间轴" })).toBeTruthy();
    expect(screen.getByAltText("de_mirage 雷达地图")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("8 Hz", { exact: false })).toBeTruthy());
    expect(API.post).toHaveBeenCalledWith("/demo/replay", expect.objectContaining({ start_tick: 100, end_tick: 4299, fps: 8 }));
    expect(screen.queryByText(/^nan$/i)).toBeNull();
    expect(screen.queryByText("16777215")).toBeNull();
    expect(screen.getAllByText("C4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("KIT").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 HE 手雷" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 HE 手雷" }));
    await waitFor(() => expect(screen.getByTitle("ZywOo HE 手雷")).toBeTruthy());
    expect(view.container.querySelector(".demo-explosion-effect")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "回放时间轴" }), { target: { value: "2" } });
    await waitFor(() => expect(view.container.querySelector(".demo-explosion-effect")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 燃烧弹" }));
    await waitFor(() => expect(screen.getByTitle(/ZywOo 燃烧弹 · 剩余/)).toBeTruthy());
    expect(view.container.querySelector(".demo-fire-effect")).toBeTruthy();
    expect(view.container.querySelector(".demo-fire-effect")?.parentElement?.className).toContain("h-[50px]");
    expect(view.container.querySelector(".demo-fire-effect svg")).toBeTruthy();
    expect(view.container.querySelector(".demo-fire-effect")?.textContent).not.toContain("火");
    expect(view.container.querySelector(".demo-duration-ring")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 闪光弹" }));
    await waitFor(() => expect(screen.getByTitle("ZywOo 闪光弹")).toBeTruthy());
    expect(view.container.querySelector(".demo-flash-effect")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 烟雾弹" }));
    await waitFor(() => expect(screen.getByTitle(/ZywOo 烟雾弹 · 剩余/)).toBeTruthy());
    expect(screen.getByTitle(/ZywOo 烟雾弹 · 剩余/).className).toContain("h-[54px]");
    expect(view.container.querySelector('.demo-grenade-trajectory[data-side="CT"]')?.getAttribute("stroke")).toBe("#38bdf8");
    fireEvent.change(screen.getByRole("slider", { name: "回放时间轴" }), { target: { value: "4" } });
    await waitFor(() => expect(view.container.querySelector('.demo-grenade-trajectory[data-side="CT"]')).toBeTruthy());
    expect(view.container.querySelector(".demo-grenade-projectile")?.parentElement?.className).toContain("transition-[left,top]");
    expect(view.container.querySelector(".demo-grenade-projectile")?.parentElement?.getAttribute("data-side")).toBe("CT");
    expect(view.container.querySelector(".demo-grenade-projectile")?.getAttribute("style")).toContain("border-color: rgb(56, 189, 248)");
    expect(view.container.querySelector("style")?.textContent).not.toContain("demo-projectile-pulse");
    const killMarker = screen.getByRole("button", { name: "定位事件：ZywOo 使用 ak47 击杀 b1t（爆头）" });
    fireEvent.click(killMarker);
    await waitFor(() => expect(screen.getByRole("slider", { name: "回放时间轴" })).toHaveProperty("value", "6"));
    expect(screen.getByTitle(/ZywOo 烟雾弹 · 剩余/)).toBeTruthy();
    expect(screen.getByTitle(/ZywOo 燃烧弹 · 剩余/)).toBeTruthy();
    expect(screen.getByTitle("C4 已放置 · B 区")).toBeTruthy();
    expect(screen.getByTitle("C4 已放置 · B 区").querySelector("svg")).toBeNull();
    expect(screen.getByTitle("C4 已放置 · B 区").className).toContain("z-[5]");
    const killFeed = view.container.querySelector('[aria-live="polite"]');
    expect(within(killFeed).getByText("ZywOo").getAttribute("data-side")).toBe("CT");
    expect(within(killFeed).getByText("ZywOo").className).toContain("text-sky-300");
    expect(within(killFeed).getByText("b1t").getAttribute("data-side")).toBe("T");
    expect(within(killFeed).getByText("b1t").className).toContain("text-amber-300");
    expect(view.container.querySelector(".demo-player-direction-arrow")).toBeTruthy();
    expect(view.container.querySelector(".demo-shot-tracer")).toBeTruthy();
    expect(screen.getAllByText("b1t", { selector: "span" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "回合" }));
    expect(screen.getByRole("heading", { name: "回合列表" })).toBeTruthy();
    expect(screen.getByText("ZywOo 双杀守住 B 区")).toBeTruthy();
    expect(screen.getByText("全枪全弹")).toBeTruthy();
    expect(screen.getAllByText("CT 胜").length).toBeGreaterThan(0);
    expect(screen.queryByText("2K")).toBeNull();
    expect(screen.queryByText(/生效/)).toBeNull();
    expect(screen.getAllByText("C4 爆炸")).toHaveLength(1);
    const roundPanel = screen.getByRole("heading", { name: /第 1 回合/ }).closest("section");
    expect(roundPanel?.querySelector('img[src$="/ak47.svg"]')).toBeTruthy();
    expect(roundPanel?.querySelector('img[src$="/headshot.svg"]')).toBeTruthy();
    const killRow = roundPanel?.querySelector('img[src$="/ak47.svg"]')?.closest(".whitespace-nowrap")?.parentElement?.parentElement;
    expect(killRow?.textContent).toContain("ZywOo");
    expect(killRow?.textContent).toContain("b1t");
    expect(within(roundPanel).queryByText(/使用 ak47/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "玩家" }));
    expect(screen.getByText("详细数据")).toBeTruthy();
    expect(screen.getByRole("button", { name: /生成 AI 点评/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "经济" }));
    expect(screen.getByRole("heading", { name: "经济走势" })).toBeTruthy();
    expect(screen.getAllByText("R1").length).toBeGreaterThan(0);
    expect(screen.queryByText("平均装备差")).toBeNull();
    expect(screen.queryByText("双方最低装备总值")).toBeNull();
  });

  test("keeps every player unselected until the user chooses one, then requests only that player's AI review", () => {
    const shell = buildShell({
      aiMode: true,
      currentParsed: { players: { ZywOo: { clips: [{ clip_id: "clip-1", category: "highlight" }], match_meta: {} } } },
      parsedPlayerNames: ["ZywOo"],
    });
    renderPage(shell);

    expect(screen.getByText("先选择一名玩家")).toBeTruthy();
    expect(screen.queryByText(/AI 锐评/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择 ZywOo" }));
    expect(shell.ensurePlayerAiReview).toHaveBeenCalledTimes(1);
    expect(shell.ensurePlayerAiReview).toHaveBeenCalledWith("ZywOo", 0);
  });

  test("uses replay-frame shots when an older cached workspace has no shots field", async () => {
    const shell = buildShell();
    shell.analysisWorkspace = {
      ...shell.analysisWorkspace,
      rounds: shell.analysisWorkspace.rounds.map((round, index) => (
        index === 0 ? { ...round, shots: [] } : round
      )),
    };
    const view = renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 使用 ak47 击杀 b1t（爆头）" }));
    await waitFor(() => expect(view.container.querySelector(".demo-shot-tracer")).toBeTruthy());
  });

  test("draws an inferred smoke trail for older cached workspaces without trajectories", async () => {
    const shell = buildShell();
    shell.analysisWorkspace = {
      ...shell.analysisWorkspace,
      rounds: shell.analysisWorkspace.rounds.map((round, index) => index === 0 ? {
        ...round,
        events: round.events.map((event) => event.kind === "烟雾弹" ? { ...event, throw_tick: undefined, trajectory: [] } : event),
      } : round),
    };
    const view = renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 烟雾弹" }));
    await waitFor(() => expect(view.container.querySelector('.demo-grenade-trajectory[data-inferred="true"]')).toBeTruthy());
  });

  test("merges duplicate smoke records into one rendered trajectory", async () => {
    const shell = buildShell();
    shell.analysisWorkspace = {
      ...shell.analysisWorkspace,
      rounds: shell.analysisWorkspace.rounds.map((round, index) => index === 0 ? {
        ...round,
        events: [
          ...round.events,
          {
            type: "grenade",
            tick: 905,
            throw_tick: 824,
            time_text: "00:10",
            actor: "ZywOo",
            kind: "烟雾弹",
            x: 513,
            y: 512,
            trajectory: [{ tick: 824, x: 491, y: 490 }, { tick: 864, x: 501, y: 500 }, { tick: 905, x: 513, y: 512 }],
          },
        ],
      } : round),
    };
    const view = renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: /定位事件：ZywOo 投掷 烟雾弹/ })[0]);
    await waitFor(() => expect(view.container.querySelectorAll(".demo-grenade-trajectory")).toHaveLength(1));
  });

  test("rejects stale smoke paths whose long stationary tail belongs to another landing", async () => {
    const shell = buildShell();
    shell.analysisWorkspace = {
      ...shell.analysisWorkspace,
      rounds: shell.analysisWorkspace.rounds.map((round, index) => index === 0 ? {
        ...round,
        events: round.events.map((event) => event.kind === "烟雾弹" ? {
          ...event,
          throw_tick: 100,
          trajectory: [
            { tick: 100, x: 100, y: 100 },
            { tick: 200, x: 200, y: 200 },
            { tick: 899, x: -900, y: -900 },
          ],
        } : event),
      } : round),
    };
    const view = renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "定位事件：ZywOo 投掷 烟雾弹" }));
    await waitFor(() => expect(view.container.querySelector('.demo-grenade-trajectory[data-inferred="true"]')).toBeTruthy());
    expect(view.container.querySelectorAll(".demo-grenade-trajectory")).toHaveLength(1);
  });

  test("reconstructs round scores for cached workspaces that stored every round as zero", async () => {
    const shell = buildShell();
    shell.analysisWorkspace = {
      ...shell.analysisWorkspace,
      rounds: shell.analysisWorkspace.rounds.map((round, index) => ({
        ...round,
        winner_team_key: null,
        winner_side: index === 0 ? 3 : 2,
        team_a_score_before: 0,
        team_b_score_before: 0,
        team_a_score_after: 0,
        team_b_score_after: 0,
      })),
    };
    renderPage(shell);

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    await waitFor(() => expect(API.post).toHaveBeenCalled());
    const roundSelect = screen.getByRole("combobox");
    expect(within(roundSelect).getByRole("option", { name: "回合 R1 · 1 : 0" })).toBeTruthy();
    expect(within(roundSelect).getByRole("option", { name: "回合 R2 · 1 : 1" })).toBeTruthy();
  });

  test("shows the AI insight banner only inside the clip-card view", () => {
    const clips = [];
    renderPage(buildShell({
      aiMode: true,
      currentActivePlayer: "ZywOo",
      currentParsed: { players: { ZywOo: { clips, ai_reviewed: true, match_meta: {} } } },
      parsedPlayerNames: ["ZywOo"],
      clips,
    }));

    expect(screen.getByText("已按设置中的 AI 洞察模式，为 ZywOo 生成锐评。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "回合时间线" }));
    expect(screen.queryByText("已按设置中的 AI 洞察模式，为 ZywOo 生成锐评。")).toBeNull();
  });

  test("shows the upload entry when no demo set has been loaded", () => {
    renderPage(buildShell({ hasDemos: false, uploadedDemos: [], matchTabsData: [], players: [], selectedPlayersList: [] }));
    expect(screen.getByText("上传单个或多个 Demo，或从 Demo 库勾选本次要分析的文件。")).toBeTruthy();
    expect(screen.getByText("前往 Demo 库")).toBeTruthy();
  });
});
