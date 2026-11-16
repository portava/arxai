// Task #28 QA — live-command lifecycle invariants (pure-function coverage).
//
// HARD CONSTRAINT: this test NEVER inserts a row into arx_live_commands (the
// persistent live audit table) nor places any trade. It exercises only the
// pure freshness / exactly-once / ghost-close helpers extracted from
// liveCommandPipeline.ts, so it is safe to run in CI against a live DB.
//
// Covers:
//   - TTL stamping + expiry decision (computeLiveExpiry / isLiveCommandStale)
//   - exactly-once duplicate detection (isTerminalLiveStatus)
//   - forced ghost-close reconciliation matcher (findGhostClosedPositionIds)
import {
  LIVE_COMMAND_TTL_SECONDS,
  computeLiveExpiry,
  isLiveCommandStale,
  isTerminalLiveStatus,
  findGhostClosedPositionIds,
} from "../../artifacts/api-server/src/lib/live/liveCommandPipeline.js";

let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  // eslint-disable-next-line no-console
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
}

// ---------------------------------------------------------------------------
// TTL stamping + expiry
// ---------------------------------------------------------------------------
const dispatchedAt = new Date("2026-05-29T00:00:00.000Z");
const expiresAt = computeLiveExpiry(dispatchedAt, LIVE_COMMAND_TTL_SECONDS);

assert("expiresAt = serverTimestamp + ttl",
  expiresAt.getTime() === dispatchedAt.getTime() + LIVE_COMMAND_TTL_SECONDS * 1000,
  `expiresAt=${expiresAt.toISOString()}`);

assert("default ttl is 60s", LIVE_COMMAND_TTL_SECONDS === 60,
  `ttl=${LIVE_COMMAND_TTL_SECONDS}`);

// Just before expiry → fresh.
assert("not stale 1s before expiry",
  isLiveCommandStale(expiresAt, new Date(expiresAt.getTime() - 1000)) === false);

// Exactly at expiry → stale (>=).
assert("stale at exact expiry instant",
  isLiveCommandStale(expiresAt, new Date(expiresAt.getTime())) === true);

// Well past expiry → stale.
assert("stale 5s after expiry",
  isLiveCommandStale(expiresAt, new Date(expiresAt.getTime() + 5000)) === true);

// Legacy un-stamped row (null expiresAt) → never stale via this predicate.
assert("null expiresAt is not stale", isLiveCommandStale(null, new Date()) === false);

// ---------------------------------------------------------------------------
// Exactly-once: terminal status detection
// ---------------------------------------------------------------------------
const terminal = [
  "LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED",
  "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_CLOSED", "LIVE_EXPIRED",
] as const;
for (const s of terminal) {
  assert(`terminal: ${s}`, isTerminalLiveStatus(s) === true);
}
const nonTerminal = [
  "LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED", "SENT_TO_MT5_LIVE",
] as const;
for (const s of nonTerminal) {
  assert(`non-terminal: ${s}`, isTerminalLiveStatus(s) === false);
}

// ---------------------------------------------------------------------------
// Forced ghost-close reconciliation matcher
// ---------------------------------------------------------------------------
// Open positions; one (ticket 40797138324) has a LIVE_FILLED CLOSE command →
// it is a ghost and must be reported for closedAt stamping. The other has no
// matching close and must be left open.
const open = [
  { id: 3, brokerTicket: "40797138324" },
  { id: 4, brokerTicket: "99999999999" },
];

// brokerTicket carried on the command column.
const ghostsByColumn = findGhostClosedPositionIds(open, [
  { brokerTicket: "40797138324", payload: null },
]);
assert("ghost matched via command.brokerTicket",
  ghostsByColumn.length === 1 && ghostsByColumn[0] === 3,
  `got=[${ghostsByColumn.join(",")}]`);

// brokerTicket carried only inside payload.
const ghostsByPayload = findGhostClosedPositionIds(open, [
  { brokerTicket: null, payload: { brokerTicket: "40797138324" } },
]);
assert("ghost matched via payload.brokerTicket",
  ghostsByPayload.length === 1 && ghostsByPayload[0] === 3,
  `got=[${ghostsByPayload.join(",")}]`);

// No filled close → nothing reconciled (open stays open).
const noGhosts = findGhostClosedPositionIds(open, []);
assert("no filled close → nothing reconciled", noGhosts.length === 0,
  `got=[${noGhosts.join(",")}]`);

// A close for a ticket that is NOT open must not match anything.
const unrelated = findGhostClosedPositionIds(open, [
  { brokerTicket: "11111111111", payload: null },
]);
assert("unrelated close does not match open positions", unrelated.length === 0,
  `got=[${unrelated.join(",")}]`);

// Empty / blank tickets must never produce a false match.
const blank = findGhostClosedPositionIds(
  [{ id: 7, brokerTicket: "" }],
  [{ brokerTicket: "", payload: { brokerTicket: "" } }],
);
assert("blank tickets never match", blank.length === 0, `got=[${blank.join(",")}]`);

// ---------------------------------------------------------------------------
// eslint-disable-next-line no-console
console.log(`\n${failed === 0 ? "Task #28 live-command lifecycle OK" : `${failed} assertions failed`}`);
process.exit(failed === 0 ? 0 : 1);
