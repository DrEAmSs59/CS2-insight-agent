import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
const appVersion = process.env.CS2_INSIGHT_APP_VERSION?.trim() || pkg.version;

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");
          if (!normalized.includes("/node_modules/")) return undefined;
          if (/\/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(normalized)) return "vendor-react";
          if (/\/node_modules\/(antd|@ant-design|rc-[^/]+)\//.test(normalized)) return "vendor-antd";
          if (normalized.includes("/node_modules/lucide-react/")) return "vendor-icons";
          if (normalized.includes("/node_modules/axios/")) return "vendor-http";
          return undefined;
        },
      },
    },
  },
});
