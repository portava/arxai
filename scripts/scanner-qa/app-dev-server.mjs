// Vite DEV server of the whole dashboard, with its own vite.config.ts, on 127.0.0.1:4188:
// the development column of the integrated scanner page measurement (measure.mjs
// --surface=app --mode=dev). Nothing behind /api: the measuring browser answers every
// API call itself (app-responsiveness.js). Measurement tooling only.
//
//   node scripts/scanner-qa/app-dev-server.mjs [--source=<checkout>]
//
// --source serves another checkout's dashboard (its sources and node_modules) the same way.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "../..");
const fail = (message, code = 1) => { console.error(`app-dev-server: ${message}`); process.exit(code); };
const args = process.argv.slice(2);
const unknown = args.filter(a => !/^--source=.+$/.test(a));
if (unknown.length) fail(`unknown arguments: ${unknown.join(" ")}`, 2);
const sourceArg = args.find(a => a.startsWith("--source="))?.slice(9);
const source = sourceArg ? path.resolve(sourceArg) : repo;
const dashboard = path.join(source, "artifacts/trading-dashboard");
if (!existsSync(path.join(dashboard, "vite.config.ts"))) fail(`${source} has no artifacts/trading-dashboard/vite.config.ts`, 2);
const PORT = 4188, HOST = "127.0.0.1";
// The dashboard config requires PORT and BASE_PATH. A launcher that set NODE_ENV=production
// would otherwise give this "dev" column production React.
process.env.PORT = String(PORT); process.env.BASE_PATH = "/"; process.env.NODE_ENV = "development";
const require = createRequire(path.join(dashboard, "package.json"));
const { createServer } = await import(require.resolve("vite"));
const server = await createServer({ root: dashboard, configFile: path.join(dashboard, "vite.config.ts"), mode: "development",
  // Own dependency cache, so a developer's running dashboard dev server is never re-optimized.
  cacheDir: path.join(repo, "scripts/node_modules/.vite-scanner-qa-app-dev"),
  server: { host: HOST, port: PORT, strictPort: true, hmr: false },
});
await server.listen();
console.log(`Dashboard dev server for scanner QA ready pid=${process.pid}: http://${HOST}:${PORT} (${source}) — no broker or API connection`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => server.close().finally(() => process.exit(0)));
