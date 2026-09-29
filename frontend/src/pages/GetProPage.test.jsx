import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useLocaleStore } from "../i18n/localeStore.js";
import GetProPage, { safeProductUrl } from "./GetProPage.jsx";

describe("GetProPage", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  test("shows the Pro offer and keeps the download closed until a link is configured", () => {
    render(<GetProPage />);

    expect(screen.getByRole("heading", { name: "获取 Pro 版本" })).toBeTruthy();
    expect(screen.getByText(/6\.99/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "为地图换一种质感" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下载 Pro 安装包" }).disabled).toBe(true);
    expect(screen.getByText("Pro 正在准备中，下载开放后可在此获取")).toBeTruthy();
  });

  test("only accepts an https download link without embedded credentials", () => {
    expect(safeProductUrl("https://example.com/pro.exe")).toBe("https://example.com/pro.exe");
    expect(safeProductUrl("http://example.com/pro.exe")).toBe("");
    expect(safeProductUrl("https://user:pass@example.com/pro.exe")).toBe("");
    expect(safeProductUrl("not a url")).toBe("");
  });
});