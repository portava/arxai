import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { dashboardStyleSourcePlugin } from "../scanner-qa/shared-chart-fixture/stylesheet.mjs";

export async function buildFixture(outDir) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const dashboard = path.resolve(root, "../../artifacts/trading-dashboard");
  const require = createRequire(path.join(dashboard, "package.json"));
  const { build } = await import(require.resolve("vite"));
  const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
  const { default: tailwind } = await import(require.resolve("@tailwindcss/vite"));
  await build({
    root, configFile: false, publicDir: false, base: "/", logLevel: "warn",
    plugins: [dashboardStyleSourcePlugin(dashboard), react(), tailwind()],
    resolve: {
      alias: [
        { find: "react", replacement: path.dirname(require.resolve("react/package.json")) },
        { find: "react-dom", replacement: path.dirname(require.resolve("react-dom/package.json")) },
        { find: "lucide-react", replacement: require.resolve("lucide-react") },
        { find: "./AlertsDrawer", replacement: path.join(root, "AlertsDrawer.tsx") },
        ...["@workspace/api-client-react", "@/hooks/useFeatureUnlock", "@/hooks/useTradingMode", "@/lib/use-chart-symbol"]
          .map(find => ({ find, replacement: path.join(root, "data.ts") })),
        { find: "@", replacement: path.join(dashboard, "src") },
      ], dedupe: ["react", "react-dom"],
    },
    build: { outDir, emptyOutDir: false, sourcemap: false },
  });
}
