// Provenance no-collapse guard (R4 slice 8 — audit-marketdata §3.1, spec §10.1).
//
// WHY THIS GUARD EXISTS
// ---------------------
// The audit's single most dangerous latent defect: serving-layer candle
// stores keyed by BARE `symbol|timeframe` collapse bars across broker
// accounts/bridges — two bridges pushing XAUUSD M5 overwrite each other and
// the router serves the blend to everyone as "the" broker feed. Wave 3 fixed
// the in-memory mt5Provider store by partitioning it per bridge. This guard
// is the ratchet that stops the pre-wave-3 pattern from coming back anywhere
// under api-server's lib/data.
//
// WHAT IT SCANS
// -------------
// Every live (non-test) .ts file under artifacts/api-server/src/lib/data for
// template-literal store keys of the codebase's pipe-joined key convention:
// an interpolation mentioning "sym…" immediately pipe-joined to one
// mentioning "tf"/"timeframe" (e.g. `${symbol}|${timeframe}`,
// `${normalizeSymbolKey(symbol)}|${normalizeTf(timeframe)}`,
// `${symbol}|${timeframe}|${limit}`). Comments are blanked first (reusing
// check-no-fabrication's scanner) so documentation of the pattern never
// counts. Colon/space-joined identifiers (sourceIds, log lines) do not match.
//
// CLASSIFICATION of every hit:
//   1. "bridge_keyed"       — the key's own line carries a bridge/connection/
//      account token (identity is IN the key) → PASS.
//   2. "bridge_partitioned" — the FILE declares a nested per-bridge partition
//      (a map-of-maps `new Map<string, Map<…` plus a bridgeConnectionId/
//      bridgeKey token): the symbol|timeframe key is applied INSIDE a bridge
//      partition (the wave-3 mt5Provider shape) → PASS, but PINNED: the exact
//      hit count per file is asserted below, so a NEW bare key added to a
//      partitioned file still fails until deliberately reviewed.
//   3. "bare"               — everything else → must appear in ALLOWLIST with
//      a PINNED count and a verified display/diagnostic-only reason, or the
//      check FAILS.
//
// The pins are a ratchet, not an amnesty (same discipline as
// check-no-fabrication): a count going UP means the pattern spread; a count
// going DOWN means a site was cleaned but the pin left loose. Either way this
// file must be edited deliberately in a reviewed commit. Stale entries
// (file gone / zero hits) also fail.
//
// SCOPE BOUNDARY (honest statement): this is a TEXTUAL guard over the
// pipe-joined key convention in lib/data. It cannot see a bare key built with
// string concatenation or a differently-delimited convention, and the
// partition evidence is file-granular, not per-store. It is a tripwire on the
// known failure shape, not a proof of provenance correctness — the runtime
// proof lives in __qa__/bridgeScopedCandleServing.test.ts.

import { join } from "node:path";
import { walk, read, rel, ROOT, type CheckResult } from "./_lib.js";
import { blankComments } from "./check-no-fabrication.js";

export const DATA_DIR = join(
  ROOT,
  "artifacts/api-server/src/lib/data",
);

// ── Detection ────────────────────────────────────────────────────────────────

/** Adjacent pipe-joined `${…sym…}|${…tf…}` pair — the store-key convention. */
const SYMBOL_TF_KEY_RE = /\$\{[^}]*sym[^}]*\}\|\$\{[^}]*(?:timeframe|tf)[^}]*\}/gi;

/** Identity tokens that make a key (or its line) bridge-aware. */
const BRIDGE_TOKEN_RE = /bridge|connection|account/i;

/** File-level evidence of the wave-3 partition shape: a nested map-of-maps
 *  store plus an explicit bridge-identity token. */
const NESTED_MAP_RE = /new\s+Map<\s*string\s*,\s*Map</;
const PARTITION_ID_RE = /bridgeConnectionId|bridgeKey/;

export type HitClassification = "bridge_keyed" | "bridge_partitioned" | "bare";

export interface SymbolTfKeyHit {
  /** 1-indexed line in the original source. */
  line: number;
  /** The matched key fragment. */
  match: string;
  /** The full original line, trimmed. */
  text: string;
  classification: HitClassification;
}

