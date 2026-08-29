// CI guard — admin-trading-no-live-bypass (Task #787).
//
// There are TWO guarded live-order pipelines in this codebase and BOTH end at
// the `mt5_commands` EA mailbox (the table the EA polls for status='PENDING'):
//
//   1. Phase B — canonical (`lib/live/liveCommandPipeline.ts`). A live draft
//      becomes an `arx_live_commands` row, traverses the 23-gate
//      `livePhaseBDispatchGate`, and ONLY on a positive PASS is mirrored into
//      `mt5_commands`. This is the sanctioned live delivery path — the contract.
//
//   2. adminTrading — parallel (`lib/adminTrading/`). `dispatchToBroker()` can
//      write a `mode:"LIVE"` / `requiredAccountType:"live"` PENDING row to
//      `mt5_commands`. Its runtime lock is the STRUCTURAL `bridge_token` gate in
//      `runOrderGuards()`, which hard-denies EVERY non-SIMULATED order reading NO
//      env var (LIVE → `LIVE_DISPATCH_DISABLED_USE_PHASE_B`, DEMO →
//      `DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE`). This is strictly stronger than
//      the old env-keyed `BRIDGE_TOKEN_UNSET` lock that a stray server-wide
//      `MT5_BRIDGE_TOKEN` could in principle unlock. It does NOT traverse the
//      Phase B 23-gate.
//
// The assistant + chart surfaces already have static no-direct-execution guards.
// The adminTrading path is structurally locked at gate #8. This guard locks the
// STATIC structure that keeps the adminTrading (and any future non-Phase-B) path
// from delivering a live trade to the EA mailbox outside the Phase B contract.
// A future edit that opened such a path fails the build.
//
// It enforces three invariants (all comment-stripped static scans):
//
//   INVARIANT 1 — Sole-writer allowlist (the catch-any-future-code net).
//     The set of non-test files that insert into `mt5_commands` must equal a
//     curated, reason-documented allowlist. A NEW insert site — a future quiet
//     second mailbox writer — fails the build until a human reviews it and adds
//     it (with its sanctioned classification). Both the typed-table insert
//     (`db.insert(mt5CommandsTable)`, incl. local `as` aliases) and a raw
//     `insert into mt5_commands` SQL are detected.
//
//   INVARIANT 2 — adminTrading dispatch stays gate-chained.
//     `placeOrder.ts` must run `runOrderGuards()` and reject anything that is
//     not APPROVED BEFORE it can reach `dispatchToBroker()`; and `orderGuard.ts`
//     must keep the STRUCTURAL `bridge_token` dispatch-lock gate. That gate now
//     hard-denies EVERY non-SIMULATED order regardless of any env var (LIVE →
//     `LIVE_DISPATCH_DISABLED_USE_PHASE_B`, DEMO →
//     `DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE`), so the legacy adminTrading path
//     can never reach `dispatchToBroker()`. This is strictly stronger than the
//     old env-keyed `BRIDGE_TOKEN_UNSET` lock, which a stray server-wide
//     `MT5_BRIDGE_TOKEN` could in principle unlock. The gate must therefore also
//     NEVER read `MT5_BRIDGE_TOKEN` to grant dispatch — a regression back to an
//     env-var unlock fails the build. If a future change drops the guard call,
//     the not-APPROVED short-circuit, the structural deny, or re-introduces the
//     env-var unlock, the adminTrading path could deliver live — build fails.
//
//   INVARIANT 3 — `dispatchToBroker` is import-confined.
//     The broker-placement primitive may be imported ONLY by `placeOrder.ts`
//     (its sole sanctioned caller). Any other module importing it could queue a
//     command bypassing `runOrderGuards()` entirely — build fails.
//
//   INVARIANT 4 — per-writer DELIVERABLE-LIVE semantics are locked.
//     Invariant 1 only catches a NEW writer file; it does NOT stop an existing
//     allowlisted writer from being *edited* into a deliverable LIVE path (e.g.
//     flipping a forced-BLOCKED status to PENDING, adding `mode:"LIVE"` /
//     `requiredAccountType:"live"`, or loosening an action constraint to open a
//     trade). So every allowlisted writer EXCEPT the two sanctioned live
//     pipelines (Phase B `liveCommandPipeline.ts` + the gated adminTrading
//     `brokerPlacement.ts`) must keep its documented non-LIVE shape: each of its
//     `mt5_commands` insert `.values({…})` blocks must NOT carry a live-delivery
//     token (`mode:"LIVE"` / `requiredAccountType:"live"`) and must NOT open a
//     trade (`action:"OPEN"`), plus the per-writer markers that make it provably
//     safe (forced `status='BLOCKED'`, `safetyMode:'paper_only'`, CLOSE-only,
//     `DEMO_MARKET_ORDER`, `RECONNECT`, the `FORBIDDEN_ACTIONS` enforcement, the
//     read-only short-circuit). A non-live writer with no semantic spec also
//     fails — a new allowlist entry must be classified.
//
//   INVARIANT 5 — deliverable-LIVE semantics are confined to the two pipelines.
//     Positive net: ANY non-test file whose `mt5_commands` insert `.values({…})`
//     carries a live-delivery token must be one of the two sanctioned
//     LIVE_SEMANTICS_WRITER_ALLOWLIST files. Only Phase B (post-23-gate) and the
//     gated adminTrading path (locked by invariants 2 & 3) may ever emit a
//     deliverable LIVE command; anything else fails the build.
//
// Out of scope (documented, deferred to human review, per the import-boundary
// escape-ladder doctrine shared with the assistant/chart guards): reflection /
// dynamic string-built table identifiers, multi-hop re-export laundering of the
// command table or `dispatchToBroker`, a mailbox write buried inside an
// arbitrary helper in a third file that an allowlisted file merely calls, and a
// raw `insert into mt5_commands` SQL whose VALUES list cannot be parsed for
// semantic shape (it is still caught as a writer by invariant 1). A static text
// scan cannot soundly resolve those without a full call-graph.
import { join } from "node:path";
import { walk, read, rel, ROOT, reportResult, type CheckResult } from "./_lib.js";

