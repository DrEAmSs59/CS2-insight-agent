/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import DemoLibraryToolbar from "./DemoLibraryToolbar.jsx";

vi.mock("../../../i18n/useT.js", () => ({
  useT: () => (key, params = {}) => {
    const labels = {
      "library.pageTitle": "Demo 库",
      "library.pageSubtitle": "Demo 库说明",
      "library.btnSelectPage": `选择当前页（${params.count}）`,
      "library.btnSelectAll": `选择全部结果（${params.count}）`,
      "library.batchSelected": `已选择 ${params.count} 个`,
      "library.batchLoad": "载入选中",
      "library.batchDelete": "批量删除",
      "library.batchClear": "清空选择",
    };
    return labels[key] ?? key;
  },
}));

const baseProps = {
  onOpenWatchPaths: vi.fn(),
  onScan: vi.fn(),
  onOpenIngest: vi.fn(),
  onOpenLocalDemo: vi.fn(),
  libraryLoading: false,
  libraryScanning: false,
  pageSelectableCount: 4,
  libraryTotal: 8,
  onSelectPage: vi.fn(),
  onSelectAllLibrary: vi.fn(),
  onViewModeChange: vi.fn(),
};

describe("DemoLibraryToolbar selection context", () => {
  it("shows the normal selection entry points when nothing is selected", () => {
    render(<DemoLibraryToolbar {...baseProps} selectedCount={0} />);

    expect(screen.getByText("选择当前页（4）")).toBeTruthy();
    expect(screen.getByText("选择全部结果（8）")).toBeTruthy();
    expect(screen.queryByTestId("demo-library-selection-bar")).toBeNull();
  });

  it("replaces selection entry points with compact contextual actions", () => {
    const onLoadSelected = vi.fn();
    const onBatchDelete = vi.fn();
    const onClearSelection = vi.fn();
    render(
      <DemoLibraryToolbar
        {...baseProps}
        selectedCount={2}
        onLoadSelected={onLoadSelected}
        onBatchDelete={onBatchDelete}
        onClearSelection={onClearSelection}
      />,
    );

    expect(screen.queryByText("选择当前页（4）")).toBeNull();
    expect(screen.queryByText("选择全部结果（8）")).toBeNull();
    expect(screen.getByText("已选择 2 个")).toBeTruthy();

    fireEvent.click(screen.getByText("载入选中"));
    fireEvent.click(screen.getByText("批量删除"));
    fireEvent.click(screen.getByText("清空选择"));
    expect(onLoadSelected).toHaveBeenCalledTimes(1);
    expect(onBatchDelete).toHaveBeenCalledTimes(1);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
