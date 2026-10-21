import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { RoundCompilationPlansContext } from "../../recording/useRoundCompilationPlans";
import { useLocaleStore } from "../../i18n/localeStore";
import RoundCompilationPlan from "./RoundCompilationPlan";
import QueueWorkspaceRow from "./QueueWorkspaceRow";

const item = { id: "round", targetPlayer: "one", clipData: { category: "compilation", compilation_kind: "freeze_to_death", source_ticks: [[1, 99999]] } };
const draw = (state) => render(<RoundCompilationPlansContext.Provider value={{ round: state }}>
  <RoundCompilationPlan item={item} />
  <QueueWorkspaceRow item={item} globalPacing={{}} onRemove={() => {}} onSelect={() => {}} />
</RoundCompilationPlansContext.Provider>);
beforeEach(() => useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true }));

test("round rows and details show the backend duration and segments", () => {
  draw({ status: "ready", plan: { estimated_duration_sec: 105, tick_rate: 64, active_segments: [
    { segment_index: 0, round: 1, start_tick: 6208, end_tick: 12928 },
  ], disabled_segments: [] } });
  expect(screen.getByText("实际录制 1 段，预计 105.0 秒")).toBeTruthy();
  expect(screen.getByText("~105.0s")).toBeTruthy();
  expect(screen.getByText("Tick 6208–12928")).toBeTruthy();
});

test("a failed plan has a retry action and never displays a guessed duration", () => {
  const retry = vi.fn();
  draw({ status: "error", errorKey: "ftd.planFailed", retry });
  fireEvent.click(screen.getByRole("button", { name: "重新计算" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/~\d/)).toBeNull();
});