// ── Files permitted to insert into the mt5_commands EA mailbox ────────────────
// Every entry is reviewed and classified. Only the Phase B pipeline is a
// sanctioned DELIVERABLE LIVE writer; the rest are non-LIVE or forced-BLOCKED.
const MAILBOX_WRITER_ALLOWLIST: Record<string, string> = {
  // Phase B canonical pipeline — the ONLY sanctioned deliverable LIVE writer.
  // Mirrors arx_live_commands into mt5_commands only after the 23-gate PASS.
  "artifacts/api-server/src/lib/live/liveCommandPipeline.ts":
    "Phase B canonical pipeline (post-23-gate mirror) — the sanctioned live writer",
  // adminTrading broker placement — LIVE-capable but gated; locked by
  // INVARIANT 2 (runOrderGuards bridge_token gate) + INVARIANT 3 (import-confined).
  "artifacts/api-server/src/lib/adminTrading/brokerPlacement.ts":
    "adminTrading dispatchToBroker — gated by runOrderGuards; locked by invariants 2 & 3",
  // Forced-BLOCKED — queueCommand() always writes status='BLOCKED'; the EA poll
  // filters status='PENDING' so these are never deliverable.
  "artifacts/api-server/src/routes/mt5.ts":
    "queueCommand() forces status='BLOCKED' — never deliverable to the EA",
  // CLOSE only, paper_only — LIVE closes return early through the Phase B
  // pipeline above; this direct insert is DEMO/SIMULATED close only.
  "artifacts/api-server/src/routes/meTrades.ts":
    "CLOSE-only paper_only insert (LIVE returns early to Phase B)",
  // Generic safe command, paper_only — trade/OPEN actions are rejected by
  // FORBIDDEN_ACTIONS before this insert is reached.
  "artifacts/api-server/src/routes/meMt5Commands.ts":
    "createSafeCommand() paper_only insert; trade actions rejected by FORBIDDEN_ACTIONS",
  // Demo-only — action='DEMO_MARKET_ORDER'; the EA enforces ACCOUNT_TRADE_MODE==DEMO.
  "artifacts/api-server/src/routes/demoExecution.ts":
    "DEMO_MARKET_ORDER insert — demo-only, EA enforces demo account",
  // Operator reconnect — action='RECONNECT', not a trade; PENDING only when the
  // broker is armed for live and never carries symbol/side/lot.
  "artifacts/api-server/src/routes/brokerHealth.ts":
    "RECONNECT operator command — not a trade order",
};

