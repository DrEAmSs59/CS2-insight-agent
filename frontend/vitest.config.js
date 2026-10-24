import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Generated release copies can contain Node-only Panorama tests.
    exclude: [...configDefaults.exclude, "src-tauri/target/**", "src-tauri/bundle-resources/**", "scripts/*.test.mjs"],
  },
});
