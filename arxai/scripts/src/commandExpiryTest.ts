// T033 Phase 9 — command expiry field stamping test.
//
// Proves the serialization logic that /mt5/commands applies to every served
// command: createdAtEpoch (seconds, server time), expiresAt (createdAt + TTL),
// expiresAtEpoch, and expirySeconds. Pure derivation — no DB / no route — so it
// pins the exact math the EA's expiry check relies on.
//
// (The live path /mt5/live-commands-poll already stamped expiresAt/ttlSeconds/
//  serverTimestamp via Task #28; this covers the legacy /mt5/commands path that
//  Phase 9 fixed.)

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

const COMMAND_EXPIRY_SECONDS = 120;

// Mirror of the serialization in routes/mt5.ts GET /mt5/commands. If that
// changes, update both (kept tiny on purpose).
function stampExpiry(createdAt: Date, now: Date) {
  const created = createdAt ?? now;
  const createdAtEpoch = Math.floor(created.getTime() / 1000);
  const expiresAtDate = new Date(created.getTime() + COMMAND_EXPIRY_SECONDS * 1000);
  return {
    createdAt: created.toISOString(),
    createdAtEpoch,
    expiresAt: expiresAtDate.toISOString(),
    expiresAtEpoch: Math.floor(expiresAtDate.getTime() / 1000),
    expirySeconds: COMMAND_EXPIRY_SECONDS,
  };
}

const created = new Date("2026-06-01T12:00:00.000Z");
const now = new Date("2026-06-01T12:00:05.000Z");
const out = stampExpiry(created, now);

// 1. createdAtEpoch present and correct (seconds).
record(1, "createdAtEpoch present", typeof out.createdAtEpoch === "number", String(out.createdAtEpoch));
record(2, "createdAtEpoch = floor(createdAt/1000)",
  out.createdAtEpoch === Math.floor(created.getTime() / 1000), String(out.createdAtEpoch));

// 3. expiresAt present and = createdAt + 120s.
record(3, "expiresAt present", typeof out.expiresAt === "string", out.expiresAt);
record(4, "expiresAt = createdAt + 120s",
  new Date(out.expiresAt).getTime() === created.getTime() + 120_000,
  out.expiresAt);

// 5. expiresAtEpoch consistent.
record(5, "expiresAtEpoch = createdAtEpoch + 120",
  out.expiresAtEpoch === out.createdAtEpoch + 120, String(out.expiresAtEpoch));

// 6. expirySeconds present.
record(6, "expirySeconds = 120", out.expirySeconds === 120, String(out.expirySeconds));

// 7. Uses createdAt (server-set row time), NOT 'now' — proves server time.
record(7, "uses server createdAt not poll-time now",
  out.createdAtEpoch === Math.floor(created.getTime() / 1000) &&
  out.createdAtEpoch !== Math.floor(now.getTime() / 1000),
  `created=${out.createdAtEpoch} now=${Math.floor(now.getTime() / 1000)}`);

// 8. Stale-command behavior: a command created > TTL ago is expired at poll.
const staleCreated = new Date(now.getTime() - 200_000); // 200s ago, TTL 120s
const staleOut = stampExpiry(staleCreated, now);
const secondsUntilExpiry = Math.floor((new Date(staleOut.expiresAt).getTime() - now.getTime()) / 1000);
record(8, "stale command is already expired",
  secondsUntilExpiry < 0, `secondsUntilExpiry=${secondsUntilExpiry}`);

// 9. Fresh command is NOT expired.
const freshOut = stampExpiry(new Date(now.getTime() - 10_000), now); // 10s ago
const freshSecondsLeft = Math.floor((new Date(freshOut.expiresAt).getTime() - now.getTime()) / 1000);
record(9, "fresh command not expired", freshSecondsLeft > 0, `secondsLeft=${freshSecondsLeft}`);

// ─── tally ───
const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
}
// eslint-disable-next-line no-console
console.log(`\n${passed}/${results.length} command-expiry checks passed`);
if (passed !== results.length) process.exit(1);

export {};
