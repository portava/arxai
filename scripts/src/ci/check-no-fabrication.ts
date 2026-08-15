// Fabrication ban — no invented numbers on the market-data / intelligence path.
//
// WHY THIS GUARD EXISTS
// ---------------------
// P0-4 found three trader-facing pages serving `Math.random()` as live market
// data: an invented VIX, an invented 10Y yield, invented per-index confidence,
// invented index price levels, and — worst — a "Recommended Lot Size" computed
// from a fabricated volatility reading, all on a 30-second refresh so the made-up
// numbers visibly "moved" like a feed. Fixing those call sites is necessary but
// not sufficient: nothing stopped the next one. This guard is the ratchet.
//
// It enforces two different, deliberately separate rules:
//
//   1. PROTECTED files — the modules and pages that P0-4 made honest — may
//      contain NO `Math.random(` and NO `Date.now(` in live code, at all.
//      Banning the clock alongside the RNG is not incidental: a payload that
//      stamps itself `asOf: Date.now()` forges FRESHNESS the same way
//      `Math.random()` forges a READING. Both make an empty answer look like an
//      observation. Where these modules genuinely need the wall clock they take
//      it as an injectable parameter (`detectForexSession(now: Date = new Date())`),
//      which stays testable and stays honest.
//
//   2. SWEPT scope — all live (non-test) code under the api-server's `lib/` and
//      `routes/` trees. Every `Math.random(` occurrence must be either
//      (a) ID-SHAPED, matching one of two narrow, documented patterns that can
//          only produce an identifier or nonce — never a quantity, or
//      (b) named in QUARANTINE below with a PINNED occurrence count and a reason.
//      Anything else fails the build. A brand-new `cryptoIntelligence.ts` that
//      invents a price cannot land without someone editing this file.
//
// The pins are what make QUARANTINE a ratchet rather than an amnesty. The guard
// fails if a quarantined file's count goes UP (fabrication spread) and equally
// if it goes DOWN (a site was cleaned up but the pin was left loose, which would
// silently re-open that budget for the next author). Either way the number in
// this file must be edited deliberately, in a commit someone reviews.
//
// SCOPE BOUNDARY (honest statement of what this does NOT cover): the sweep is
// the api-server lib/routes trees — the layer that PRODUCES data. The dashboard
// is covered only at the specific pages listed in PROTECTED. Test files
// (`__qa__/`, `*.test.ts`) are excluded: they randomise fixtures on purpose and
// ship to nobody.

import { walk, read, rel, reportResult, ROOT, type CheckResult } from "./_lib.js";
import { join } from "node:path";

// ── The tokens that fabricate ───────────────────────────────────────────────
export const RNG_TOKEN = "Math.random(";
export const CLOCK_TOKEN = "Date.now(";

export interface FabricationHit {
  /** 1-indexed line number in the ORIGINAL source. */
  line: number;
  /** Character offset of the occurrence within the comment-blanked source. */
  offset: number;
  /** Which token was found. */
  token: string;
  /** The original (un-stripped) line, trimmed. */
  text: string;
  /**
   * Name of the identifier shape this exact occurrence matches, or `null` if it
   * is unconstrained — i.e. capable of producing a quantity.
   */
  idShape: string | null;
}

/**
 * Blank out comment bodies while preserving every byte offset and newline, so
 * line numbers computed against the result still point at the real source.
 *
 * This matters because the P0-4 fix deliberately left `Math.random()` in PROSE:
 * `indicesIntelligence.ts` documents the exact formulas it deleted
 * (`14 + Math.random() * 8`), and `forex-center.tsx` does the same. That
 * documentation is the most valuable comment in the file and a guard that
 * punished it would just get the history deleted. Only executable code counts.
 *
 * The scanner tracks single-quoted, double-quoted and template strings so a
 * `//` inside a URL literal is not mistaken for a comment. Regex literals are
 * NOT tracked (distinguishing `/` division from a regex needs a real parser);
 * the failure mode is a regex containing an escaped `//`, which would blank the
 * rest of that one line. That can only ever HIDE a hit, never invent one, and
 * no such line exists in the swept scope today — see the `notes` sanity count
 * this guard prints.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      i++;
      continue;
    }

    if (state === "line") {
      if (c === "\n") {
        state = "code";
        i++;
        continue;
      }
      out[i] = " ";
      i++;
      continue;
    }

    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }

    // Inside a string literal: honour escapes, do not blank anything.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (
      (state === "sq" && c === "'") ||
      (state === "dq" && c === '"') ||
      (state === "tpl" && c === "`")
    ) {
      state = "code";
    }
    i++;
  }

  return out.join("");
}

/**
 * The ONLY two shapes of `Math.random()` allowed without an explicit quarantine
 * entry. Both are deliberately narrow: each one can produce an identifier or a
 * nonce and nothing else. Neither can yield a price, a level, a percentage, a
 * confidence, a volatility, or a size.
 *
 * Anything broader — `Math.floor(Math.random() * someArray.length)`,
 * `(Math.random() - 0.5) * price` — is NOT id-shaped and must be quarantined by
 * name, even when it turns out to be benign. The point is that a human wrote
 * down why.
 *
 * These are matched PER OCCURRENCE, anchored at the `Math.random(` itself —
 * never against the whole line. Line-level matching is a laundering hole: one
 * legitimate `Math.random().toString(36)` would exempt an invented price
 * sharing the same line, which is precisely the sort of thing a one-line
 * "cleanup" produces by accident.
 */
