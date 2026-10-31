import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import PlayerLoadoutEditor, { loadoutCandidates } from "./PlayerLoadoutEditor.jsx";

test("agent choices stay on their own side and music IDs are kit IDs", () => {
  expect(loadoutCandidates("agent_t").length).toBeGreaterThan(10);
  expect(loadoutCandidates("agent_t").every(row => row.teams === 0)).toBe(true);
  expect(loadoutCandidates("agent_ct").every(row => row.teams === 1)).toBe(true);
  expect(loadoutCandidates("music_kit").some(row => row.index === 3)).toBe(true);
  expect(loadoutCandidates("music_kit").some(row => row.index === 104)).toBe(true);
});

test("selects and clears one slot without losing the other choices", () => {
  const onChange = vi.fn();
  render(<PlayerLoadoutEditor value={{ agent_t: 5105, music_kit: 3 }} onChange={onChange} editable locale="zh" onlineAssetsEnabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "CT 探员" }));
  const item = loadoutCandidates("agent_ct")[0];
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: item.nameZh }));
  expect(onChange).toHaveBeenLastCalledWith({ agent_t: 5105, agent_ct: item.def, music_kit: 3 });
  fireEvent.click(screen.getByRole("button", { name: "T 探员" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "沿用 Demo 原设置" }));
  expect(onChange).toHaveBeenLastCalledWith({ music_kit: 3 });
});


test("editing or restoring one music side migrates legacy shared music without changing the other side", () => {
  const onChange = vi.fn();
  const props = { onChange, editable: true, locale: "zh", onlineAssetsEnabled: false };
  const { rerender } = render(<PlayerLoadoutEditor {...props} value={{ music_kit: 3 }} />);
  fireEvent.click(screen.getByRole("button", { name: "CT 音乐盒" }));
  const kit = loadoutCandidates("music_kit_ct").find(row => row.index === 4);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: kit.nameZh }));
  expect(onChange).toHaveBeenLastCalledWith({ music_kit_ct: 4, music_kit_t: 3 });
  rerender(<PlayerLoadoutEditor {...props} value={{ music_kit_ct: 4, music_kit_t: 3 }} />);
  fireEvent.click(screen.getByRole("button", { name: "T 音乐盒" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "沿用 Demo 原设置" }));
  expect(onChange).toHaveBeenLastCalledWith({ music_kit_ct: 4 });
});
