/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { useLocaleStore } from "../../i18n/localeStore.js";
import ObsHostField from "./ObsHostField.jsx";

function Harness() {
  const [value, setValue] = useState("localhost");
  return <ObsHostField value={value} onChange={setValue} />;
}

describe("ObsHostField", () => {
  beforeEach(() => {
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  it("requires an explicit unlock before the OBS host can be edited", () => {
    render(<Harness />);

    const input = screen.getByLabelText("OBS 主机");
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("localhost");
    expect(screen.getByText(/OBS WebSocket 运行在另一台电脑/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "解锁 OBS 主机修改" }));
    expect(input.readOnly).toBe(false);

    fireEvent.change(input, { target: { value: "192.168.1.20" } });
    expect(input.value).toBe("192.168.1.20");

    fireEvent.click(screen.getByRole("button", { name: "锁定 OBS 主机" }));
    expect(input.readOnly).toBe(true);
  });
});