/** Whether the file shows the nested per-bridge partition shape. Evaluated on
 *  comment-blanked source so prose cannot manufacture evidence. */
export function hasBridgePartitionEvidence(src: string): boolean {
  const blanked = blankComments(src);
  return NESTED_MAP_RE.test(blanked) && PARTITION_ID_RE.test(blanked);
}

/**
 * Pure analyzer: find and classify every symbol|timeframe template key in one
 * source text. Exported for the fixture-driven regression test.
 */
export function analyzeSymbolTfKeys(src: string): SymbolTfKeyHit[] {
  const blanked = blankComments(src);
  const partitioned = NESTED_MAP_RE.test(blanked) && PARTITION_ID_RE.test(blanked);
  const originalLines = src.split("\n");

  const hits: SymbolTfKeyHit[] = [];
  SYMBOL_TF_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SYMBOL_TF_KEY_RE.exec(blanked)) !== null) {
    const line = blanked.slice(0, m.index).split("\n").length;
    const lineText = (originalLines[line - 1] ?? "").trim();
    let classification: HitClassification;
    if (BRIDGE_TOKEN_RE.test(lineText)) {
      classification = "bridge_keyed";
    } else if (partitioned) {
      classification = "bridge_partitioned";
    } else {
      classification = "bare";
    }
    hits.push({ line, match: m[0], text: lineText, classification });
  }
  return hits;
}

// ── Pins ─────────────────────────────────────────────────────────────────────

export interface PinEntry {
  /** Repo-relative path (as `rel()` produces). */
  file: string;
  /** EXACT number of hits of the pinned classification expected. */
  count: number;
  /** Why this is verified safe. Reviewed prose, not decoration. */
  reason: string;
}

/** Files whose symbol|timeframe keys are applied inside a per-bridge
 *  partition (classification "bridge_partitioned"). Pinned exactly. */
export const PARTITIONED_PINS: PinEntry[] = [
  {
    file: "artifacts/api-server/src/lib/data/providers/mt5Provider.ts",
    count: 1,
    reason:
      "Wave-3 bridge-scoped store: seriesKey() is applied INSIDE a per-bridge " +
      "partition (Map<bridgeKey → Map<symbol|tf → series>>); reads never blend " +
      "across partitions (proven by __qa__/bridgeScopedCandleServing.test.ts).",
  },
];

/** Verified display/diagnostic-only bare keys. Each entry was individually
 *  read and confirmed to serve NO candle/quote payload to any decision or
 *  display consumer keyed by that map — pinned exactly. */
export const ALLOWLIST: PinEntry[] = [
  {
    file: "artifacts/api-server/src/lib/data/mt5FeedStalenessWatchdogCore.ts",
    count: 1,
    reason:
      "Stale-episode alert dedupe state (owner notifications). Stores alert " +
      "bookkeeping, never bars. NOTE: alerts are per symbol|timeframe across " +
      "all bridges — acceptable for a notification, revisit with multi-bridge.",
  },
  {
    file: "artifacts/api-server/src/lib/data/chart/sessionProfile.ts",
    count: 1,
    reason:
      "Weekly presence-profile cache (which weekly slots have bars) used for " +
      "session-aware completeness display. Statistical metadata, not served " +
      "bars. NOTE: built from broker_candles across all bridges of a symbol — " +
      "a completeness heuristic, never a price source.",
  },
  {
    file: "artifacts/api-server/src/lib/data/chart/chartIntelligence.ts",
    count: 2,
    reason:
      "Fast Brain chart-intelligence state cache (read-only summary; the file " +
      "itself states it is not a decision/fork engine and the chart never " +
      "executes from this state). Caches derived commentary, not bars.",
  },
  {
    file: "artifacts/api-server/src/lib/data/chart/formingBarComposer.ts",
    count: 1,
    reason:
      "Display-only forming-tip state, documented never persisted and never " +
      "analysis input (audit §1.1 fn 6). The forming bar is synthesized from " +
      "the live EA tick stream for chart display only.",
  },
];

// ── Check ────────────────────────────────────────────────────────────────────

