import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Electron helper tests use node:test and are run separately with
    // `node --test`; do not let Vitest collect them as empty suites.
    exclude: [...configDefaults.exclude, "scripts/**/*.test.cjs"],
  },
});
