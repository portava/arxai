// Static-source guard: manual LIVE trade surfaces must use a single Confirm.
//
// This test FAILS the build if the removed two-step "Validate/Review → ack
// checkbox → Confirm" manual live-trade flow regresses back into the
// user-facing live execution surfaces. The intended UX is ONE final action
// ("Confirm Buy"/"Confirm Sell"/"Confirm Live Test Cycle") that submits the
// order directly — every backend safety gate still runs server-side.
//
// Why a static scan: re-introducing a pre-validate step or an ack checkbox is
// a copy/flow regression that runtime tests won't catch unless the live path
// is exercised. These are surface invariants, not behaviour the server can
// enforce.
//
// Run: pnpm --filter @workspace/scripts run test:live-single-confirm

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FE = resolve(here, "../../artifacts/trading-dashboard/src");

function read(rel: string): string {
  return readFileSync(resolve(FE, rel), "utf8");
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`[${name}] ${detail ?? "assertion failed"}`);
}

// ── 1. LiveSharedTradeTicket — single Confirm, no validate/ack ────────────
const liveShared = read("components/live/LiveSharedTradeTicket.tsx");

check(
  "live-shared has a single confirm button",
  liveShared.includes('data-testid="ls-btn-confirm"'),
  "LiveSharedTradeTicket.tsx must render the single confirm button (ls-btn-confirm)",
);
check(
  "live-shared confirm label is Confirm Buy/Sell or sending",
  liveShared.includes("Sending live order…") &&
    liveShared.includes("Confirm ${side"),
  "expected the single-confirm label (Confirm Buy/Sell + 'Sending live order…')",
);
check(
  "live-shared shows exact disabled reason",
  liveShared.includes('data-testid="ls-confirm-disabled-reason"'),
  "the disabled confirm must surface its exact blocker (ls-confirm-disabled-reason)",
);
// Control-flow: the single confirm button must bind directly to the execute
// handler and gate on the computed validity — not on an intermediate
// validate/ack step.
check(
  "live-shared confirm binds onClick={onConfirm}",
  /onClick=\{onConfirm\}/.test(liveShared),
  "ls-btn-confirm must call onConfirm() (which posts /execute) directly",
);
check(
  "live-shared confirm disables on !intentValid (computed validity)",
  liveShared.includes("!intentValid"),
  "the confirm button must disable on computed validity, not a manual ack flag",
);
check(
  "live-shared has non-blocking exit-protection warning",
  liveShared.includes('data-testid="ls-exit-protection-warning"'),
  "expected the inline SL/TP exit-protection warning (ls-exit-protection-warning)",
);
check(
  "live-shared has non-blocking ruby-bias warning",
  liveShared.includes('data-testid="ls-ruby-bias-warning"'),
  "expected the inline Ruby bias-mismatch warning (ls-ruby-bias-warning)",
);
// Forbidden two-step remnants in the user-facing live ticket. We ignore
// comment lines (which document that these were removed) and only fail on
// real code/markup usage.
const liveSharedCode = liveShared
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");
const FORBIDDEN_TWOSTEP = [
  "Validate trade",
  "Validate Trade",
  'data-testid="ls-btn-validate"',
  'data-testid="check-live-shared-ack"',
];
for (const phrase of FORBIDDEN_TWOSTEP) {
  check(
    `live-shared no two-step remnant "${phrase}"`,
    !liveSharedCode.includes(phrase),
    `LiveSharedTradeTicket.tsx still contains removed two-step element "${phrase}"`,
  );
}

// ── 2. LiveTradeTicket — standard mode single Confirm, no ack checkbox ────
const liveTicket = read("components/live/LiveTradeTicket.tsx");
check(
  "standard live ticket dropped the ack checkbox",
  !liveTicket.includes('data-testid="check-live-confirm"'),
  "LiveTradeTicket.tsx must not require the confirm checkbox (check-live-confirm)",
);
check(
  "standard live ticket has confirm label",
  liveTicket.includes("Sending live order…") && liveTicket.includes("Confirm ${"),
  "expected the standard-mode Confirm Buy/Sell label",
);
check(
  "standard live ticket has non-blocking no-SL warning",
  liveTicket.includes('data-testid="live-no-sl-warning"'),
  "expected the inline non-blocking no-SL warning (live-no-sl-warning)",
);
check(
  "standard live ticket shows exact disabled reason",
  liveTicket.includes('data-testid="live-confirm-disabled-reason"'),
  "the standard-mode confirm must surface its exact blocker (live-confirm-disabled-reason)",
);

// ── 3. ControlledLiveTestButton — single Confirm, no modal/ack ────────────
const ltc = read("components/live/ControlledLiveTestButton.tsx");
check(
  "live-test-cycle has a single confirm button",
  ltc.includes('data-testid="ltc-btn-confirm"'),
  "ControlledLiveTestButton.tsx must render the single confirm button (ltc-btn-confirm)",
);
check(
  "live-test-cycle removed the confirm modal/ack",
  !ltc.includes("modalAck") && !ltc.includes("aria-labelledby=\"ltc-confirm-title\""),
  "ControlledLiveTestButton.tsx still contains the removed ack modal",
);
check(
  "live-test-cycle preview is optional (not a gate)",
  ltc.includes("Preview (optional dry-run)"),
  "Preview must be relabelled as an optional dry-run, not a required pre-step",
);

console.log(`live single-confirm guard: ${pass}/${pass + fail} PASS`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
process.exit(0);