export interface CheckOverrides {
  /** Test seams — production runs use the module constants. */
  allowlist?: PinEntry[];
  partitionedPins?: PinEntry[];
  dataDir?: string;
}

export function checkProvenanceNoCollapse(overrides: CheckOverrides = {}): CheckResult {
  const allowlist = overrides.allowlist ?? ALLOWLIST;
  const partitionedPins = overrides.partitionedPins ?? PARTITIONED_PINS;
  const dataDir = overrides.dataDir ?? DATA_DIR;

  const violations: string[] = [];
  const notes: string[] = [];

  const files = walk(dataDir, {
    skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts"),
  });

  const allowByFile = new Map(allowlist.map((e) => [e.file, e]));
  const partByFile = new Map(partitionedPins.map((e) => [e.file, e]));
  const seenAllow = new Set<string>();
  const seenPart = new Set<string>();
  let totalHits = 0;

  for (const p of files) {
    const r = rel(p);
    const hits = analyzeSymbolTfKeys(read(p));
    if (hits.length === 0) continue;
    totalHits += hits.length;

    const bridgeKeyed = hits.filter((h) => h.classification === "bridge_keyed");
    const partitionedHits = hits.filter((h) => h.classification === "bridge_partitioned");
    const bare = hits.filter((h) => h.classification === "bare");

    if (bridgeKeyed.length > 0) {
      notes.push(`${r}: ${bridgeKeyed.length} bridge-keyed symbol|tf key(s) ✓`);
    }

    if (partitionedHits.length > 0) {
      const pin = partByFile.get(r);
      if (!pin) {
        violations.push(
          `${r}: ${partitionedHits.length} symbol|timeframe key(s) in a bridge-partitioned file, ` +
            `but the file is not pinned in PARTITIONED_PINS — add a reviewed pin ` +
            `(first at line ${partitionedHits[0].line}: ${partitionedHits[0].text})`,
        );
      } else {
        seenPart.add(r);
        if (partitionedHits.length !== pin.count) {
          violations.push(
            `${r}: bridge-partitioned symbol|tf key count drifted — pinned ${pin.count}, found ` +
              `${partitionedHits.length}. Review the change, then update the pin deliberately.`,
          );
        } else {
          notes.push(`${r}: ${partitionedHits.length} partition-scoped key(s), pin exact ✓`);
        }
      }
    }

    if (bare.length > 0) {
      const entry = allowByFile.get(r);
      if (!entry) {
        for (const h of bare) {
          violations.push(
            `${r}:${h.line}: serving-layer store keyed by bare symbol|timeframe with no ` +
              `bridge/connection identity — the account-collapse shape (audit §3.1). ` +
              `Key the store by bridge identity (see providers/mt5Provider.ts), or, ONLY if ` +
              `verified display/diagnostic-only, add a reviewed ALLOWLIST pin. Line: ${h.text}`,
          );
        }
      } else {
        seenAllow.add(r);
        if (bare.length !== entry.count) {
          violations.push(
            `${r}: allowlisted bare symbol|tf key count drifted — pinned ${entry.count}, found ` +
              `${bare.length}. ${bare.length > entry.count ? "The pattern spread" : "A site was cleaned but the pin left loose"}; ` +
              `update the pin deliberately.`,
          );
        } else {
          notes.push(`${r}: ${bare.length} allowlisted display/diagnostic key(s), pin exact ✓`);
        }
      }
    }
  }

  // Stale pins rot allowlists into rubber stamps — fail them.
  for (const e of allowlist) {
    if (!seenAllow.has(e.file)) {
      violations.push(
        `Stale ALLOWLIST pin: ${e.file} has no bare symbol|timeframe keys (deleted or fixed) — remove the pin.`,
      );
    }
  }
  for (const e of partitionedPins) {
    if (!seenPart.has(e.file)) {
      violations.push(
        `Stale PARTITIONED_PINS pin: ${e.file} has no partition-scoped symbol|timeframe keys — remove the pin.`,
      );
    }
  }

  notes.push(`Scanned ${files.length} live file(s) under lib/data; ${totalHits} symbol|tf key(s) classified.`);

  return {
    name: "provenance-no-collapse",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
