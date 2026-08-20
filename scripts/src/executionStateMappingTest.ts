// Test: canonical execution-state vocabulary (R2 slice S0).
//
// Pins the PURE mapping layer in lib/domain/src/execution-state/ over the
// three existing free-text status columns:
//
//   1. EXHAUSTIVENESS. The canonical list must equal the spec's 14-value
//      `execution_order_state` enum EXACTLY (content and order). A drive-by
//      addition or removal must fail here, not surface as silent drift.
//
//   2. TOTALITY PER VOCABULARY. Every observed literal in each of the three
//      source vocabularies (arx_live_commands, mt5_demo_commands,
//      mt5_commands) maps to an explicitly chosen canonical state with an
//      explicit lossiness verdict — asserted literal by literal.
//
//   3. HONESTY ON UNRECOGNIZED INPUT. Anything outside the observed set —
//      including case variants, since these are free-text columns — maps to
//      { state: "unknown", lossy: true, note: "UNMAPPED:<value>" }. Never a
//      throw, never a guessed happy state.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import { executionState, safetyContracts } from "@workspace/domain";
import { ARX_LIVE_COMMAND_STATUSES } from "@workspace/db/schema";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const {
  CANONICAL_EXECUTION_STATES,
  fromArxLiveStatus,
  fromMt5DemoStatus,
  fromMt5CommandStatus,
} = executionState;

