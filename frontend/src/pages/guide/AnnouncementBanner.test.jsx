import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import API from "../../api/api";
import { useLocaleStore } from "../../i18n/localeStore.js";
import AnnouncementBanner, { DISMISSED_ANNOUNCEMENTS_KEY } from "./AnnouncementBanner.jsx";

const desktopBridgeMock = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));

vi.mock("../../api/api", () => ({
  default: { get: vi.fn() },
}));

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

function serve(items) {
  API.get.mockResolvedValue({ data: { edition: "free", announcements: items } });
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

    render(<AnnouncementBanner />);

    expect(await screen.findByText("服务器将于今晚维护")).toBeTruthy();
    expect(API.get).toHaveBeenCalledWith("/app/announcements");
  });

  test("uses the English body when the interface is English and falls back to Chinese", async () => {
    setLocale("en");
    serve([announcement(), announcement({ id: "a2", body_zh: "仅中文公告", body_en: null })]);

    render(<AnnouncementBanner />);

    expect(await screen.findByText("Server maintenance tonight")).toBeTruthy();
    expect(screen.getByText("仅中文公告")).toBeTruthy();
    expect(screen.queryByText("服务器将于今晚维护")).toBeNull();
  });

  test("renders markup from the server as plain text", async () => {
    serve([announcement({ body_zh: "<b>粗体</b><img src=x onerror=alert(1)>" })]);

    const { container } = render(<AnnouncementBanner />);

    expect(await screen.findByText("<b>粗体</b><img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("hides a dismissed announcement on later visits but shows new ones", async () => {
    serve([announcement()]);
    const first = render(<AnnouncementBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "关闭公告" }));
    expect(screen.queryByText("服务器将于今晚维护")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY))).toEqual(["a1"]);
    first.unmount();

    serve([announcement(), announcement({ id: "a2", body_zh: "新的公告" })]);
    render(<AnnouncementBanner />);

    expect(await screen.findByText("新的公告")).toBeTruthy();
    expect(screen.queryByText("服务器将于今晚维护")).toBeNull();
  });

  test("opens the detail link in the system browser", async () => {
    serve([announcement({ link_url: "https://ciacut.cc/notice" })]);

    render(<AnnouncementBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));

    expect(desktopBridgeMock.openExternal).toHaveBeenCalledWith("https://ciacut.cc/notice");
  });

  test("marks warnings with the warning style", async () => {
    serve([announcement({ level: "warning" })]);

    render(<AnnouncementBanner />);

    const item = (await screen.findByText("服务器将于今晚维护")).closest("[data-announcement-level]");
    expect(item.getAttribute("data-announcement-level")).toBe("warning");
    expect(item.className).toContain("amber");
  });

  test("renders nothing when there are no announcements or the request fails", async () => {
    serve([]);
    const empty = render(<AnnouncementBanner />);
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(1));
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();

    API.get.mockRejectedValue(new Error("offline"));
    const failed = render(<AnnouncementBanner />);
    await waitFor(() => expect(API.get).toHaveBeenCalledTimes(2));
    expect(failed.container.innerHTML).toBe("");
  });
});
