import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import ReplayBombMarker from "./ReplayBombMarker";

beforeEach(() => useLocaleStore.setState({ effectiveLocale: "zh" }));

test("dropped has no pulse rings", () => {
  render(<ReplayBombMarker status="dropped" site="" />);
  expect(screen.getByTitle(/掉落/)).toBeTruthy();
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(0);
});

test("planted renders two pulse rings", () => {
  render(<ReplayBombMarker status="planted" site="A" />);
  expect(screen.getByTitle(/放置|安放|下包/)).toBeTruthy();
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(2);
});

test("defused and exploded have no pulse rings", () => {
  const { unmount } = render(<ReplayBombMarker status="defused" site="A" />);
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(0);
  unmount();
  render(<ReplayBombMarker status="exploded" site="A" />);
  expect(document.querySelectorAll(".planted-c4-ring")).toHaveLength(0);
});
