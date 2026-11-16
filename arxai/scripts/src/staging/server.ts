// Import app only, never index.ts (which starts execution/background workers).
import { writeFileSync } from "node:fs";
if (process.env.NODE_ENV !== "development" || process.env.ARX_PREVIEW_SAFE_START !== "true" || process.env.ARX_DEMO_EXPIRY_SWEEP_ENABLED !== "false") {
  throw new Error("Staging API requires all background workers paused");
}
const { default: app } = await import("../../../artifacts/api-server/src/app.js");
const { marketSimulator } = await import("../../../artifacts/api-server/src/lib/marketSimulator.js");
marketSimulator.stop();
const { ensureSafetyCoreInitialized } = await import("../../../artifacts/api-server/src/lib/safetyCore.js");
const { getGlobalTradingConfig } = await import("../../../artifacts/api-server/src/lib/safety/platformSwitches.js");
await ensureSafetyCoreInitialized();
if (!await getGlobalTradingConfig()) throw new Error("Could not seed fail-closed global settings");
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No staging listener");
  writeFileSync(process.env.ARX_STAGING_READY_FILE!, `http://127.0.0.1:${address.port}`, { mode: 0o600 });
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
