// One read model for "what are this user's open positions?".
//
// lib/positions/openPositions.ts (readOpenPositions / countOpenPositions) owns
// venue selection, the named "open" definitions, per-user scoping, optional
// account-mode scoping and the normalised OpenPosition shape. The raw venue
// ledgers (livePositionLedger / demoPositionLedger) remain for historical,
// single-row, aggregate, producer and operator-wide reads.
//
// This guard fails when a runtime module calls a raw venue ledger with an
// open-position predicate (closed_at IS NULL, the canonical
// openLiveExposureCondition, or a DEMO status = 'OPEN' / <> 'CLOSED' test), whether the
// predicate is written in the call or held in a same-file variable, unless the
// module is listed in OPEN_READ_ALLOWLIST with the exact number of such calls
// and a reason. A count above the listed number is a new raw open read; a count
// below it (or a listed file that no longer exists) is a stale entry that must
// be lowered or removed, so the allowlist can only shrink. Aliasing a raw venue
// ledger (import renaming, destructuring, re-assignment) is rejected outright
// because it would hide calls from the count.
//
// Limitation (documented in docs/TIER1_OPEN_POSITION_VIEW.md): a module that
// reads every row for a user and filters closed rows in memory is not detected.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const READ_MODEL = "lib/positions/openPositions.ts";
const LEDGER = "lib/positions/ledger.ts";
const RAW_LEDGERS = new Set(["livePositionLedger", "demoPositionLedger"]);
const READ_METHODS = new Set(["read", "select"]);

