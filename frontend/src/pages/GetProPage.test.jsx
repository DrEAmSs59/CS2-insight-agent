import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLocaleStore } from "../i18n/localeStore.js";
import GetProPage from "./GetProPage.jsx";

const openExternal = vi.hoisted(() => vi.fn(async () => {}));
const writeClipboardText = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../desktop/desktopBridge", () => ({
  desktopBridge: { openExternal, writeClipboardText },
}));

describe("GetProPage", () => {
  beforeEach(() => {
    openExternal.mockClear();
    writeClipboardText.mockClear();
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  test("shows the offer, support channels, and self-service purchase steps", () => {
    render(<GetProPage />);

    expect(screen.getByRole("heading", { name: "获取 Pro 版本" })).toBeTruthy();
    expect(screen.getByText(/6\.99/)).toBeTruthy();
    expect(screen.queryByText(/若之前有捐赠/)).toBeNull();
    const binding = screen.getByText("一台电脑、一个激活码、一个邮箱互相绑定。");
    const priceCard = binding.closest("aside");
    const support = within(priceCard).getByText("若有疑问，请加 QQ 群。");
    expect(binding.nextElementSibling).toBe(support);
    expect(screen.queryByText("请加微信号")).toBeNull();
    expect(screen.queryByText("CS2INAIGHTAGENT")).toBeNull();
    expect(within(priceCard).getByRole("button", { name: "复制 QQ 群号 1078028719" })).toBeTruthy();
    expect(within(priceCard).getByRole("button", { name: "复制 QQ 群号 1042360781" })).toBeTruthy();
    expect(screen.getByText("更多地图材质/滤镜，搭配场景与镜头风格。")).toBeTruthy();
    expect(screen.getByText("闪电暴雨、漫天飞雪等效果，为关键时刻增加氛围。")).toBeTruthy();
    expect(screen.getByText("饰品更名、自定义贴纸与挂件，让高级饰品点缀你的高光。")).toBeTruthy();
    expect(screen.queryByText("具体功能以 Pro 版本发布后为准。")).toBeNull();
    expect(screen.getByRole("heading", { name: "为地图换一种质感" })).toBeTruthy();
    const features = screen.getByRole("region", { name: "Pro 功能与免费版说明" });
    const camera = within(features).getByRole("heading", { name: "一键自动运镜" }).closest("article");
    const cameraDetail = within(camera).getByText("从此高光运镜再无门槛");
    const releaseNote = within(camera).getByText("2026年11月底发布自动运镜");
    expect(cameraDetail.nextElementSibling).toBe(releaseNote);
    const free = within(features).getByRole("heading", { name: "免费版，依然完整保留。" }).closest("article");
    expect(camera.nextElementSibling).toBe(free);
    expect(features.lastElementChild).toBe(free);
    expect(screen.getByText("免费版继续免费下载、免费使用。Pro 使用独立安装包，两版可以同时安装，并共用数据。")).toBeTruthy();
    expect(screen.queryByText(/互相替换/)).toBeNull();
    const steps = screen.getByRole("heading", { name: "三步开始 Pro" }).closest("article");
    expect(priceCard.nextElementSibling).toBe(steps);
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1进入 ciacut.cc 官网，使用支付宝或微信自助付款",
      "2下载 Pro 版本客户端",
      "3领取激活码，绑定当前电脑。一台电脑、一个激活码、一个邮箱互相绑定。",
    ]);
    expect(screen.queryByText("FREE EDITION")).toBeNull();
    expect(screen.queryByRole("button", { name: "下载 Pro 安装包" })).toBeNull();
    expect(screen.queryByText(/从还原比赛/)).toBeNull();
  });

  test.each(["1078028719", "1042360781"])("copies QQ group %s through the desktop clipboard", async (number) => {
    render(<GetProPage />);
    fireEvent.click(screen.getByRole("button", { name: `复制 QQ 群号 ${number}` }));

    expect(writeClipboardText).toHaveBeenCalledWith(number);
    expect(await screen.findByText(`已复制群号 ${number}`)).toBeTruthy();
  });

  test("reports a failed clipboard write and lets the user retry", async () => {
    writeClipboardText.mockRejectedValueOnce(new Error("clipboard is busy"));
    render(<GetProPage />);
    const button = screen.getByRole("button", { name: "复制 QQ 群号 1078028719" });

    fireEvent.click(button);
    expect(await screen.findByText("复制群号失败，请重试。")).toBeTruthy();

    fireEvent.click(button);
    expect(await screen.findByText("已复制群号 1078028719")).toBeTruthy();
  });

  test("opens the official site from the purchase steps", () => {
    render(<GetProPage />);
    const link = screen.getByRole("link", { name: "ciacut.cc" });
    expect(link.getAttribute("href")).toBe("https://ciacut.cc/");
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://ciacut.cc/");
  });
});
