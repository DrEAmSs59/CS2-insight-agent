import { afterEach, describe, expect, test } from "vitest";
import { installAppInteractionGuards } from "./appInteractionGuards.js";

describe("installAppInteractionGuards", () => {
  let cleanup = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.replaceChildren();
  });

  test("prevents the native context menu throughout the app", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    cleanup = installAppInteractionGuards(document);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test("blocks page selection while keeping editable fields selectable", () => {
    const label = document.createElement("span");
    const input = document.createElement("input");
    document.body.append(label, input);
    cleanup = installAppInteractionGuards(document);

    const pageSelection = new Event("selectstart", { bubbles: true, cancelable: true });
    label.dispatchEvent(pageSelection);
    expect(pageSelection.defaultPrevented).toBe(true);

    const inputSelection = new Event("selectstart", { bubbles: true, cancelable: true });
    input.dispatchEvent(inputSelection);
    expect(inputSelection.defaultPrevented).toBe(false);
  });
});
