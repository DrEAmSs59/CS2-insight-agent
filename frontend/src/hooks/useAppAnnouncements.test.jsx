import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import API from "../api/api";
import { useAppAnnouncements } from "./useAppAnnouncements.js";
import AnnouncementBanner from "../pages/guide/AnnouncementBanner.jsx";

vi.mock("../api/api", () => ({ default: { get: vi.fn() } }));

const items = [{ id: "startup", level: "info", body_zh: "启动公告" }];
const response = { data: { announcements: items } };

describe("app announcement startup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    API.get.mockReset();
    API.get.mockResolvedValue(response);
  });
  afterEach(() => vi.useRealTimers());

  test("waits for backend readiness, then loads without a page remount", async () => {
    const { result, rerender } = renderHook(({ ready }) => useAppAnnouncements(ready), {
      initialProps: { ready: false },
    });
    expect(API.get).not.toHaveBeenCalled();
    await act(async () => rerender({ ready: true }));
    expect(result.current).toEqual(items);
    expect(API.get).toHaveBeenCalledWith("/app/announcements", {
      signal: expect.any(AbortSignal), timeout: 5000,
    });
    rerender({ ready: true });
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  test("loads before the guide opens and retains announcements across navigation", async () => {
    let resolve;
    API.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    function Shell({ guide }) {
      const notices = useAppAnnouncements(true);
      return guide ? <AnnouncementBanner items={notices} /> : <div>Demo library</div>;
    }
    const view = render(<Shell guide={false} />);
    expect(API.get).toHaveBeenCalledTimes(1);
    await act(async () => resolve(response));
    view.rerender(<Shell guide />);
    expect(screen.getByText("启动公告")).toBeTruthy();
    view.rerender(<Shell guide={false} />);
    view.rerender(<Shell guide />);
    expect(screen.getByText("启动公告")).toBeTruthy();
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  test.each([new Error("Network Error"), { response: { status: 503 } }])(
    "recovers from a temporary failure while staying on the same page",
    async (error) => {
      API.get.mockRejectedValueOnce(error);
      const { result } = renderHook(() => useAppAnnouncements(true));
      await act(async () => {});
      expect(result.current).toEqual([]);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(result.current).toEqual(items);
      expect(API.get).toHaveBeenCalledTimes(2);
    },
  );

  test("stops retrying after three retries", async () => {
    API.get.mockRejectedValue(new Error("offline"));
    renderHook(() => useAppAnnouncements(true));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(API.get).toHaveBeenCalledTimes(4);
  });

  test.each([{ announcements: [] }, {}])("does not poll successful empty responses", async (data) => {
    API.get.mockResolvedValue({ data });
    const { result } = renderHook(() => useAppAnnouncements(true));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(result.current).toEqual([]);
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  test("cancels pending retries on unmount", async () => {
    API.get.mockRejectedValue(new Error("offline"));
    const { unmount } = renderHook(() => useAppAnnouncements(true));
    await act(async () => {});
    const { signal } = API.get.mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  test("ignores an older request after readiness changes", async () => {
    let finishOld;
    API.get.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    const { result, rerender } = renderHook(({ ready }) => useAppAnnouncements(ready), {
      initialProps: { ready: true },
    });
    rerender({ ready: false });
    await act(async () => rerender({ ready: true }));
    await act(async () => finishOld({ data: { announcements: [] } }));
    expect(result.current).toEqual(items);
  });
});
