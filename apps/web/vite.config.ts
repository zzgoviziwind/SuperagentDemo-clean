import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: { setupFiles: ["./src/test/dialogSetup.ts"] },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: false },
      "/health": { target: "http://127.0.0.1:8765", changeOrigin: false },
    },
  },
});