// The two — and only two — pipelines permitted to emit a DELIVERABLE LIVE
// mt5_commands row. Phase B is post-23-gate; adminTrading brokerPlacement is
// LIVE-capable but locked by invariants 2 & 3. Every OTHER allowlisted writer
// must keep a provably non-LIVE shape (invariant 4) and no other file anywhere
// may emit live-delivery semantics into mt5_commands (invariant 5).
const LIVE_PIPELINE_WRITERS = new Set<string>([
  "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
  "artifacts/api-server/src/lib/adminTrading/brokerPlacement.ts",
]);
const LIVE_SEMANTICS_WRITER_ALLOWLIST = LIVE_PIPELINE_WRITERS;

// A live-delivery token inside an mt5_commands insert `.values({…})`: an EA
// instruction to execute against a LIVE/real broker account. `mode:"LIVE"` is
// the payload execution mode; `requiredAccountType:"live"` is what the EA checks
// before it will fill. Either makes the row a live broker command.
const LIVE_DELIVERY_TOKEN =
  /requiredAccountType\s*:\s*[^,}\n]*["']live["']|\bmode\s*:\s*["']LIVE["']/;

// Opening a trade — the highest-risk action. A non-LIVE writer must never carry
// it (closes reduce risk and are permitted; DEMO/RECONNECT are not opens).
const OPEN_ACTION_TOKEN = /\baction\s*:\s*["']OPEN["']/;

// Per-writer semantic spec for every allowlisted writer that is NOT one of the
// two LIVE pipelines. `fileRequire` = markers that must exist somewhere in the
// (comment-stripped) file; `blockRequire` = markers that must exist in EVERY
// mt5_commands insert `.values({…})` block; `blockForbid` = markers that must
// appear in NONE of those blocks (in addition to the always-applied
// LIVE_DELIVERY_TOKEN + OPEN_ACTION_TOKEN forbids).
type WriterSemantics = {
  fileRequire: { rx: RegExp; why: string }[];
  blockRequire: { rx: RegExp; why: string }[];
  blockForbid: { rx: RegExp; why: string }[];
};
const NON_LIVE_WRITER_SEMANTICS: Record<string, WriterSemantics> = {
  "artifacts/api-server/src/routes/mt5.ts": {
    fileRequire: [
      {
        rx: /const\s+status\s*=\s*["']BLOCKED["']\s+as\s+const/,
        why: "queueCommand() must force `const status = \"BLOCKED\" as const` so the EA poll (status='PENDING') never delivers it",
      },
    ],
    blockRequire: [
      {
        rx: /(^|[\s({,])status\s*,/,
        why: "the insert must bind the forced-BLOCKED `status` const via shorthand, not a literal deliverable status",
      },
    ],
    blockForbid: [
      {
        rx: /status\s*:\s*["']PENDING["']/,
        why: "the mt5_commands insert must never hardcode a deliverable status='PENDING'",
      },
    ],
  },
  "artifacts/api-server/src/routes/meTrades.ts": {
    fileRequire: [],
    blockRequire: [
      {
        rx: /\baction\s*:\s*["']CLOSE["']/,
        why: "the direct insert is CLOSE-only (LIVE opens return early through the Phase B pipeline)",
      },
      {
        rx: /\bsafetyMode\s*:\s*["']paper_only["']/,
        why: "the direct CLOSE insert must stay safetyMode='paper_only'",
      },
    ],
    blockForbid: [],
  },
  "artifacts/api-server/src/routes/meMt5Commands.ts": {
    fileRequire: [
      {
        rx: /FORBIDDEN_ACTIONS\s*=\s*new\s+Set/,
        why: "trade/OPEN actions must be rejected by the FORBIDDEN_ACTIONS set",
      },
      {
        rx: /FORBIDDEN_ACTIONS\.has\(/,
        why: "the FORBIDDEN_ACTIONS set must be enforced before any command is queued",
      },
    ],
    blockRequire: [
      {
        rx: /\bsafetyMode\s*:\s*["']paper_only["']/,
        why: "createSafeCommand() must stay safetyMode='paper_only'",
      },
    ],
    blockForbid: [],
  },
  "artifacts/api-server/src/routes/demoExecution.ts": {
    fileRequire: [
      {
        rx: /BLOCKED_READ_ONLY_MODE/,
        why: "demo execution must short-circuit a live/read-only request before inserting",
      },
    ],
    blockRequire: [
      {
        rx: /\baction\s*:\s*["']DEMO_MARKET_ORDER["']/,
        why: "the insert is demo-only (action='DEMO_MARKET_ORDER'); the EA enforces ACCOUNT_TRADE_MODE==DEMO",
      },
    ],
    blockForbid: [],
  },
  "artifacts/api-server/src/routes/brokerHealth.ts": {
    fileRequire: [],
    blockRequire: [
      {
        rx: /\baction\s*:\s*["']RECONNECT["']/,
        why: "the insert is an operator RECONNECT, not a trade order",
      },
    ],
    blockForbid: [],
  },
};

// Where a future mailbox writer could appear. lib/db only DEFINES the table.
const SCAN_ROOTS = ["artifacts/api-server/src", "lib"];

// A scanned path is treated as test/script (exempt) when it lives under any of
// these — tests legitimately seed mt5_commands directly.
function isTestOrScript(relPath: string): boolean {
  return (
    /(^|\/)__qa__\//.test(relPath) ||
    /(^|\/)scripts\//.test(relPath) ||
    /\.test\.tsx?$/.test(relPath) ||
    /\.spec\.tsx?$/.test(relPath)
  );
}

// Strip comments WITHOUT shifting line/column positions so a violation pinpoints
// the exact line in the original source. Block comments are blanked to spaces
// (newlines preserved); whole-line `//` comments become an empty (kept) line.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TABLE_SYMBOL = "mt5CommandsTable";

// Every local binding the file uses to refer to the command table: the canonical
// `mt5CommandsTable` plus any `import { mt5CommandsTable as X }` local alias.
function commandTableBindings(stripped: string): string[] {
  const bindings = new Set<string>([TABLE_SYMBOL]);
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    for (const spec of m[1].split(",")) {
      const mm = spec.trim().match(/^(\w+)\s+as\s+(\w+)$/);
      if (mm && mm[1] === TABLE_SYMBOL) bindings.add(mm[2]);
    }
  }
  return [...bindings];
}

// Does `stripped` contain an INSERT into the command table (typed-table insert
// via any binding, or a raw `insert into mt5_commands` SQL)?
export function findMailboxInserts(stripped: string): { line: number; token: string }[] {
  const bindings = commandTableBindings(stripped);
  const needles: RegExp[] = [
    ...bindings.map((b) => new RegExp(`\\.insert\\(\\s*${escapeRe(b)}\\s*\\)`)),
    /insert\s+into\s+["'`]?mt5_commands["'`]?/i,
  ];
  const out: { line: number; token: string }[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const rx of needles) {
      const mm = rx.exec(line);
      if (mm !== null) out.push({ line: i + 1, token: mm[0].trim() });
    }
  });
  return out;
}

// Does `stripped` import `dispatchToBroker` from a named import?
export function importsDispatchToBroker(stripped: string): boolean {
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    for (const spec of m[1].split(",")) {
      const name = spec.trim().split(/\s+as\s+/)[0]?.trim();
      if (name === "dispatchToBroker") return true;
    }
  }
  return false;
}

// Read a balanced `{…}` object literal starting at `src[openIdx] === "{"`,
// respecting single/double/backtick string literals (and escapes) so braces and
// commas inside strings never throw off the brace counter. Returns the literal
// (including the outer braces) or null if it never balances. A template literal
// is treated as an opaque string (its `${…}` interpolation is skipped wholesale);
// none of the scanned insert blocks nest a backtick inside an interpolation.
function readBalancedObject(src: string, openIdx: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr !== null) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

// Extract every `.insert(<binding>).values({…})` object literal written to the
// command table, with the 1-based source line of the `.insert(`. Only the typed
// drizzle insert is parseable for semantic shape; a raw SQL `insert into
// mt5_commands` carries no parseable values list (documented out-of-scope; still
// caught as a writer by invariant 1).
export function extractInsertValuesBlocks(
  stripped: string,
  bindings: string[],
): { line: number; block: string }[] {
  const out: { line: number; block: string }[] = [];
  for (const b of bindings) {
    const re = new RegExp(`\\.insert\\(\\s*${escapeRe(b)}\\s*\\)\\s*\\.values\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      let i = m.index + m[0].length;
      while (i < stripped.length && stripped[i] !== "{") i++;
      if (i >= stripped.length) continue;
      const block = readBalancedObject(stripped, i);
      if (block === null) continue;
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({ line, block });
    }
  }
  return out;
}

// Does an insert `.values({…})` block carry deliverable-LIVE semantics?
export function blockHasLiveDeliveryToken(block: string): boolean {
  return LIVE_DELIVERY_TOKEN.test(block);
}

const PLACE_ORDER = "artifacts/api-server/src/lib/adminTrading/placeOrder.ts";
const ORDER_GUARD = "artifacts/api-server/src/lib/adminTrading/orderGuard.ts";

export function checkAdminTradingNoLiveBypass(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // Gather every scanned non-test source file as repo-relative path → stripped.
  const files = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(join(ROOT, root))) {
      const relPath = rel(abs).replace(/\\/g, "/");
      if (isTestOrScript(relPath)) continue;
      try {
        files.set(relPath, stripComments(read(abs)));
      } catch {
        continue;
      }
    }
  }

  // ── INVARIANT 1 — sole-writer allowlist ────────────────────────────────────
  let writerCount = 0;
  for (const [relPath, stripped] of files) {
    const inserts = findMailboxInserts(stripped);
    if (inserts.length === 0) continue;
    writerCount++;
    if (!(relPath in MAILBOX_WRITER_ALLOWLIST)) {
      for (const ins of inserts) {
        violations.push(
          `${relPath}:${ins.line} writes the mt5_commands EA mailbox (\`${ins.token}\`) but is NOT an allowlisted writer — a new mailbox writer must traverse the Phase B 23-gate contract or be reviewed + added to MAILBOX_WRITER_ALLOWLIST`,
        );
      }
    }
  }
  // Allowlisted files that no longer write the mailbox = stale curation → fail
  // loudly so the allowlist cannot rot into a false sense of coverage.
  for (const relPath of Object.keys(MAILBOX_WRITER_ALLOWLIST)) {
    const stripped = files.get(relPath);
    if (stripped === undefined) {
      violations.push(
        `allowlisted mailbox writer "${relPath}" was not found in the scanned tree — fix MAILBOX_WRITER_ALLOWLIST`,
      );
    } else if (findMailboxInserts(stripped).length === 0) {
      violations.push(
        `allowlisted mailbox writer "${relPath}" no longer inserts into mt5_commands (moved/renamed?) — fix MAILBOX_WRITER_ALLOWLIST`,
      );
    }
  }
  notes.push(`mailbox writer files found: ${writerCount}; allowlisted: ${Object.keys(MAILBOX_WRITER_ALLOWLIST).length}`);

  // ── INVARIANT 2 — adminTrading dispatch stays gate-chained ─────────────────
  const placeOrderSrc = files.get(PLACE_ORDER);
  if (placeOrderSrc === undefined) {
    violations.push(`${PLACE_ORDER}: cannot read (adminTrading placeOrder is missing)`);
  } else {
    const guardIdx = placeOrderSrc.search(/\brunOrderGuards\s*\(/);
    const dispatchIdx = placeOrderSrc.search(/\bdispatchToBroker\s*\(/);
    if (guardIdx < 0) {
      violations.push(`${PLACE_ORDER}: must call runOrderGuards() before dispatching to the broker`);
    }
    if (!/guard\.status\s*!==\s*["']APPROVED["']/.test(placeOrderSrc)) {
      violations.push(`${PLACE_ORDER}: must reject when the guard status is not "APPROVED" before reaching dispatchToBroker()`);
    }
    if (dispatchIdx >= 0 && guardIdx >= 0 && dispatchIdx < guardIdx) {
      violations.push(`${PLACE_ORDER}: dispatchToBroker() must run AFTER runOrderGuards(), never before`);
    }
  }

  const orderGuardSrc = files.get(ORDER_GUARD);
  if (orderGuardSrc === undefined) {
    violations.push(`${ORDER_GUARD}: cannot read (adminTrading orderGuard is missing)`);
  } else {
    // The STRUCTURAL bridge_token dispatch-lock gate must remain. It hard-denies
    // every non-SIMULATED order regardless of any env var, so this legacy path
    // can never reach dispatchToBroker — strictly stronger than the old
    // env-keyed BRIDGE_TOKEN_UNSET lock.
    if (!/name\s*:\s*["']bridge_token["']/.test(orderGuardSrc)) {
      violations.push(`${ORDER_GUARD}: the structural bridge_token dispatch-lock gate must remain — it is the lock that keeps adminTrading from delivering live/demo`);
    }
    if (!/LIVE_DISPATCH_DISABLED_USE_PHASE_B/.test(orderGuardSrc)) {
      violations.push(`${ORDER_GUARD}: the bridge_token gate must hard-deny LIVE with "LIVE_DISPATCH_DISABLED_USE_PHASE_B" — LIVE must route only through the Phase B 23-gate pipeline`);
    }
    if (!/DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE/.test(orderGuardSrc)) {
      violations.push(`${ORDER_GUARD}: the bridge_token gate must hard-deny DEMO with "DEMO_DISPATCH_DISABLED_USE_DEMO_QUEUE" — DEMO must route only through the per-user demo arming queue`);
    }
    // Must never regress to an env-var unlock: a stray legacy MT5_BRIDGE_TOKEN
    // must never be able to grant dispatch from this layer. Catches both bracket
    // (`process.env["MT5_BRIDGE_TOKEN"]`) and dot (`process.env.MT5_BRIDGE_TOKEN`)
    // notation. (Comments are stripped before this scan, so this only catches a
    // real env read.)
    if (/process\.env(?:\[\s*["']MT5_BRIDGE_TOKEN["']\s*\]|\.MT5_BRIDGE_TOKEN\b)/.test(orderGuardSrc)) {
      violations.push(`${ORDER_GUARD}: the bridge_token gate must NOT read the legacy MT5_BRIDGE_TOKEN env var — the dispatch lock is structural (default-deny) and must never be unlockable by an env var`);
    }
  }

  // ── INVARIANT 3 — dispatchToBroker import-confined to placeOrder.ts ─────────
  for (const [relPath, stripped] of files) {
    if (relPath === PLACE_ORDER) continue;
    if (importsDispatchToBroker(stripped)) {
      violations.push(
        `${relPath}: imports dispatchToBroker — only ${PLACE_ORDER} may import the broker-placement primitive (every dispatch must go through runOrderGuards)`,
      );
    }
  }

  // ── INVARIANT 4 — per-writer deliverable-LIVE semantics are locked ─────────
  // For every allowlisted writer that is NOT one of the two sanctioned LIVE
  // pipelines, prove its mt5_commands insert cannot become a deliverable LIVE
  // command: no live-delivery token, no trade OPEN, plus its documented safe
  // markers. A non-LIVE allowlisted writer with NO semantic spec also fails so a
  // future allowlist addition must be classified.
  for (const relPath of Object.keys(MAILBOX_WRITER_ALLOWLIST)) {
    if (LIVE_PIPELINE_WRITERS.has(relPath)) continue;
    const stripped = files.get(relPath);
    if (stripped === undefined) continue; // already reported by invariant 1
    const spec = NON_LIVE_WRITER_SEMANTICS[relPath];
    if (spec === undefined) {
      violations.push(
        `${relPath}: is an allowlisted non-Phase-B mailbox writer but has NO entry in NON_LIVE_WRITER_SEMANTICS — every non-LIVE writer must be classified with the semantic markers that prove it cannot deliver a LIVE command`,
      );
      continue;
    }
    for (const req of spec.fileRequire) {
      if (!req.rx.test(stripped)) {
        violations.push(`${relPath}: ${req.why} (marker ${String(req.rx)} not found)`);
      }
    }
    const blocks = extractInsertValuesBlocks(stripped, commandTableBindings(stripped));
    if (blocks.length === 0) {
      violations.push(
        `${relPath}: no typed mt5_commands insert .values({…}) block could be parsed — its deliverable-LIVE semantics cannot be verified; keep the typed insert or have a human review it`,
      );
    }
    for (const blk of blocks) {
      const forbids = [
        { rx: LIVE_DELIVERY_TOKEN, why: "a non-Phase-B writer must not emit deliverable LIVE semantics (mode:'LIVE' / requiredAccountType:'live')" },
        { rx: OPEN_ACTION_TOKEN, why: "a non-Phase-B writer must not open a trade (action:'OPEN')" },
        ...spec.blockForbid,
      ];
      for (const f of forbids) {
        if (f.rx.test(blk.block)) {
          violations.push(`${relPath}:${blk.line} mt5_commands insert violates: ${f.why}`);
        }
      }
      for (const r of spec.blockRequire) {
        if (!r.rx.test(blk.block)) {
          violations.push(`${relPath}:${blk.line} mt5_commands insert is missing required marker — ${r.why}`);
        }
      }
    }
  }

  // ── INVARIANT 5 — deliverable-LIVE semantics confined to the two pipelines ──
  // Positive net across the WHOLE scanned tree: any mt5_commands insert block
  // carrying a live-delivery token must belong to a sanctioned LIVE writer.
  let liveSemanticsWriters = 0;
  for (const [relPath, stripped] of files) {
    const blocks = extractInsertValuesBlocks(stripped, commandTableBindings(stripped));
    for (const blk of blocks) {
      if (!blockHasLiveDeliveryToken(blk.block)) continue;
      if (LIVE_SEMANTICS_WRITER_ALLOWLIST.has(relPath)) {
        liveSemanticsWriters++;
        continue;
      }
      violations.push(
        `${relPath}:${blk.line} writes a DELIVERABLE LIVE mt5_commands row (mode:'LIVE' / requiredAccountType:'live') outside the sanctioned pipelines — only Phase B (post-23-gate) and the gated adminTrading path may emit live broker commands`,
      );
    }
  }
  notes.push(
    `deliverable-LIVE mt5_commands writers: ${liveSemanticsWriters}; sanctioned: ${LIVE_SEMANTICS_WRITER_ALLOWLIST.size}`,
  );

  return {
    name: "admin-trading-no-live-bypass (no non-Phase-B path can deliver a LIVE mt5_commands row to the EA mailbox)",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkAdminTradingNoLiveBypass();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
