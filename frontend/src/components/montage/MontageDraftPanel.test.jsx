/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MontageDraftPanel from "./MontageDraftPanel.jsx";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  delete: vi.fn(),
}));

const translate = (key, params = {}) => (params.name ? `${key}:${params.name}` : key);

vi.mock("../../api/api", () => ({ default: api }));
vi.mock("../../i18n/useT.js", () => ({ useT: () => translate }));

const summary = {
  id: 7,
  name: "Dust2 ACE",
  clip_count: 3,
  output_filename: "dust2_ace.mp4",
  has_bgm: true,
  updated_at: "2026-08-09T12:00:00Z",
};

describe("MontageDraftPanel", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.delete.mockReset();
    api.delete.mockResolvedValue({ data: { status: "ok" } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("lists saved drafts and opens the selected project", async () => {
    const detail = { ...summary, body: { recorded_clip_ids: [1, 2, 3] } };
    api.get.mockImplementation((url) => {
      if (url === "/montage/projects") return Promise.resolve({ data: { items: [summary], total: 1 } });
      if (url === "/montage/projects/7") return Promise.resolve({ data: detail });
      return Promise.reject(new Error("unexpected request"));
    });
    const onOpenDraft = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();

    render(<MontageDraftPanel open onClose={onClose} onOpenDraft={onOpenDraft} />);

    expect(await screen.findByText("Dust2 ACE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "montage.draftsOpenBtn" }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/montage/projects/7"));
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith(detail));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes a draft without touching source media", async () => {
    api.get.mockResolvedValue({ data: { items: [summary], total: 1 } });
    render(<MontageDraftPanel open onClose={vi.fn()} onOpenDraft={vi.fn()} />);

    expect(await screen.findByText("Dust2 ACE")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "montage.draftsDeleteBtn:Dust2 ACE" }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/montage/projects/7"));
    await waitFor(() => expect(screen.queryByText("Dust2 ACE")).toBeNull());
  });
});
