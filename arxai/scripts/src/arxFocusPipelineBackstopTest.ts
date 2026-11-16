// ── ARX Focus live-pipeline backstop — scope contract test (Task #558) ───────
//
// Deterministic, no DB / no server. Locks the live-command pipeline's
// `SYMBOL_NOT_IN_ARX_FOCUS` backstop against regression. The backstop is
// ADDITIVE (it never relaxes the synthetic floor, the 16-gate evaluator, the
// SL policy, caps, the kill switch, or the owner/admin relaxations) and is
// NEW-ENTRY ONLY: only PLACE_LIVE_MARKET_ORDER / PLACE_LIVE_PENDING_ORDER are
// gated, so position management (close / modify / cancel) is exempt by
// construction and an existing position on any symbol can always be managed.
//
// We assert STRUCTURE over the real source (comments stripped first so doc
// comments can never false-pass — see the "source-scan false-pass" lesson):
//   1. The refusal reason union carries "SYMBOL_NOT_IN_ARX_FOCUS".
//   2. PREFLIGHT chokepoint: entry-only gate AND !isApprovedArxMarket() →
//      returns reason: "SYMBOL_NOT_IN_ARX_FOCUS".
//   3. DISPATCH chokepoint: isEntryRow && !isApprovedArxMarket() →
//      "SYMBOL_NOT_IN_ARX_FOCUS:" rejection.
//   4. EXEMPTION: there are EXACTLY two isApprovedArxMarket() call-sites (the
//      two backstops) and NEITHER ops command type (CLOSE_LIVE_POSITION /
//      MODIFY_LIVE_SLTP) is ever a condition on an isApprovedArxMarket gate.
//   5. The helper is imported from the single source of truth
//      (@workspace/domain/market), never re-implemented locally.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PIPELINE = resolve(
  here,
  "../../artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
);

// Strip block comments, then drop any line whose trimmed content is a line
// comment. This removes the Task #558 doc comments (which name every gate and
// command type) so they cannot satisfy the structural assertions below.
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// Collapse all runs of whitespace to single spaces so multi-line conditions
// match regardless of formatting.
function flatten(src: string): string {
  return src.replace(/\s+/g, " ");
}

const raw = readFileSync(PIPELINE, "utf8");
const code = stripComments(raw);
const flat = flatten(code);

type R = { name: string; ok: boolean; detail?: string };
const results: R[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Reason union carries the backstop code ───────────────────────────────
check(
  'refusal reason union includes "SYMBOL_NOT_IN_ARX_FOCUS"',
  /\|\s*"SYMBOL_NOT_IN_ARX_FOCUS"/.test(flat),
);

// ── 2. PREFLIGHT backstop: entry-only AND !approved → SYMBOL_NOT_IN_ARX_FOCUS ─
// Tail of the block: the symbol guard returning the focus refusal.
const preflightTail =
  /!isApprovedArxMarket\(input\.symbol\)\s*\)\s*\{\s*return\s*\{\s*ok:\s*false,\s*reason:\s*"SYMBOL_NOT_IN_ARX_FOCUS"/.test(
    flat,
  );
// The same condition must be entry-only: both new-entry command types appear
// in the ~200 chars preceding the symbol guard.
const preflightHeadIdx = flat.indexOf("!isApprovedArxMarket(input.symbol)");
const preflightHead =
  preflightHeadIdx !== -1 &&
  (() => {
    const w = flat.slice(Math.max(0, preflightHeadIdx - 220), preflightHeadIdx);
    return (
      /input\.commandType === "PLACE_LIVE_MARKET_ORDER"/.test(w) &&
      /input\.commandType === "PLACE_LIVE_PENDING_ORDER"/.test(w)
    );
  })();
check(
  "preflight gates entry-only && !isApprovedArxMarket → SYMBOL_NOT_IN_ARX_FOCUS",
  preflightTail && preflightHead,
  `tail=${preflightTail} head=${preflightHead}`,
);

// ── 3. DISPATCH backstop: isEntryRow && !approved → SYMBOL_NOT_IN_ARX_FOCUS: ──
const dispatch = flat.match(
  /if \(isEntryRow && !isApprovedArxMarket\(row\.symbol\)\) \{ const reason = `SYMBOL_NOT_IN_ARX_FOCUS:/,
);
check(
  "dispatch gates isEntryRow && !isApprovedArxMarket → SYMBOL_NOT_IN_ARX_FOCUS",
  dispatch != null,
);
// isEntryRow itself must be defined as the two entry command types only.
check(
  "isEntryRow is the two new-entry command types only",
  /const isEntryRow = row\.commandType === "PLACE_LIVE_MARKET_ORDER" \|\| row\.commandType === "PLACE_LIVE_PENDING_ORDER";/.test(
    flat,
  ),
);

// ── 4. EXEMPTION: exactly two backstop sites; ops types never symbol-gated ────
const approvedCalls = (code.match(/isApprovedArxMarket\(/g) ?? []).length;
check(
  "exactly two isApprovedArxMarket() call-sites (preflight + dispatch)",
  approvedCalls === 2,
  `found=${approvedCalls}`,
);

// No isApprovedArxMarket gate may have an ops command type in its condition.
// Scan a window around every isApprovedArxMarket usage and assert no ops type
// name appears next to it.
const OPS_TYPES = ["CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"];
let opsGated = false;
let idx = flat.indexOf("isApprovedArxMarket(");
while (idx !== -1) {
  const window = flat.slice(Math.max(0, idx - 160), idx + 40);
  if (OPS_TYPES.some((t) => window.includes(t))) opsGated = true;
  idx = flat.indexOf("isApprovedArxMarket(", idx + 1);
}
check(
  "no ops command type (close/modify) is ever a condition on the symbol backstop",
  !opsGated,
);

// ── 5. Helper imported from the single source of truth ──────────────────────
check(
  "isApprovedArxMarket imported from @workspace/domain/market",
  /import \{[^}]*isApprovedArxMarket[^}]*\} from "@workspace\/domain\/market";/.test(
    flat,
  ),
);

// ── Summary ──────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
// eslint-disable-next-line no-console
console.log(`\n${pass}/${results.length} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
