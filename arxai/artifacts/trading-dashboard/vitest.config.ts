import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Standalone Vitest config. We intentionally do NOT reuse vite.config.ts
// because it throws at module load when PORT / BASE_PATH are unset (those are
// only provided by the dev/build workflow). This config replicates just the
// pieces the component tests need: the React plugin and the "@" path alias.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
