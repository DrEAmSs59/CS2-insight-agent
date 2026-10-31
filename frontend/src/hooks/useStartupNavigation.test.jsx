import { StrictMode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { saveShowGuideOnStartup } from "../utils/startupPreferences.js";
import { useStartupNavigation } from "./useStartupNavigation.js";

function Shell() {
  useStartupNavigation();
  const { pathname } = useLocation();
  return <><output data-testid="path">{pathname}</output><Link to="/">Guide</Link></>;
}

function launch(path = "/") {
  return render(<StrictMode><MemoryRouter initialEntries={[path]}><Shell /></MemoryRouter></StrictMode>);
}

describe("startup guide navigation", () => {
  beforeEach(() => localStorage.clear());

  it.each([undefined, true])("opens the guide when the preference is %s", (preference) => {
    if (preference !== undefined) saveShowGuideOnStartup(preference);
    launch();
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("opens the library when disabled and still allows opening the guide manually", () => {
    saveShowGuideOnStartup(false);
    launch();
    expect(screen.getByTestId("path").textContent).toBe("/library");
    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("preserves a direct link to a different page", () => {
    saveShowGuideOnStartup(false);
    launch("/settings");
    expect(screen.getByTestId("path").textContent).toBe("/settings");
  });
});
