import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextEncoder } from "node:util";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import PlayerAliasesSection from "./PlayerAliasesSection.jsx";
vi.mock("../api/api.js", () => ({ default: { post: vi.fn() } }));
globalThis.TextEncoder ||= TextEncoder;
const demos = [{ key: "demo", path: "sample.dem", label: "sample.dem" }];
function Harness() {
  const [value, setValue] = useState({ enabled: false, drafts: {} });
  const [ready, setReady] = useState(false);
  return <><PlayerAliasesSection demos={demos} value={value} onChange={setValue} onReadyChange={setReady} /><output>{JSON.stringify({ value, ready })}</output></>;
}
describe("PlayerAliasesSection", () => {
  beforeEach(() => { useLocaleStore.getState().hydrate("zh"); API.post.mockReset(); });
  it("loads ten players on demand and preserves focus while editing", async () => {
    API.post.mockResolvedValue({ data: { players: Array.from({ length: 10 }, (_, i) => ({ steamid64: `7656119903200622${i}`, name: `Player ${i}`, team_number: i < 5 ? 2 : 3 })) } });
    render(<Harness />);
    expect(API.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "启用改名" }));
    await waitFor(() => expect(screen.getAllByRole("textbox")).toHaveLength(10));
    const input = screen.getByRole("textbox", { name: "Player 0 的自定义昵称" });
    input.focus();
    fireEvent.change(input, { target: { value: "京介 🦋" } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("京介 🦋");
    expect(API.post).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "x".repeat(33) } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "全部还原" }));
    expect(input).toHaveValue("");
  });
  it("shows roster errors and allows retry", async () => {
    API.post.mockRejectedValueOnce(new Error("broken demo"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用改名" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("broken demo");
    API.post.mockResolvedValueOnce({ data: { players: [{ steamid64: "76561199032006224", name: "donk", team_number: 2 }] } });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("textbox");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