export const ID_SHAPES: Array<{
  name: string;
  /** Matched against the code starting AT the occurrence. */
  after: RegExp;
  /** Matched against the code immediately BEFORE the occurrence, if set. */
  before?: RegExp;
}> = [
  { name: "base36-id", after: /^Math\.random\(\)\s*\.toString\(\s*36\s*\)/ },
  {
    name: "hex-id",
    after: /^Math\.random\(\)\s*\*\s*0x[0-9a-fA-F]+\s*\)\s*\.toString\(\s*16\s*\)/,
    before: /Math\.floor\(\s*$/,
  },
];

/** Classify one occurrence at `offset` within comment-blanked `code`. */
export function idShapeAt(code: string, offset: number): string | null {
  const after = code.slice(offset, offset + 160);
  const before = code.slice(Math.max(0, offset - 40), offset);
  for (const s of ID_SHAPES) {
    if (!s.after.test(after)) continue;
    if (s.before && !s.before.test(before)) continue;
    return s.name;
  }
  return null;
}

/** Find every occurrence of `token` in live (non-comment) code. */
export function findHits(src: string, token: string): FabricationHit[] {
  const code = blankComments(src);
  const originalLines = src.split("\n");
  const hits: FabricationHit[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf(token, from);
    if (at === -1) break;
    const line = code.slice(0, at).split("\n").length;
    hits.push({
      line,
      offset: at,
      token,
      text: (originalLines[line - 1] ?? "").trim(),
      idShape: token === RNG_TOKEN ? idShapeAt(code, at) : null,
    });
    from = at + token.length;
  }
  return hits;
}

/**
 * Convenience for tests and one-line reasoning: is the FIRST `Math.random(`
 * occurrence in this snippet id-shaped?
 */
export function isIdShaped(snippet: string): boolean {
  const hits = findHits(snippet, RNG_TOKEN);
  return hits.length > 0 && hits[0].idShape !== null;
}

// ── Rule 1: files that must contain neither token ───────────────────────────
// These are the surfaces P0-4 made honest. Zero tolerance, both tokens.
export const PROTECTED = [
  "artifacts/api-server/src/lib/forexIntelligence.ts",
  "artifacts/api-server/src/lib/indicesIntelligence.ts",
  "artifacts/api-server/src/routes/intelligence.ts",
  "artifacts/trading-dashboard/src/pages/forex-center.tsx",
  "artifacts/trading-dashboard/src/pages/indices-center.tsx",
  "artifacts/trading-dashboard/src/pages/synthetic-center.tsx",
  "artifacts/trading-dashboard/src/pages/stocks-center.tsx",
];

// ── Rule 2: the swept trees ─────────────────────────────────────────────────
export const SWEPT_ROOTS = [
  "artifacts/api-server/src/lib",
  "artifacts/api-server/src/routes",
];

/** Test fixtures randomise on purpose and ship to nobody. */
export function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("/__qa__/") ||
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".test.tsx")
  );
}

/**
 * Known `Math.random()` sites in the swept trees that are NOT id-shaped, each
 * pinned to an exact occurrence count. The pin must match exactly — too many
 * means fabrication spread, too few means a pin went stale and quietly re-opened
 * budget for the next author.
 *
 * Every entry here is a debt, not a blessing. The two candle synthesisers are
 * the real ones and are logged as P1 follow-ups.
 */
export const QUARANTINE: Record<string, { count: number; why: string }> = {
  "artifacts/api-server/src/lib/strategyEngine.ts": {
    count: 4,
    why:
      "P1 DEBT: generateSyntheticCandles() invents OHLCV bars for demo mode. Real " +
      "fabricated market data — scheduled for removal in the signals work order. " +
      "Pinned so it cannot grow.",
  },
  "artifacts/api-server/src/routes/tradeDecision.ts": {
    count: 4,
    why:
      "P1 DEBT: syntheticCandles() fallback mirrors the strategyEngine demo path " +
      "and feeds a trade DECISION. Same removal work order. Pinned so it cannot grow.",
  },
  "artifacts/api-server/src/lib/marketSimulator.ts": {
    count: 5,
    why:
      "Explicit simulator, not a feed. Containment is separately enforced by " +
      "check-mock-provider-live-feed and test:simulator-containment, which keep its " +
      "output off every live surface. Pinned so it cannot grow.",
  },
  "artifacts/api-server/src/lib/autopilot.ts": {
    count: 1,
    why:
      "Picks WHICH configured symbol to scan next — a scheduling choice over an " +
      "operator-supplied list, not a market reading. Produces no number that reaches " +
      "a price, size or confidence field.",
  },
  "artifacts/api-server/src/routes/learning.ts": {
    count: 2,
    why:
      "POST /learning/demo mints out-of-range int32 row ids (offset above the real " +
      "id range) for a demo payload. Identifiers, not quantities — but not " +
      "id-SHAPED by the two narrow patterns, so it is named here on purpose.",
  },
};

