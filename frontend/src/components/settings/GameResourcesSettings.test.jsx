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
      preview_url: "/skyboxes/cartoon3.webp",
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
    const { container } = render(<GameResourcesSettings />);

    expect(await screen.findByText("Cartoon 3")).toBeTruthy();
    expect(screen.getByText("1 个 · 只读")).toBeTruthy();
    expect(screen.getByText("Cartoon 系列")).toBeTruthy();
    const previewButton = screen.getByRole("button", { name: "预览天空盒：Cartoon 3" });
    expect(previewButton.querySelector('img[src="/skyboxes/cartoon3.webp"]')).toBeTruthy();
    fireEvent.click(previewButton);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getAllByAltText("Cartoon 3 天空盒全景预览")).toHaveLength(2);
    expect(Array.from(container.querySelectorAll("div"))
      .some((element) => element.classList.contains("divide-y"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "添加天空盒" }));
    expect(screen.getByText("材质文件（.vmat_c）")).toBeTruthy();
    expect(screen.getByText("纹理文件（.vtex_c）")).toBeTruthy();
  });

  it("does not reserve a preview box for custom compiled resources", async () => {
    API.get.mockResolvedValue({
      data: {
        items: [
          ...BUILTIN_RESPONSE.data.items,
          {
            id: `custom:${"a".repeat(32)}`,
            display_name: "我的 Cartoon",
            source: "custom",
            readonly: false,
            available: true,
            material_original_name: "cartoon.vmat_c",
            texture_original_name: "cartoon_exr_hash.vtex_c",
            size_bytes: 8388608,
            preview_url: null,
          },
        ],
      },
    });

    render(<GameResourcesSettings />);
    const customRow = await screen.findByTestId("custom-skybox-resource");
    expect(customRow.querySelector("img")).toBeNull();
    expect(customRow.textContent).toContain("我的 Cartoon");
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
