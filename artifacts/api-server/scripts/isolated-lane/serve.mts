// Isolated API server for the server-backed legacy lane (tests/*.test.mjs).
//
// Same bootstrap as src/index.ts up to listen (safety core row, owner/admin
// bootstrap, legacy-owner downgrade, core agents), then listen. It differs
// from production startup in two ways, both on purpose:
//   - src/index.ts is never imported, so none of its workers, schedulers or
//     keep-alives start (stuck-command watchdog, UNKNOWN reconciler, result
//     settlement, feed watchdog, agent lifecycle runner, anomaly detector,
//     report/retention/key workers, Deriv bootstrap and keep-alive).
//   - app.ts starts two database workers when it is imported (the trade
//     monitor and the Ruby outcome worker). Every interval created while
//     app.ts loads is recorded; each one is cleared unless it is one of the
//     in-memory clocks listed in IN_MEMORY, which do no I/O. A new
//     module-level interval is therefore cleared by default.
// The runner (run.mjs) preloads offline.cjs, so external connections fail,
// and points DATABASE_URL at a disposable PostgreSQL it created.
const IN_MEMORY = [
  "lib/marketSimulator.ts", // simulator price clock (in-memory quotes)
  "lib/oms.ts", // simulator OMS position ticks (in-memory book)
  "lib/aiBrain.ts", // sweeps abandoned replay sessions from a Map
  "lib/marketDataLayer.ts", // sweeps old seeded news events from a Map
];

const created: Array<{ handle: ReturnType<typeof setInterval>; origin: string }> = [];
const realSetInterval = globalThis.setInterval;
const tracking = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = realSetInterval(fn, ms, ...rest);
  const frame = (new Error().stack ?? "").split("\n").slice(2).find((l) => l.includes("/src/")) ?? "unknown";
  created.push({ handle, origin: frame.replace(/^.*\/artifacts\/api-server\/src\//, "").replace(/[()]/g, "").trim() });
  return handle;
}) as typeof setInterval;
globalThis.setInterval = tracking;

const { default: app } = await import("../../src/app.ts");
globalThis.setInterval = realSetInterval;

const cleared: string[] = [];
const kept: string[] = [];
for (const t of created) {
  if (IN_MEMORY.some((m) => t.origin.startsWith(`${m}:`))) kept.push(t.origin);
  else { clearInterval(t.handle); cleared.push(t.origin); }
}
console.log(`ISOLATED_BACKGROUND_TIMERS cleared=${JSON.stringify(cleared)} kept_in_memory=${JSON.stringify(kept)}`);

const { ensureSafetyCoreInitialized } = await import("../../src/lib/safetyCore.ts");
const { bootstrapOwnerUser } = await import("../../src/lib/auth/ownerBootstrap.ts");
const { bootstrapAdminUser } = await import("../../src/lib/auth/adminBootstrap.ts");
const { bootstrapLegacyOwnerDowngrade } = await import("../../src/lib/auth/legacyOwnerDowngrade.ts");
const { seedCoreAgents } = await import("../../src/lib/agentEcosystem/seedCoreAgents.ts");

await ensureSafetyCoreInitialized();
for (const step of [bootstrapOwnerUser, bootstrapAdminUser, bootstrapLegacyOwnerDowngrade, seedCoreAgents]) {
  try { await step(); } catch (err) { console.error(`bootstrap step ${step.name} failed (non-fatal, as in src/index.ts)`, String(err)); }
}

const server = app.listen(Number(process.env["PORT"] ?? 0), "127.0.0.1", () => {
  const addr = server.address();
  console.log(`ISOLATED_API_LISTENING ${typeof addr === "object" && addr ? addr.port : "?"} (no background workers)`);
});
