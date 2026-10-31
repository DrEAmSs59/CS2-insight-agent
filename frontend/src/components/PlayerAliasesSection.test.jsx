/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TextEncoder } from "node:util";
import API from "../api/api.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import PlayerAliasesSection from "./PlayerAliasesSection.jsx";
vi.mock("../api/api.js", () => ({ default: { post: vi.fn() } }));
globalThis.TextEncoder ||= TextEncoder;
const demos = [{ key: "demo", path: "sample.dem", label: "sample.dem" }];
function Harness({ layout = "card", targets = demos }) {
  const [value, setValue] = useState({ enabled: false, drafts: {} });
  const [ready, setReady] = useState(false);
  return <><PlayerAliasesSection layout={layout} demos={targets} value={value} onChange={setValue} onReadyChange={setReady} /><output>{JSON.stringify({ value, ready })}</output></>;
}
describe.each(["card", "rows"])("PlayerAliasesSection (%s)", layout => {
  beforeEach(() => { useLocaleStore.getState().hydrate("zh"); API.post.mockReset(); });
  it("loads ten players on demand and preserves focus while editing", async () => {
    API.post.mockResolvedValue({ data: { players: Array.from({ length: 10 }, (_, i) => ({ steamid64: `7656119903200622${i}`, name: `Player ${i}`, team_number: i < 5 ? 2 : 3 })) } });
    render(<Harness layout={layout} />);
    expect(API.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole(layout === "rows" ? "switch" : "checkbox", { name: "启用改名" }));
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
    render(<Harness layout={layout} />);
    fireEvent.click(screen.getByRole(layout === "rows" ? "switch" : "checkbox", { name: "启用改名" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("broken demo");
    API.post.mockResolvedValueOnce({ data: { players: [{ steamid64: "76561199032006224", name: "donk", team_number: 2 }] } });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("textbox");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("shows the recording-only hint and groups named teams by their original roster after a side switch", async () => {
  useLocaleStore.getState().hydrate("zh");
  API.post.mockResolvedValue({ data: { players: [
    { steamid64: "1", name: "ZywOo", team_number: 3 },
    { steamid64: "2", name: "b1t", team_number: 2 },
  ] } });
  render(<Harness layout="rows" targets={[{ ...demos[0], teamNames: { 2: "Vitality", 3: "NAVI" }, playerTeams: { 1: 2, 2: 3 } }]} />);
  expect(screen.getByText("仅对本次录制时生效")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "启用改名" }));
  const vitality = await screen.findByRole("group", { name: "Vitality" });
  const navi = screen.getByRole("group", { name: "NAVI" });
  expect(within(vitality).getByRole("textbox", { name: "ZywOo 的自定义昵称" })).toBeTruthy();
  expect(within(vitality).queryByRole("textbox", { name: "b1t 的自定义昵称" })).toBeNull();
  expect(within(navi).getByRole("textbox", { name: "b1t 的自定义昵称" })).toBeTruthy();
  expect(screen.queryByText(/按双方名单逐人修改/)).toBeNull();
  expect(screen.getByRole("button", { name: "全部还原" })).toBeTruthy();
});

it("switches demos in one selector and preserves each demo's nickname draft", async () => {
  useLocaleStore.getState().hydrate("zh");
  API.post.mockReset().mockImplementation(async (_url, body) => ({ data: { players: [
    { steamid64: "1", name: body.path === "a.dem" ? "Alpha" : "Bravo", team_number: 2 },
  ] } }));
  const targets = ["a", "b"].map(key => ({ key, path: `${key}.dem`, label: `${key}.dem` }));
  render(<Harness layout="rows" targets={targets} />);
  fireEvent.click(screen.getByRole("switch", { name: "启用改名" }));
  const alpha = await screen.findByRole("textbox", { name: "Alpha 的自定义昵称" });
  fireEvent.change(alpha, { target: { value: "片段一" } });
  const selector = screen.getByRole("radiogroup", { name: "选择 Demo" });
  fireEvent.click(within(selector).getByRole("radio", { name: "b.dem" }));
  expect(screen.queryByRole("textbox", { name: "Alpha 的自定义昵称" })).toBeNull();
  const bravo = screen.getByRole("textbox", { name: "Bravo 的自定义昵称" });
  expect(bravo).toHaveValue("");
  fireEvent.change(bravo, { target: { value: "片段二" } });
  fireEvent.click(within(selector).getByRole("radio", { name: "a.dem" }));
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Alpha 的自定义昵称" })).toHaveValue("片段一");
  expect(JSON.parse(screen.getByRole("status").textContent).value.drafts).toEqual({ a: { 1: "片段一" }, b: { 1: "片段二" } });
  expect(API.post).toHaveBeenCalledTimes(2);
});

it("uses one dropdown when there are more than four demos", async () => {
  useLocaleStore.getState().hydrate("zh");
  API.post.mockReset().mockImplementation(async (_url, body) => ({ data: { players: [
    { steamid64: "1", name: body.path, team_number: 2 },
  ] } }));
  const targets = Array.from({ length: 5 }, (_, index) => ({ key: String(index), path: `${index}.dem`, label: `${index}.dem` }));
  render(<Harness layout="rows" targets={targets} />);
  fireEvent.click(screen.getByRole("switch", { name: "启用改名" }));
  const selector = await screen.findByRole("combobox", { name: "选择 Demo" });
  expect(selector).toHaveValue("0");
  fireEvent.change(selector, { target: { value: "4" } });
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "4.dem 的自定义昵称" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "0.dem 的自定义昵称" })).toBeNull();
});