/** Text that makes a raw ledger read an open-position read. */
export const OPEN_PREDICATE =
  /\bopenLiveExposureCondition\s*\(|\bisNull\(\s*[\w$]+\s*\.\s*closedAt\s*\)|\bne\(\s*[\w$]+\s*\.\s*status\s*,\s*["'`]CLOSED["'`]\s*\)|\beq\(\s*[\w$]+\s*\.\s*status\s*,\s*["'`]OPEN["'`]\s*\)|\bclosed_at\s+is\s+null\b/i;

type Category =
  | "OPERATOR_WIDE"
  | "BROKER_TRUTH"
  | "EXECUTION_WORKSTREAM"
  | "AGGREGATE_GUARDED"
  | "SINGLE_POSITION"
  | "PLATFORM_SAFETY";

export interface OpenReadAllowance {
  /** Exact number of raw-ledger open-position reads permitted in the file. */
  openReads: number;
  category: Category;
  reason: string;
}

/**
 * Modules that still read open positions from a raw venue ledger, each with a
 * reason. Lower a count (or remove the entry) when a read moves to
 * readOpenPositions; the guard fails until you do.
 */
export const OPEN_READ_ALLOWLIST: Record<string, OpenReadAllowance> = {
  // Operator-wide views: they read every user's rows (grouped by user or in a
  // sweep). The read model is per-user by design and has no "all users" mode.
  "routes/adminAllocations.ts": {
    openReads: 3, category: "OPERATOR_WIDE",
    reason: "settled-user detection and the reconcile summary group open rows across all users; reconcile-detail lists a user's reconciled (not exposure) rows",
  },
  "routes/adminCockpit.ts": {
    openReads: 4, category: "OPERATOR_WIDE",
    reason: "operator cockpit totals, open-trade board and per-user counts across all users",
  },
  "routes/adminFundBook.ts": {
    openReads: 1, category: "OPERATOR_WIDE",
    reason: "Fund Book mirrors every open broker position into UNASSIGNED allocation rows",
  },
  "routes/adminLiveAccount.ts": {
    openReads: 2, category: "OPERATOR_WIDE",
    reason: "operator live-account totals and unassigned-position list across all users",
  },
  "routes/adminReconciliationCenter.ts": {
    openReads: 1, category: "OPERATOR_WIDE",
    reason: "lists the users that hold open live exposure for the reconciliation center",
  },
  "lib/aaci/reconciliationAudit.ts": {
    openReads: 1, category: "OPERATOR_WIDE",
    reason: "audit compares open tickets for a batch of users in one query",
  },
  "lib/alerts/ruleEngine.ts": {
    openReads: 1, category: "OPERATOR_WIDE",
    reason: "alert sweep evaluates every user's open DEMO rows in one pass",
  },
  "lib/intelligence/monitorWorker.ts": {
    openReads: 1, category: "OPERATOR_WIDE",
    reason: "the monitor sweep finds the distinct users that hold open DEMO rows (per-user reads use readOpenPositions)",
  },
  // Broker-truth producers: they reconcile the snapshot they are ingesting,
  // inside the producer, against open rows for the bridge being synced.
  "routes/mt5Live.ts": {
    openReads: 2, category: "BROKER_TRUTH",
    reason: "LIVE snapshot ingest compares the incoming broker snapshot with the connection's open rows",
  },
  "lib/live/brokerAbsenceReconcileRunner.ts": {
    openReads: 1, category: "BROKER_TRUTH",
    reason: "broker-side close reconciliation reads absence-evidence columns on open rows it may stamp",
  },
  // Aggregates already pinned to openLiveExposureCondition by the
  // reconciled-ghost-exposure guard, which reads these files literally.
  "lib/live/masterBridgePool.ts": {
    openReads: 2, category: "AGGREGATE_GUARDED",
    reason: "pool recompute (all allocated users) and wallet view; pinned by reconciled-ghost-exposure",
  },
  "lib/selfTrade/executionGate.ts": {
    openReads: 1, category: "AGGREGATE_GUARDED",
    reason: "agent concurrent-position gate; pinned by reconciled-ghost-exposure",
  },
  // Platform safety: operator-initiated actions across users or tickets.
  "lib/live/emergencyClose.ts": {
    openReads: 5, category: "PLATFORM_SAFETY",
    reason: "emergency close-all selects open rows by user, symbol, bridge or globally for the kill switch",
  },
  "lib/live/liveTestCycle.ts": {
    openReads: 1, category: "PLATFORM_SAFETY",
    reason: "operator live test cycle pre-checks the test account in its own audited flow",
  },
  // Owned by the parallel LIVE/DEMO execution workstream; migrate after it lands.
  "lib/live/instantTrade.ts": {
    openReads: 2, category: "EXECUTION_WORKSTREAM",
    reason: "instant router position resolution; file owned by the execution workstream",
  },
  "lib/live/liveCommandPipeline.ts": {
    openReads: 4, category: "EXECUTION_WORKSTREAM",
    reason: "dispatch pre-gates (cluster, floating loss, concurrent caps); file owned by the execution workstream",
  },
  "routes/meLive.ts": {
    openReads: 3, category: "EXECUTION_WORKSTREAM",
    reason: "/me/live position reads beside close paths; file owned by the execution workstream",
  },
  "routes/meTrades.ts": {
    openReads: 1, category: "EXECUTION_WORKSTREAM",
    reason: "My Trades open list beside close paths; file owned by the execution workstream",
  },
};

export interface FileScan {
  openReads: number;
  violations: string[];
}

function argsMentionOpenVar(node: ts.Node, openVars: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && openVars.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function scanFile(key: string, source: string): FileScan {
  const out: FileScan = { openReads: 0, violations: [] };
  if (key === LEDGER || key === READ_MODEL) return out;
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const line = (n: ts.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;

  // Pass 1: same-file variables whose initializer is an open predicate.
  const openVars = new Set<string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        OPEN_PREDICATE.test(n.initializer.getText(file))) {
      openVars.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(file);

  // Pass 2: raw ledger calls and aliasing.
  const visit = (n: ts.Node) => {
    if (ts.isImportSpecifier(n) && RAW_LEDGERS.has((n.propertyName ?? n.name).text) && n.propertyName &&
        n.propertyName.text !== n.name.text) {
      out.violations.push(`${line(n)}: raw venue ledger imported under an alias; import it by name or use readOpenPositions`);
    }
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const prop = n.propertyName && ts.isIdentifier(n.propertyName) ? n.propertyName.text : null;
      const decl = n.parent.parent;
      const init = ts.isVariableDeclaration(decl) && decl.initializer ? decl.initializer.getText(file) : "";
      if ((prop && RAW_LEDGERS.has(prop) && ts.isIdentifier(n.name) && n.name.text !== prop) ||
          /^(?:livePositionLedger|demoPositionLedger)$/.test(init.trim())) {
        out.violations.push(`${line(n)}: raw venue ledger destructured/aliased; call it by name or use readOpenPositions`);
      }
    }
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.initializer) &&
        RAW_LEDGERS.has(n.initializer.text)) {
      out.violations.push(`${line(n)}: raw venue ledger re-assigned; call it by name or use readOpenPositions`);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        READ_METHODS.has(n.expression.name.text)) {
      const target = n.expression.expression;
      const targetName = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target) ? target.name.text : null;
      if (targetName && RAW_LEDGERS.has(targetName)) {
        const argsText = n.arguments.map((a) => a.getText(file)).join(",");
        if (OPEN_PREDICATE.test(argsText) || n.arguments.some((a) => argsMentionOpenVar(a, openVars))) {
          out.openReads++;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

export function evaluate(
  scans: Record<string, FileScan>,
  allowlist: Record<string, OpenReadAllowance>,
  exists: (key: string) => boolean,
): string[] {
  const violations: string[] = [];
  for (const [key, scan] of Object.entries(scans)) {
    for (const v of scan.violations) violations.push(`${key}:${v}`);
    const allowed = allowlist[key];
    if (scan.openReads > 0 && !allowed) {
      violations.push(
        `${key}: ${scan.openReads} raw venue-ledger open-position read(s); use readOpenPositions/countOpenPositions from ${READ_MODEL}`,
      );
    } else if (allowed && scan.openReads > allowed.openReads) {
      violations.push(
        `${key}: ${scan.openReads} raw open-position reads, allowlist permits ${allowed.openReads}; use readOpenPositions for the new read`,
      );
    } else if (allowed && scan.openReads < allowed.openReads) {
      violations.push(
        `${key}: stale allowlist entry — ${scan.openReads} raw open-position reads remain, allowlist says ${allowed.openReads}; lower it${scan.openReads === 0 ? " (remove the entry)" : ""}`,
      );
    }
  }
  for (const key of Object.keys(allowlist)) {
    if (!(key in scans) && !exists(key)) violations.push(`${key}: stale allowlist entry — file no longer exists`);
    if (!(key in scans) && exists(key)) {
      violations.push(`${key}: stale allowlist entry — file is not a scanned runtime module`);
    }
    if (!allowlist[key]!.reason.trim()) violations.push(`${key}: allowlist entry needs a reason`);
  }
  return violations;
}

export function checkSingleOpenPositionView(): CheckResult {
  const violations: string[] = [];
  const readModel = join(API_SRC, READ_MODEL);
  if (!existsSync(readModel)) {
    violations.push(`${READ_MODEL} missing`);
  } else {
    const src = readFileSync(readModel, "utf8");
    // The read model must be built on the ledger and the canonical exposure predicate.
    if (!/from "\.\/ledger\.js"/.test(src)) violations.push(`${READ_MODEL} must read through lib/positions/ledger.ts`);
    if (!src.includes("openLiveExposureCondition(")) {
      violations.push(`${READ_MODEL} must build the LIVE EXPOSURE basis from openLiveExposureCondition`);
    }
    if (/\bdb\.(?:select|execute)\b|\bpool\.query\b/.test(src)) {
      violations.push(`${READ_MODEL} must not query the database except through the ledger`);
    }
  }
  const scans: Record<string, FileScan> = {};
  let rawOpenReads = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue;
    const scan = scanFile(key, readFileSync(file, "utf8"));
    rawOpenReads += scan.openReads;
    scans[key] = scan;
  }
  violations.push(
    ...evaluate(scans, OPEN_READ_ALLOWLIST, (key) => existsSync(join(API_SRC, key))).map((v) =>
      v.startsWith("lib/") || v.startsWith("routes/") ? `${rel(join(API_SRC, v.split(":")[0]!))}${v.slice(v.indexOf(":"))}` : v,
    ),
  );
  return {
    name: "single-open-position-view",
    ok: violations.length === 0,
    violations,
    notes: [
      `${Object.keys(scans).length} runtime files scanned; ${rawOpenReads} justified raw open-position reads in ${Object.keys(OPEN_READ_ALLOWLIST).length} allowlisted modules; everything else reads ${READ_MODEL}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkSingleOpenPositionView();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
