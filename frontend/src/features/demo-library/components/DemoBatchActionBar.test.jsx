import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useLocaleStore } from "../../../i18n/localeStore.js";
import DemoBatchActionBar from "./DemoBatchActionBar";

describe("DemoBatchActionBar", () => {
  beforeEach(() => {
    useLocaleStore.setState({
      locale: "zh",
      effectiveLocale: "zh",
      hydrated: true,
      persistenceError: null,
    });
  });

  test("keeps the automatic full-roster load action without the obsolete load-and-parse choice", () => {
    const onLoadSelected = vi.fn();
    render(
      <DemoBatchActionBar
        count={2}
        onLoadSelected={onLoadSelected}
        onBatchDelete={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );

    expect(screen.queryByText("载入并解析…")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByText("载入选中"));
    expect(onLoadSelected).toHaveBeenCalledTimes(1);
  });
});
