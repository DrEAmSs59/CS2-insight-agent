import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import API from "../../api/api";
import { useLocaleStore } from "../../i18n/localeStore.js";
import GameResourcesSettings from "./GameResourcesSettings.jsx";


vi.mock("../../api/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));


const BUILTIN_RESPONSE = {
  data: {
    items: [{
      id: "cartoon3",
      display_name: "Cartoon 3",
      source: "builtin",
      readonly: true,
      available: true,
      material_original_name: "cartoon3.vmat_c",
      texture_original_name: "cartoon3_exr_hash.vtex_c",
      size_bytes: 0,
    }],
  },
};


describe("GameResourcesSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocaleStore.getState().hydrate("zh");
    API.get.mockResolvedValue(BUILTIN_RESPONSE);
  });

  it("shows bundled resources as read-only and opens the custom upload form", async () => {
    render(<GameResourcesSettings />);

    expect(await screen.findByText("Cartoon 3")).toBeTruthy();
    expect(screen.getByText("只读")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加天空盒" }));
    expect(screen.getByText("材质文件（.vmat_c）")).toBeTruthy();
    expect(screen.getByText("纹理文件（.vtex_c）")).toBeTruthy();
  });

  it("prefills the name from vmat_c and uploads both files atomically", async () => {
    API.post.mockResolvedValue({ data: { id: "custom:0123456789abcdef0123456789abcdef" } });
    render(<GameResourcesSettings />);
    await screen.findByText("Cartoon 3");
    fireEvent.click(screen.getByRole("button", { name: "添加天空盒" }));

    const fileInputs = document.querySelectorAll('input[type="file"]');
    const material = new File(["material"], "purple_sky.vmat_c");
    const texture = new File(["texture"], "purple_sky_exr_hash.vtex_c");
    fireEvent.change(fileInputs[0], { target: { files: [material] } });
    fireEvent.change(fileInputs[1], { target: { files: [texture] } });

    expect(screen.getByDisplayValue("purple_sky")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "校验并上传" }));

    await waitFor(() => expect(API.post).toHaveBeenCalledTimes(1));
    const form = API.post.mock.calls[0][1];
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("display_name")).toBe("purple_sky");
    expect(form.get("material_file").name).toBe("purple_sky.vmat_c");
    expect(form.get("texture_file").name).toBe("purple_sky_exr_hash.vtex_c");
  });
});
