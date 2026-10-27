import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const dashboard = path.join(repo, "artifacts/trading-dashboard");
const require = createRequire(path.join(dashboard, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const { default: react } = await import(require.resolve("@vitejs/plugin-react"));
const { default: tailwind } = await import(require.resolve("@tailwindcss/vite"));
const server = await createServer({ root, configFile: false, plugins: [react(), tailwind()],
 resolve: { alias: [
 {find:"react", replacement:path.dirname(require.resolve("react/package.json"))},
 {find:"react-dom", replacement:path.dirname(require.resolve("react-dom/package.json"))},
 {find:"@/hooks/useScannerTruth", replacement:path.join(root,"truth.ts")},
 {find:"@/lib/useChartDeepHistory", replacement:path.join(root,"history.ts")},
 {find:"@workspace/api-client-react", replacement:path.join(root,"api.ts")},
 {find:"@", replacement:path.join(dashboard,"src")},
 ], dedupe:["react","react-dom"], },
 server:{host:"127.0.0.1",port:4178,strictPort:true,fs:{allow:[repo]}},
});
await server.listen();
console.log("Isolated chart fixture: http://127.0.0.1:4178 — no broker or API connection");
