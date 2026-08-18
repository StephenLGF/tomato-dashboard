import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import "../server/env.mjs";
import { defineConfig } from "vite";

const apiPort = process.env.CODEX_TASKBOARD_PORT || "47823";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
