// C8 ONE-SHOT LEDGER — the durable half of "there is no second spin".
//
// WHAT WAS WRONG, AND WHY THIS FILE EXISTS
// -----------------------------------------
// `TransferProofHarness` enforces the no-respin rule with three private
// in-memory fields (`records`, `retiredOnData`, `retiredSpecs`). Those are
// correct and they are also per-process: `new TransferProofHarness()` starts
// with an empty `retiredOnData`. The C8 CLI constructs a fresh harness on every
// invocation, so a MISS retired nothing that outlived the process, and the
// "permanently refuses re-evaluation of the same spec on the same data"
// property the runbook stated as fact could be defeated by pressing the up
// arrow and hitting enter again.
//
// That is the worst possible shape for a safety claim: the guarantee is
// asserted loudly, believed, and absent. A pre-registered one-shot experiment
// whose shot can be re-taken is not a one-shot experiment — it is a search over
// verdicts with a stern comment on top.
//
// WHAT THIS DOES AND WHAT IT HONESTLY DOES NOT
// ---------------------------------------------
// The ledger is an append-only JSON-lines file keyed on
// `${specHash}|${dataFingerprint}` — the same pair the in-memory rule uses. The
// CLI reads it BEFORE seeking a verdict and refuses if the pair appears; it
// appends a VERDICT_INTENT row BEFORE calling `verdict()` and a VERDICT row
// after, so a process killed mid-press still leaves the pair spent. Fail-closed
// throughout: an unreadable ledger, an unparsable line, or a failed append all
// REFUSE rather than proceed. Not being able to read the record of the shot is
// not permission to take it again.
//
// What it is not: it is a file. Someone with a shell can delete it, and this
// module cannot stop them. What it changes is that re-spinning now requires
// deliberately destroying a committed record — a visible act in git history —
// instead of happening by accident to someone who re-ran a command. That is the
// honest description of the property, and it is the one the runbook now makes.
//
// Pure parsing + formatting. All I/O is the caller's; nothing here reads a
// clock, a network, or an environment variable.

export const VERDICT_LEDGER_FORMAT = "arx-c8-verdict-ledger-v1";

/** Repo-relative default. Committed, so destroying a shot record shows in a diff. */
export const DEFAULT_VERDICT_LEDGER = "docs/c8-data/verdict-ledger.jsonl";

export type VerdictLedgerKind = "VERDICT_INTENT" | "VERDICT";

export interface VerdictLedgerEntry {
  format: typeof VERDICT_LEDGER_FORMAT;
  /**
   * INTENT is written before `verdict()` is called and is enough on its own to
   * mark the pair spent — a crash between the two rows must not hand the shot
   * back.
   */
  kind: VerdictLedgerKind;
  experimentKey: string;
  specHash: string;
  dataFingerprint: string;
  /** The caller-supplied ISO instant. This module never reads a clock. */
  at: string;
  /** Present only on a VERDICT row. */
  verdict?: string;
  detail?: string;
  /** Where the full evidence file was written. */
  evidence?: string;
}

/** The no-respin key: one spec, one dataset, one shot. */
export function ledgerKey(specHash: string, dataFingerprint: string): string {
  return `${specHash}|${dataFingerprint}`;
}

export type VerdictLedgerParse =
  | { ok: true; entries: VerdictLedgerEntry[] }
  | { ok: false; detail: string };

/**
 * Parse the whole ledger. A malformed line is a REFUSAL for the entire file,
 * never a skipped line: a corrupt ledger read as "no matching entry" is exactly
 * how a spent shot would be handed back.
 */
export function parseVerdictLedger(text: string): VerdictLedgerParse {
  const entries: VerdictLedgerEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, detail: `line ${i + 1} is not JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    const o = parsed as Partial<VerdictLedgerEntry>;
    if (o?.format !== VERDICT_LEDGER_FORMAT) {
      return { ok: false, detail: `line ${i + 1} has format ${String(o?.format)}, expected ${VERDICT_LEDGER_FORMAT}` };
    }
    if (o.kind !== "VERDICT_INTENT" && o.kind !== "VERDICT") {
      return { ok: false, detail: `line ${i + 1} has kind ${String(o.kind)}` };
    }
    for (const k of ["experimentKey", "specHash", "dataFingerprint", "at"] as const) {
      if (typeof o[k] !== "string" || o[k]!.length === 0) {
        return { ok: false, detail: `line ${i + 1} is missing ${k}` };
      }
    }
    entries.push(o as VerdictLedgerEntry);
  }
  return { ok: true, entries };
}

/**
 * The prior row that already spent this shot, or null. An INTENT row counts:
 * the shot is spent the moment the press begins, not when it finishes.
 */
export function findSpentShot(
  entries: readonly VerdictLedgerEntry[],
  specHash: string,
  dataFingerprint: string,
): VerdictLedgerEntry | null {
  const key = ledgerKey(specHash, dataFingerprint);
  return entries.find((e) => ledgerKey(e.specHash, e.dataFingerprint) === key) ?? null;
}

/** One entry as the exact bytes to append: canonical key order, one line, newline-terminated. */
export function serialiseLedgerEntry(entry: VerdictLedgerEntry): string {
  const ordered: Record<string, unknown> = {
    format: entry.format,
    kind: entry.kind,
    experimentKey: entry.experimentKey,
    specHash: entry.specHash,
    dataFingerprint: entry.dataFingerprint,
    at: entry.at,
  };
  if (entry.verdict !== undefined) ordered.verdict = entry.verdict;
  if (entry.detail !== undefined) ordered.detail = entry.detail;
  if (entry.evidence !== undefined) ordered.evidence = entry.evidence;
  return JSON.stringify(ordered) + "\n";
}

/** Human-readable one-liner for the refusal message. */
export function describeLedgerEntry(entry: VerdictLedgerEntry): string {
  const outcome =
    entry.kind === "VERDICT"
      ? `verdict ${entry.verdict ?? "(unrecorded)"}`
      : "the press BEGAN and no outcome row followed (a crash mid-shot still spends the shot)";
  return (
    `${entry.at}  ${entry.experimentKey}  spec ${entry.specHash.slice(0, 12)}  data ${entry.dataFingerprint.slice(0, 12)}  ` +
    `${outcome}${entry.evidence !== undefined ? `  evidence ${entry.evidence}` : ""}`
  );
}
