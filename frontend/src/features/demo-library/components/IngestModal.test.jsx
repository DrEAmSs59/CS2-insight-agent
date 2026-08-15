import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import API from "../../../api/api";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import IngestModal from "./IngestModal.jsx";

vi.mock("../../../api/api", () => ({
  default: { get: vi.fn() },
}));

function demo(id, filename = `demo-${id}.dem`) {
  return {
    id,
    path: `C:/Demos/${filename}`,
    filename,
    file_size: 1024,
    source: "Faceit",
    added_at: "2026-07-27T00:00:00Z",
  };
}

describe("IngestModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocaleStore.getState().hydrate("zh");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces search and prevents an older response from replacing newer results", async () => {
    vi.useFakeTimers();
    let resolveInitial;
    const initialRequest = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    API.get
      .mockReturnValueOnce(initialRequest)
      .mockResolvedValueOnce({ data: { items: [demo(2, "target.dem")], total: 1 } });

    render(<IngestModal isOpen onClose={vi.fn()} onIngest={vi.fn()} />);
    expect(API.get).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText("搜索文件名..."), {
      target: { value: "target" },
    });
    act(() => vi.advanceTimersByTime(249));
    expect(API.get).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(1));
    expect(API.get).toHaveBeenCalledTimes(2);
    expect(API.get.mock.calls[1][1].params.q).toBe("target");
    expect(screen.getByText("target.dem")).toBeTruthy();

    await act(async () => {
      resolveInitial({ data: { items: [demo(1, "stale.dem")], total: 1 } });
    });
    expect(screen.queryByText("stale.dem")).toBeNull();
    expect(screen.getByText("target.dem")).toBeTruthy();
  });

  test("keeps selections while paging and toggles only the visible page", async () => {
    API.get.mockImplementation((_url, { params }) => Promise.resolve({
      data: params.offset === 0
        ? { items: [demo(1), demo(2)], total: 11 }
        : { items: [demo(11)], total: 11 },
    }));

    render(<IngestModal isOpen onClose={vi.fn()} onIngest={vi.fn()} />);
    await screen.findByText("demo-1.dem");
    fireEvent.click(screen.getByRole("button", { name: "选择本页 2 个" }));
    expect(screen.getByText("已选择 2 个")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText("demo-11.dem");
    fireEvent.click(screen.getByRole("button", { name: "选择本页 1 个" }));
    expect(screen.getByText("已选择 3 个")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消本页 1 个" }));
    expect(screen.getByText("已选择 2 个")).toBeTruthy();
  });

  test("keeps failed demos selected and open after a partial batch ingest", async () => {
    API.get
      .mockResolvedValueOnce({ data: { items: [demo(1), demo(2)], total: 2 } })
      .mockResolvedValueOnce({ data: { items: [demo(2)], total: 1 } });
    const onClose = vi.fn();
    const onIngest = vi.fn().mockResolvedValue({
      ingested: 1,
      failed: [{ demo_id: 2, filename: "demo-2.dem", error: "文件不存在" }],
    });

    render(<IngestModal isOpen onClose={onClose} onIngest={onIngest} />);
    await screen.findByText("demo-1.dem");
    fireEvent.click(screen.getByRole("button", { name: "选择本页 2 个" }));
    fireEvent.click(screen.getByRole("button", { name: "确认入库 (2)" }));

    await waitFor(() => expect(onIngest).toHaveBeenCalledWith([1, 2]));
    expect(await screen.findByText(/已入库 1 个，失败 1 个/)).toBeTruthy();
    expect(screen.getByText("已选择 1 个")).toBeTruthy();
    expect(screen.getByText("demo-2.dem")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