export type SourceFile = { path: string; src: string | null };

/**
 * Rule 1, pure: a PROTECTED honest-data surface may contain neither token in
 * live code. `src === null` means the file is gone, which is itself a finding —
 * the surface P0-4 made honest can't be allowed to quietly disappear.
 */
export function analyzeProtected(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { path, src } of files) {
    if (src === null) {
      violations.push(
        `${path} → PROTECTED file is missing; the honest-state surface it named was moved or deleted. Update PROTECTED deliberately.`,
      );
      continue;
    }
    for (const token of [RNG_TOKEN, CLOCK_TOKEN]) {
      for (const h of findHits(src, token)) {
        violations.push(
          `${path}:${h.line} → PROTECTED honest-data surface must contain no ${token}: ${h.text.slice(0, 120)}`,
        );
      }
    }
  }
  return violations;
}

/**
 * Rule 2, pure: every non-id-shaped `Math.random(` in the swept trees must be
 * quarantined at an exactly-matching pin. Drift in EITHER direction fails.
 */
export function analyzeSwept(
  files: Array<{ path: string; src: string }>,
  quarantine: Record<string, { count: number; why: string }>,
): string[] {
  const violations: string[] = [];
  const seen = new Map<string, number>();

  for (const { path, src } of files) {
    if (isTestFile(path)) continue;
    const notIdShaped = findHits(src, RNG_TOKEN).filter((h) => h.idShape === null);
    if (notIdShaped.length === 0) continue;

    if (!quarantine[path]) {
      for (const h of notIdShaped) {
        violations.push(
          `${path}:${h.line} → new ${RNG_TOKEN} on the market-data path, and it is not id-shaped: ${h.text.slice(0, 120)}`,
        );
      }
      continue;
    }
    seen.set(path, notIdShaped.length);
  }

  for (const [file, { count, why }] of Object.entries(quarantine)) {
    const actual = seen.get(file);
    if (actual === undefined) {
      violations.push(
        `${file} → quarantined for fabrication but no non-id-shaped ${RNG_TOKEN} was found (file moved, or cleaned up). Remove the QUARANTINE entry.`,
      );
      continue;
    }
    if (actual > count) {
      violations.push(
        `${file} → fabrication GREW: ${actual} non-id-shaped ${RNG_TOKEN} sites, pinned at ${count}. ${why}`,
      );
    } else if (actual < count) {
      violations.push(
        `${file} → pin is stale: ${actual} sites remain but pinned at ${count}. Tighten the pin to ${actual} so the budget cannot silently re-open.`,
      );
    }
  }
  return violations;
}

export function checkNoFabrication(): CheckResult {
  const notes: string[] = [];

  const protectedFiles: SourceFile[] = PROTECTED.map((p) => {
    try {
      return { path: p, src: read(join(ROOT, p)) };
    } catch {
      return { path: p, src: null };
    }
  });

  const sweptFileList: Array<{ path: string; src: string }> = [];
  for (const root of SWEPT_ROOTS) {
    for (const f of walk(join(ROOT, root), { exts: [".ts", ".tsx"] })) {
      sweptFileList.push({ path: rel(f), src: read(f) });
    }
  }

  const violations = [
    ...analyzeProtected(protectedFiles),
    ...analyzeSwept(sweptFileList, QUARANTINE),
  ];

  const protectedScanned = protectedFiles.filter((f) => f.src !== null).length;
  const sweptFiles = sweptFileList.filter((f) => !isTestFile(f.path)).length;

  notes.push(
    `Rule 1: ${protectedScanned}/${PROTECTED.length} protected honest-data surfaces scanned for ${RNG_TOKEN} and ${CLOCK_TOKEN} (comments excluded — the P0-4 fix documents the formulas it deleted).`,
  );
  notes.push(
    `Rule 2: swept ${sweptFiles} live file(s) under ${SWEPT_ROOTS.join(", ")}; ${Object.keys(QUARANTINE).length} file(s) quarantined with pinned counts.`,
  );
  notes.push(
    "Allowed without quarantine: only base36 and hex IDENTIFIER shapes. Nothing that can yield a price, level, confidence, volatility or size.",
  );

  return {
    name: "no-fabrication",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkNoFabrication();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
