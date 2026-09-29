import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLocaleStore } from "../i18n/localeStore.js";
import GetProPage from "./GetProPage.jsx";

const openExternal = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../desktop/desktopBridge", () => ({
  desktopBridge: { openExternal },
}));

describe("GetProPage", () => {
  beforeEach(() => {
    openExternal.mockClear();
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  test("shows the price, WeChat, site, and QQ groups without a download", () => {
    render(<GetProPage />);

    expect(screen.getByRole("heading", { name: "获取 Pro 版本" })).toBeTruthy();
    expect(screen.getByText(/6\.99/)).toBeTruthy();
    expect(screen.getByText("若之前有捐赠，请添加微信，截图捐赠记录，会获得对应捐赠金额的 Pro 期限。")).toBeTruthy();
    expect(screen.getByText("一台电脑、一个激活码、一个邮箱互相绑定。")).toBeTruthy();
    const wechat = screen.getByTestId("developer-wechat-id");
    expect(wechat.textContent).toBe("CS2INAIGHTAGENT");
    expect(wechat.closest(".pro-selectable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://ciacut.cc/" }).getAttribute("href")).toBe("https://ciacut.cc/");
    const qq = screen.getByText("1078028719");
    expect(qq.closest(".pro-selectable")).toBeTruthy();
    expect(screen.getByText("1042360781").closest(".pro-selectable")).toBeTruthy();
    expect(screen.getByText("更多地图材质/滤镜，搭配场景与镜头风格。")).toBeTruthy();
    expect(screen.getByText("闪电暴雨、漫天飞雪等效果，为关键时刻增加氛围。")).toBeTruthy();
    expect(screen.getByText("饰品更名、自定义贴纸与挂件，让高级饰品点缀你的高光。")).toBeTruthy();
    expect(screen.getByText("具体功能以 Pro 版本发布后为准。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "为地图换一种质感" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "免费版，依然完整保留。" })).toBeTruthy();
    expect(screen.getByText("免费版继续免费下载、免费使用。Pro 使用独立安装包，两版可以同时安装，并共用数据。")).toBeTruthy();
    expect(screen.queryByText(/互相替换/)).toBeNull();
    expect(screen.getByRole("heading", { name: "三步开始 Pro" })).toBeTruthy();
    expect(screen.queryByText("FREE EDITION")).toBeNull();
    expect(screen.queryByRole("button", { name: "下载 Pro 安装包" })).toBeNull();
    expect(screen.queryByText(/从还原比赛/)).toBeNull();
  });

  test("opens the official site from the release link", () => {
    render(<GetProPage />);
    fireEvent.click(screen.getByRole("link", { name: "https://ciacut.cc/" }));
    expect(openExternal).toHaveBeenCalledWith("https://ciacut.cc/");
  });
});