// One read model for "what are this user's open positions?".
//
// lib/positions/openPositions.ts owns venue selection, the named "open"
// definitions (bases), per-user scoping, optional account-mode scoping and the
// normalised OpenPosition shape: readOpenPositions / countOpenPositions for the
// normalised rows, selectLiveOpenPositions / selectDemoOpenPositions for
// projections and aggregates, and select{Live,Demo}OpenPositionsForAllUsers for
// operator-wide views and sweeps. The raw venue ledgers (livePositionLedger /
// demoPositionLedger) remain for historical, closed, single-row and
// broker-truth producer reads.
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
// Cross-user reads: the ...ForAllUsers functions are the only reads in the
// read model that are not scoped to one user. A runtime module that names one
// must be listed in OPERATOR_WIDE_READERS with a reason; a listed module that no
// longer uses them (or no longer exists) is a stale entry. Importing one under
// an alias is rejected for the same reason as aliasing a raw ledger.
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
/** The read model's cross-user (operator-wide) functions. */
export const ALL_USERS_READ = /^select(?:Live|Demo)OpenPositionsForAllUsers$/;

/** Text that makes a raw ledger read an open-position read. */
export const OPEN_PREDICATE =
  /\bopenLiveExposureCondition\s*\(|\bisNull\(\s*[\w$]+\s*\.\s*closedAt\s*\)|\bne\(\s*[\w$]+\s*\.\s*status\s*,\s*["'`]CLOSED["'`]\s*\)|\beq\(\s*[\w$]+\s*\.\s*status\s*,\s*["'`]OPEN["'`]\s*\)|\bclosed_at\s+is\s+null\b/i;

type Category = "BROKER_TRUTH" | "NON_STANDARD_PREDICATE";

export interface OpenReadAllowance {
  /** Exact number of raw-ledger open-position reads permitted in the file. */
  openReads: number;
  category: Category;
  reason: string;
}

/**
 * Modules that still read open positions from a raw venue ledger, each with a
 * reason. Lower a count (or remove the entry) when a read moves to the read
 * model; the guard fails until you do.
 */
export const OPEN_READ_ALLOWLIST: Record<string, OpenReadAllowance> = {
  // Broker-truth producers: they reconcile the broker facts they are ingesting
  // against the open rows they are about to write.
  "routes/mt5Live.ts": {
    openReads: 1, category: "BROKER_TRUTH",
    reason: "LIVE snapshot ingest compares the incoming broker snapshot with the connection's open rows",
  },
  "lib/live/liveCommandPipeline.ts": {
    openReads: 1, category: "BROKER_TRUTH",
    reason: "a LIVE_FILLED CLOSE reads the open row's volume and immediately writes the partial-close volume or closed_at for that row (read-modify-write beside livePositionWriter)",
  },
};

export interface OperatorReadAllowance {
  reason: string;
}

/**
 * Modules allowed to call the read model's cross-user functions
 * (select{Live,Demo}OpenPositionsForAllUsers). Each one reads every user's open
 * rows by design (grouped by user, summed, or swept); the per-user API cannot
 * express it. Remove an entry when the module stops using them.
 */
export const OPERATOR_WIDE_READERS: Record<string, OperatorReadAllowance> = {
  "routes/adminAllocations.ts": {
    reason: "settled-user detection (inside the allocation lock tx) and the reconcile summary group every user's open rows",
  },
  "routes/adminCockpit.ts": { reason: "operator cockpit totals, open-trade board and per-user counts across all users" },
  "routes/adminFundBook.ts": { reason: "Fund Book mirrors every open broker position into UNASSIGNED allocation rows" },
  "routes/adminLiveAccount.ts": { reason: "operator live-account totals and unassigned-position list across all users" },
  "routes/adminReconciliationCenter.ts": { reason: "lists the users that hold open live exposure for the reconciliation center" },
  "lib/aaci/reconciliationAudit.ts": { reason: "audit compares open tickets for a batch of users in one query" },
  "lib/intelligence/monitorWorker.ts": { reason: "the monitor sweep finds the distinct users that hold open DEMO rows (per-user reads use readOpenPositions)" },
  "lib/live/masterBridgePool.ts": { reason: "pool recompute sums floating P/L of every allocated user's open exposure" },
  "lib/live/emergencyClose.ts": { reason: "kill-switch close-all (all / all_shared scopes) resolves every open live position" },
  "lib/alerts/ruleEngine.ts": {
    reason: "the near-stop-loss alert sweep scans every trader's DEMO rows under the ALERT_ELIGIBLE basis (owned, status OPEN, not closed) and attributes each alert to the row's owner",
  },
};

/**
 * Trader alerts (owner decision 11) keep the stricter ALERT_ELIGIBLE rule:
 * every read-model call in an alert module must name the ALERT_ELIGIBLE basis,
 * so an alert sweep cannot silently widen to ownerless or closed DEMO rows.
 */
export const ALERT_MODULE = /^lib\/alerts\//;
const READ_MODEL_CALL = /^(?:readOpenPositions|countOpenPositions|select(?:Live|Demo)OpenPositions(?:ForAllUsers)?)$/;

export function alertEligibilityViolations(key: string, source: string): string[] {
  if (!ALERT_MODULE.test(key)) return [];
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && READ_MODEL_CALL.test(n.expression.text)) {
      const argsText = n.arguments.map((a) => a.getText(file)).join(",");
      if (!/\bALERT_ELIGIBLE_BASIS\.(?:DEMO|LIVE)\b|["'`]ALERT_ELIGIBLE["'`]/.test(argsText)) {
        const line = file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
        out.push(`${line}: alert module reads open positions without the ALERT_ELIGIBLE basis (owner decision 11); pass basis: ALERT_ELIGIBLE_BASIS.DEMO`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

export interface FileScan {
  openReads: number;
  violations: string[];
  /** Names a cross-user read-model function (select*OpenPositionsForAllUsers). */
  allUsersReads?: boolean;
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

  // Pass 2: raw ledger calls, cross-user read-model use, and aliasing.
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && ALL_USERS_READ.test(n.text)) out.allUsersReads = true;
    if (ts.isImportSpecifier(n) && n.propertyName && ALL_USERS_READ.test(n.propertyName.text) &&
        n.propertyName.text !== n.name.text) {
      out.violations.push(`${line(n)}: cross-user read-model function imported under an alias; import it by name`);
    }
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
  operatorReaders: Record<string, OperatorReadAllowance> = {},
): string[] {
  const violations: string[] = [];
  for (const [key, scan] of Object.entries(scans)) {
    for (const v of scan.violations) violations.push(`${key}:${v}`);
    if (scan.allUsersReads && !operatorReaders[key]) {
      violations.push(
        `${key}: calls a cross-user open-position read (select*OpenPositionsForAllUsers) but is not in OPERATOR_WIDE_READERS; read one user with readOpenPositions/selectLiveOpenPositions or add a justified entry`,
      );
    } else if (!scan.allUsersReads && operatorReaders[key]) {
      violations.push(`${key}: stale OPERATOR_WIDE_READERS entry — the module no longer uses a cross-user read; remove the entry`);
    }
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
  for (const key of Object.keys(operatorReaders)) {
    if (!(key in scans)) {
      violations.push(`${key}: stale OPERATOR_WIDE_READERS entry — ${exists(key) ? "file is not a scanned runtime module" : "file no longer exists"}`);
    }
    if (!operatorReaders[key]!.reason.trim()) violations.push(`${key}: OPERATOR_WIDE_READERS entry needs a reason`);
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
    // The cross-user EXPOSURE basis must also be the canonical predicate.
    if (!/openLiveExposureCondition\(\)/.test(src)) {
      violations.push(`${READ_MODEL} must build the cross-user LIVE EXPOSURE basis from openLiveExposureCondition()`);
    }
  }
  if (existsSync(readModel)) {
    const src = readFileSync(readModel, "utf8");
    const rule = /function demoAlertEligibleCondition\(\)[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    for (const [part, label] of [
      [/eq\(demoPositionColumns\.status,\s*"OPEN"\)/, "status = 'OPEN'"],
      [/isNull\(demoPositionColumns\.closedAt\)/, "closed_at IS NULL"],
      [/isNotNull\(demoPositionColumns\.userId\)/, "user_id IS NOT NULL"],
    ] as const) {
      if (!part.test(rule)) violations.push(`${READ_MODEL}: the DEMO ALERT_ELIGIBLE rule (demoAlertEligibleCondition) must include ${label}`);
    }
  }
  const scans: Record<string, FileScan> = {};
  let rawOpenReads = 0;
  let operatorReaders = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("/__qa__/") || p.endsWith(".test.ts") })) {
    const key = file.slice(API_SRC.length + 1);
    if (key.startsWith("scripts/")) continue;
    const source = readFileSync(file, "utf8");
    const scan = scanFile(key, source);
    scan.violations.push(...alertEligibilityViolations(key, source));
    rawOpenReads += scan.openReads;
    if (scan.allUsersReads) operatorReaders++;
    scans[key] = scan;
  }
  violations.push(
    ...evaluate(scans, OPEN_READ_ALLOWLIST, (key) => existsSync(join(API_SRC, key)), OPERATOR_WIDE_READERS).map((v) =>
      v.startsWith("lib/") || v.startsWith("routes/") ? `${rel(join(API_SRC, v.split(":")[0]!))}${v.slice(v.indexOf(":"))}` : v,
    ),
  );
  return {
    name: "single-open-position-view",
    ok: violations.length === 0,
    violations,
    notes: [
      `${Object.keys(scans).length} runtime files scanned; ${rawOpenReads} justified raw open-position reads in ${Object.keys(OPEN_READ_ALLOWLIST).length} allowlisted modules; ${operatorReaders} operator-wide modules use the cross-user read-model functions; everything else reads ${READ_MODEL}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkSingleOpenPositionView();
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}
