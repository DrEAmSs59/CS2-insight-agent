import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useLocaleStore } from "../../i18n/localeStore.js";
import CosmeticsWorkshopPage from "./CosmeticsWorkshopPage.jsx";

describe("CosmeticsWorkshopPage", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  const renderPage = () => render(
    <MemoryRouter initialEntries={["/cosmetics-workshop"]}>
      <CosmeticsWorkshopPage />
    </MemoryRouter>,
  );

  test("uses vanilla items as the catalogue entry instead of exposing skins immediately", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "饰品工坊" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "原皮目录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^蝴蝶刀$/ })).toBeTruthy();
    expect(screen.queryByText("多普勒")).toBeNull();
    expect(screen.queryByRole("heading", { name: "饰品检视" })).toBeNull();
  });

  test("opens a model skin list and only then launches on-demand inspect", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /^蝴蝶刀$/ }));
    expect(screen.getByRole("heading", { name: "蝴蝶刀 · 全部皮肤" })).toBeTruthy();

    const list = screen.getByTestId("workshop-skin-list");
    expect(within(list).getAllByRole("button", { name: "3D 检视" }).length).toBeGreaterThan(0);
    fireEvent.click(within(list).getAllByRole("button", { name: "3D 检视" })[0]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "饰品检视" })).toBeTruthy());
    expect(screen.getByTitle("饰品检视")).toBeTruthy();
  });

  test("maintains one CT/T plan and can delete then recreate it", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));
    expect(screen.getByRole("heading", { name: "饰品方案" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CT · 28" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "T · 26" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新增方案" }).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "删除方案" }));
    expect(screen.getByText("还没有饰品方案")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "新增方案" })[0].disabled).toBe(false);

    fireEvent.click(screen.getAllByRole("button", { name: "新增方案" })[0]);
    expect(screen.getByRole("button", { name: "CT · 28" })).toBeTruthy();
    expect(screen.getByText("CT / T 全部使用原皮")).toBeTruthy();
  });

  test("edits a T weapon slot through the same skin selection flow", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /饰品方案/ }));
    fireEvent.click(screen.getByRole("button", { name: "T · 26" }));
    fireEvent.click(screen.getByRole("button", { name: /^AK-47$/ }));

    expect(screen.getByRole("heading", { name: "AK-47 · 全部皮肤" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("搜索皮肤、相位或英文名…"), { target: { value: "野荷" } });
    const candidate = await screen.findByRole("button", { name: /AK-47.*野荷/ });
    fireEvent.click(candidate);
    fireEvent.click(screen.getByRole("button", { name: "应用到方案" }));

    await waitFor(() => expect(screen.getByText("野荷")).toBeTruthy());
  });
});
