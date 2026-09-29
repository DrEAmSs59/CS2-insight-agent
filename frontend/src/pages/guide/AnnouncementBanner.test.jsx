import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLocaleStore } from "../../i18n/localeStore.js";
import AnnouncementBanner from "./AnnouncementBanner.jsx";

const desktopBridgeMock = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));

vi.mock("../../desktop/desktopBridge.js", () => ({
  desktopBridge: desktopBridgeMock,
}));

function announcement(overrides = {}) {
  return {
    id: "a1",
    level: "info",
    body_zh: "服务器将于今晚维护",
    body_en: "Server maintenance tonight",
    link_url: null,
    ...overrides,
  };
}

let items;
function serve(value) {
  items = value;
}

function setLocale(locale) {
  useLocaleStore.setState({ locale, effectiveLocale: locale, hydrated: true, persistenceError: null });
}

describe("AnnouncementBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    setLocale("zh");
  });

  test("shows server announcements in Chinese", async () => {
    serve([announcement()]);

    render(<AnnouncementBanner items={items} />);

    const body = await screen.findByText("服务器将于今晚维护");
    expect(screen.getByText("公告")).toBeTruthy();
    expect(body.closest("[data-announcement-body]")).toBeTruthy();
    expect(screen.getByText("公告").closest("[data-announcement-body]")).toBeNull();
  });

  test("uses the English body when the interface is English and falls back to Chinese", async () => {
    setLocale("en");
    serve([announcement(), announcement({ id: "a2", body_zh: "仅中文公告", body_en: null })]);

    render(<AnnouncementBanner items={items} />);

    expect(await screen.findByText("Server maintenance tonight")).toBeTruthy();
    expect(screen.getByText("Announcement")).toBeTruthy();
    expect(screen.queryByText("仅中文公告")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next announcement" }));
    expect(screen.getByText("仅中文公告")).toBeTruthy();
    expect(screen.queryByText("服务器将于今晚维护")).toBeNull();
  });

  test("renders markup from the server as plain text", async () => {
    serve([announcement({ body_zh: "<b>粗体</b><img src=x onerror=alert(1)>" })]);

    const { container } = render(<AnnouncementBanner items={items} />);

    expect(await screen.findByText("<b>粗体</b><img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("switches between announcements and has no close button", async () => {
    serve([
      announcement({ id: "a1", body_zh: "第一条" }),
      announcement({ id: "a2", body_zh: "第二条" }),
    ]);

    render(<AnnouncementBanner items={items} />);

    expect(await screen.findByText("第一条")).toBeTruthy();
    expect(screen.queryByText("第二条")).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭公告" })).toBeNull();
    expect(screen.getByRole("button", { name: "上一条" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一条" }));
    expect(screen.getByText("第二条")).toBeTruthy();
    expect(screen.queryByText("第一条")).toBeNull();
    expect(screen.getByText("2 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上一条" }));
    expect(screen.getByText("第一条")).toBeTruthy();
  });

  test("opens the detail link in the system browser", async () => {
    serve([announcement({ link_url: "https://ciacut.cc/notice" })]);

    render(<AnnouncementBanner items={items} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));

    expect(desktopBridgeMock.openExternal).toHaveBeenCalledWith("https://ciacut.cc/notice");
  });

  test("marks warnings with the warning style", async () => {
    serve([announcement({ level: "warning" })]);

    render(<AnnouncementBanner items={items} />);

    const item = (await screen.findByText("服务器将于今晚维护")).closest("[data-announcement-level]");
    expect(item.getAttribute("data-announcement-level")).toBe("warning");
    expect(item.className).toContain("amber");
    expect(screen.getByText("重要")).toBeTruthy();
  });

  test("renders nothing when there are no announcements", () => {
    const empty = render(<AnnouncementBanner />);
    expect(empty.container.innerHTML).toBe("");
  });
});
