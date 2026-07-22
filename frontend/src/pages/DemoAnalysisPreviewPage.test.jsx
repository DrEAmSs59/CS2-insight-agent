import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import DemoAnalysisPreviewPage from "./DemoAnalysisPreviewPage";

describe("DemoAnalysisPreviewPage", () => {
  test("gates player details, triggers AI on selection, and keeps the current highlight cards", () => {
    render(<DemoAnalysisPreviewPage />);

    expect(screen.queryByText("分析范围")).toBeNull();
    expect(screen.queryByText("标签")).toBeNull();
    expect(screen.queryByRole("button", { name: "片段卡片" })).toBeNull();
    expect(screen.getByRole("heading", { name: "先选择一名玩家" })).toBeTruthy();
    expect(screen.queryByText("10/10 玩家已分析")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "AI 模式" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 Mako" }));

    expect(screen.getByText("标签")).toBeTruthy();
    expect(screen.getAllByText("双杀")).toHaveLength(2);
    expect(screen.getByText("🔪 手撕大狙")).toBeTruthy();
    expect(screen.getByText("🌫 混烟")).toBeTruthy();
    expect(screen.getByText(/已在选择 Mako 后触发 AI 锐评/)).toBeTruthy();
    expect(screen.queryByText("当前筛选")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览" })).toBeNull();

    const highlightCard = screen.getByText("🔪 手撕大狙").closest('[role="button"]');
    expect(highlightCard).not.toBeNull();
    fireEvent.click(highlightCard);
    fireEvent.click(screen.getByRole("button", { name: "将已选加入队列" }));
    expect(screen.getByText("1 条待录制")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "回合时间线" }));
    expect(screen.getByRole("heading", { name: "Mako · 回合时间线" })).toBeTruthy();
    expect(screen.queryByText("标签")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "枪械击杀" }));
    expect(screen.getByRole("heading", { name: "Mako · 枪械击杀" })).toBeTruthy();
  });

  test("puts the story above a two-sided scoreboard and exposes the 2D replay", () => {
    render(<DemoAnalysisPreviewPage />);

    fireEvent.click(screen.getByRole("button", { name: "概览" }));
    const story = screen.getByRole("heading", { name: "比赛主线" });
    const scoreboard = screen.getByRole("heading", { name: "全场计分板" });
    expect(story.compareDocumentPosition(scoreboard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "分析状态" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "快捷入口" })).toBeNull();
    expect(screen.getByRole("heading", { name: "NOVA" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ORBIT" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "2D 回放" }));
    expect(screen.getByLabelText("R12 雷达回放")).toBeTruthy();
    expect(screen.getByRole("button", { name: "播放回放" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("回放回合"), { target: { value: "6" } });
    expect(screen.getByLabelText("R6 雷达回放")).toBeTruthy();
  });
});
