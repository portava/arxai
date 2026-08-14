import {
  type DataIntegrityVerdict, type DataIntegrityIssue, clampNonNegative,
} from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Data Integrity — check the latest tick stream window for gaps,
// duplicates, out-of-order, staleness, corrupt prices. Returns the FIRST
// detected issue (severity-ordered). Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface Tick {
  tsMs: number;
  bid: number;
  ask: number;
}
export interface IntegrityInput {
  ticks: ReadonlyArray<Tick>;
  nowMs: number;
  expectedTickIntervalMs: number;     // typical interval
  staleAfterMs?: number;              // default 5× expected
}

export function checkDataIntegrity(input: IntegrityInput): DataIntegrityVerdict {
  const reasons: string[] = []; const blockers: string[] = [];
  const stale = input.staleAfterMs ?? 5 * input.expectedTickIntervalMs;
  if (input.ticks.length === 0) {
    blockers.push(`no ticks — feed empty`);
    return { issue: "STALE_FEED", trustworthy: false, staleMs: stale, reasons: [`empty tick window`], blockers };
  }
  const last = input.ticks[input.ticks.length - 1]!;
  const staleMs = clampNonNegative(input.nowMs - last.tsMs);
  let issue: DataIntegrityIssue = "NONE";

  // Severity order: CORRUPT > STALE > GAP > OUT_OF_ORDER > DUPLICATE.
  for (const t of input.ticks) {
    if (!Number.isFinite(t.bid) || !Number.isFinite(t.ask) || t.bid <= 0 || t.ask <= 0 || t.ask < t.bid) {
      issue = "CORRUPT_PRICE";
      blockers.push(`corrupt tick at ${t.tsMs}: bid ${t.bid}, ask ${t.ask}`);
      break;
    }
  }
  if (issue === "NONE" && staleMs > stale) {
    issue = "STALE_FEED";
    blockers.push(`feed stale ${staleMs}ms > ${stale}ms`);
  }
  if (issue === "NONE") {
    for (let i = 1; i < input.ticks.length; i++) {
      const dt = input.ticks[i]!.tsMs - input.ticks[i - 1]!.tsMs;
      if (dt < 0) { issue = "OUT_OF_ORDER"; blockers.push(`out-of-order at index ${i}`); break; }
      if (dt === 0 && input.ticks[i]!.bid === input.ticks[i - 1]!.bid && input.ticks[i]!.ask === input.ticks[i - 1]!.ask) {
        issue = "DUPLICATE_TICK"; reasons.push(`duplicate tick at index ${i}`); break;
      }
      if (dt > 5 * input.expectedTickIntervalMs) {
        issue = "GAP"; reasons.push(`gap ${dt}ms at index ${i} > 5× expected ${input.expectedTickIntervalMs}ms`); break;
      }
    }
  }
  reasons.push(`window ${input.ticks.length} ticks · last age ${staleMs}ms · issue ${issue}`);
  const trustworthy = issue === "NONE" || issue === "DUPLICATE_TICK";
  return { issue, trustworthy, staleMs, reasons, blockers };
}