type Mapper = (s: string) => executionState.CanonicalStateMapping;

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  console.log("executionStateMappingTest");
  console.log("=========================\n");

  // ── 1. Exhaustiveness: canonical list === spec enum, exactly ──────────────
  console.log("Canonical enum matches the spec's execution_order_state exactly");
  {
    // Spec §7 `execution_order_state`, restated independently here so a
    // change to the domain constant cannot satisfy its own assertion.
    const SPEC_ENUM = [
      "created",
      "risk_rejected",
      "awaiting_confirmation",
      "authorized",
      "submitting",
      "acknowledged",
      "partially_filled",
      "filled",
      "cancel_pending",
      "cancelled",
      "rejected",
      "expired",
      "unknown",
      "reconciliation_required",
    ] as const;

    assert(CANONICAL_EXECUTION_STATES.length === 14, "canonical list has exactly 14 states");
    assert(
      new Set(CANONICAL_EXECUTION_STATES).size === CANONICAL_EXECUTION_STATES.length,
      "canonical list has no duplicates",
    );
    assert(
      JSON.stringify([...CANONICAL_EXECUTION_STATES]) === JSON.stringify([...SPEC_ENUM]),
      "canonical list equals the spec enum, content and order",
    );
  }

  // Shared checker: every literal in a vocabulary asserted individually.
  function checkVocabulary(
    label: string,
    mapper: Mapper,
    expected: ReadonlyArray<readonly [string, executionState.CanonicalExecutionState, boolean]>,
  ) {
    console.log(`\n${label}`);
    for (const [literal, state, lossy] of expected) {
      const got = mapper(literal);
      assert(
        got.state === state && got.lossy === lossy,
        `${literal} → ${state} (lossy: ${lossy})` +
          (got.state === state && got.lossy === lossy
            ? ""
            : ` — got ${got.state} (lossy: ${got.lossy})`),
      );
      assert(
        (CANONICAL_EXECUTION_STATES as readonly string[]).includes(got.state),
        `${literal} maps into the canonical enum`,
      );
      assert(
        got.note === undefined || !got.note.startsWith("UNMAPPED:"),
        `${literal} is explicitly mapped, not an UNMAPPED fallback`,
      );
    }
  }

  // ── 2a. arx_live_commands vocabulary (13 literals) ────────────────────────
  const ARX_EXPECTED = [
    ["LIVE_DRAFT", "created", false],
    ["LIVE_CONFIRMATION_REQUIRED", "awaiting_confirmation", false],
    ["LIVE_APPROVED", "authorized", false],
    ["SENT_TO_MT5_LIVE", "submitting", true],
    ["LIVE_FILLED", "filled", false],
    ["LIVE_REJECTED", "rejected", false],
    ["LIVE_FAILED", "rejected", true],
    ["LIVE_BLOCKED", "risk_rejected", true],
    ["LIVE_CANCELLED", "cancelled", false],
    ["LIVE_CLOSED", "filled", true],
    ["LIVE_EXPIRED", "expired", true],
    // R2 S1 — epistemic states, lossless onto their canonical namesakes.
    ["LIVE_UNKNOWN", "unknown", false],
    ["LIVE_RECONCILIATION_REQUIRED", "reconciliation_required", false],
  ] as const;
  checkVocabulary("arx_live_commands.status → canonical", fromArxLiveStatus, ARX_EXPECTED);
  {
    const covered = new Set(ARX_EXPECTED.map(([l]) => l));
    assert(
      ARX_LIVE_COMMAND_STATUSES.every((s) => covered.has(s)) &&
        ARX_LIVE_COMMAND_STATUSES.length === covered.size,
      "test table covers ARX_LIVE_COMMAND_STATUSES exactly (schema is the source of truth)",
    );
  }

  // ── 2b. mt5_demo_commands vocabulary (8 writer literals + 1 forward-declared) ──
  const DEMO_EXPECTED = [
    ["DRAFT", "created", false],
    ["USER_CONFIRMATION_REQUIRED", "awaiting_confirmation", false],
    ["DEMO_APPROVED", "authorized", false],
    ["SENT_TO_MT5_DEMO", "submitting", true],
    ["FILLED_DEMO", "filled", false],
    ["REJECTED", "rejected", false],
    ["BLOCKED", "risk_rejected", true],
    ["FAILED", "rejected", true],
    // R2 S5 (audit G2) — forward-declared partial-fill literal: the mapping
    // layer recognizes it AHEAD of its adoption in executionMode.ts
    // DemoCommandStatus (free-text column, so this is read-side only).
    ["DEMO_PARTIALLY_FILLED", "partially_filled", false],
  ] as const;
  checkVocabulary("mt5_demo_commands.status → canonical", fromMt5DemoStatus, DEMO_EXPECTED);
  {
    // R2 S5 — the demo writer vocabulary has no partial state yet, so the
    // coverage law is: test table = DEMO_COMMAND_STATUSES ∪ FORWARD_DECLARED,
    // with every forward-declared literal STILL ABSENT from the writer
    // vocabulary. The day executionMode.ts adopts DEMO_PARTIALLY_FILLED,
    // the third assertion goes red and forces this list back to empty —
    // the exact-coverage discipline self-restores.
    const FORWARD_DECLARED_DEMO = ["DEMO_PARTIALLY_FILLED"] as const;
    const covered = new Set(DEMO_EXPECTED.map(([l]) => l));
    assert(
      safetyContracts.DEMO_COMMAND_STATUSES.every((s) => covered.has(s)),
      "test table covers every DEMO_COMMAND_STATUSES literal (executionMode.ts is the source of truth)",
    );
    assert(
      covered.size === safetyContracts.DEMO_COMMAND_STATUSES.length + FORWARD_DECLARED_DEMO.length &&
        FORWARD_DECLARED_DEMO.every((l) => covered.has(l)),
      "test table adds exactly the forward-declared literals, nothing else",
    );
    assert(
      FORWARD_DECLARED_DEMO.every(
        (l) => !(safetyContracts.DEMO_COMMAND_STATUSES as readonly string[]).includes(l),
      ),
      "forward-declared literals are still absent from DEMO_COMMAND_STATUSES (once adopted, remove them from FORWARD_DECLARED_DEMO)",
    );
  }

  // ── 2c. mt5_commands free-text vocabulary (13 observed literals) ──────────
  // Observed set: schema comment lib/db/src/schema/mt5Commands.ts:21 plus
  // writers (executionReconciler, stuckCommandWatchdog, queueMt5CommandWithGate,
  // meMt5Commands cancel, verbatim EA-posted /mt5/command-result statuses).
  const LEGACY_EXPECTED = [
    ["PENDING", "authorized", true],
    ["DELIVERED", "submitting", true],
    ["claimed", "submitting", true],
    ["sent", "submitting", true],
    ["completed", "filled", true],
    ["executed", "filled", true],
    ["partial", "partially_filled", false],
    ["failed", "rejected", true],
    ["rejected", "rejected", false],
    ["expired", "expired", true],
    ["cancelled", "cancelled", false],
    ["BLOCKED", "risk_rejected", true],
    ["blocked_demo_mode", "risk_rejected", true],
  ] as const;
  checkVocabulary("mt5_commands.status → canonical", fromMt5CommandStatus, LEGACY_EXPECTED);

  // ── 3. Unrecognized input → unknown, lossy, UNMAPPED note; never throws ───
  console.log("\nUnrecognized input degrades honestly");
  {
    const mappers: ReadonlyArray<readonly [string, Mapper]> = [
      ["fromArxLiveStatus", fromArxLiveStatus],
      ["fromMt5DemoStatus", fromMt5DemoStatus],
      ["fromMt5CommandStatus", fromMt5CommandStatus],
    ];
    for (const [name, mapper] of mappers) {
      const got = mapper("TOTALLY_NEW_STATUS");
      assert(
        got.state === "unknown" && got.lossy === true && got.note === "UNMAPPED:TOTALLY_NEW_STATUS",
        `${name}: unrecognized literal → unknown/lossy with UNMAPPED note`,
      );
      const empty = mapper("");
      assert(
        empty.state === "unknown" && empty.lossy === true && empty.note === "UNMAPPED:",
        `${name}: empty string → unknown/lossy with UNMAPPED note`,
      );
      let threw = false;
      try {
        mapper("💥 weird \0 input");
      } catch {
        threw = true;
      }
      assert(!threw, `${name}: never throws on arbitrary input`);
    }

    // Free-text columns: case variants are unexpected writers, not synonyms.
    assert(
      fromMt5CommandStatus("Completed").state === "unknown",
      "case-sensitive: 'Completed' is not 'completed' — maps to unknown",
    );
    assert(
      fromMt5CommandStatus("FAILED").state === "unknown",
      "case-sensitive: 'FAILED' is not the legacy 'failed' — maps to unknown",
    );
    assert(
      fromArxLiveStatus("live_filled").state === "unknown",
      "case-sensitive: 'live_filled' is not 'LIVE_FILLED' — maps to unknown",
    );
    assert(
      fromMt5DemoStatus("filled_demo").state === "unknown",
      "case-sensitive: 'filled_demo' is not 'FILLED_DEMO' — maps to unknown",
    );

    // Cross-vocabulary literals are NOT interchangeable: each mapper only
    // recognizes its own column's writers.
    assert(
      fromMt5DemoStatus("SENT_TO_MT5_LIVE").state === "unknown",
      "demo mapper refuses the live vocabulary",
    );
    assert(
      fromArxLiveStatus("completed").state === "unknown",
      "live mapper refuses the legacy vocabulary",
    );
  }

  // ── 4. Results are copies — a mutated result cannot poison the table ──────
  console.log("\nMapping results are defensive copies");
  {
    const first = fromArxLiveStatus("LIVE_FILLED");
    first.state = "unknown" as typeof first.state;
    first.lossy = true;
    const second = fromArxLiveStatus("LIVE_FILLED");
    assert(
      second.state === "filled" && second.lossy === false,
      "mutating a returned mapping does not alter subsequent lookups",
    );
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "executionStateMappingTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[executionStateMappingTest] FAILED:", err);
      process.exit(1);
    },
  );
}
