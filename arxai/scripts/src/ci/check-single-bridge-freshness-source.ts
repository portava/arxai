// Broker Hub — one source for bridge / EA heartbeat and MT5 snapshot
// freshness thresholds (Tier 1 Broker State).
//
// Round 5 (owner decision 17): MT5 connection heartbeats are classified by ONE
// shared pure policy, lib/domain/src/broker-health/heartbeatPolicy.ts
// (< 15 s fresh, 15–60 s degraded, >= 60 s offline, invalid → unknown), used
// by the api-server, lib/domain and the trading dashboard. The guard now scans
// all three trees (api-server src, lib/domain/src, trading-dashboard/src) and
// adds a third rule, threshold_bypass (below).
//
// "Is the bridge fresh, stale or offline" depends on a number: the heartbeat
// (or account snapshot) age past which a surface stops calling the bridge
// connected. Those numbers used to be typed inline in ~40 files (15 s, 30 s,
// 60 s, 90 s, 120 s, 5 min, in both ms and seconds), so two surfaces could
// disagree without anyone noticing. They are now named once, by concept, in
// artifacts/api-server/src/lib/brokerHub/freshness.ts, and every other file
// imports the named threshold.
//
// This guard fails, outside that module, on:
//
//   1. threshold_const — a declaration (const / object property) whose name
//      says it is a heartbeat or bridge/account-snapshot freshness threshold
//      (e.g. HEARTBEAT_FRESH_MS, heartbeatStaleThresholdSec,
//      POOL_SNAPSHOT_FRESH_BUDGET_MS) initialised with a numeric literal;
//   2. threshold_compare — a comparison (<, <=, >, >=) between a numeric
//      literal (2 or more, literal arithmetic included) and an expression
//      that names a heartbeat age (an identifier containing the word
//      heartbeat / hb, e.g. hbAgeSec, lastHb, heartbeatAgeSeconds), or a
//      broker/snapshot age (brokerAgeMs, snapshotAgeMs).
//   3. threshold_bypass — a comparison between such a heartbeat age and a
//      NAMED constant (SCREAMING_CASE identifier or property, optionally in
//      literal arithmetic, e.g. hbAge <= LIVE_HEARTBEAT_MAX_AGE_SEC,
//      ageSec < HEARTBEAT_THRESHOLD_MS / 1000). Heartbeat ages must go through
//      the policy's classifier (classifyHeartbeatAge*, isHeartbeatAge*) so the
//      < vs <= boundary cannot drift. Distinct concepts that are compared with
//      a heartbeat age on purpose are reviewed allowlist entries.
//
// Reviewed exceptions are listed below with a reason and the exact number of
// hits allowed. A file with more hits fails (a new literal); a file with fewer
// (or none, or a missing file) is a stale entry and fails too, so the list
// only shrinks. QA fixtures (__qa__, *.test.ts) and operator scripts
// (src/scripts) are exempt.
//
// Values are NOT unified by this guard: where two places use different
// numbers for the same idea, freshness.ts keeps both as separately named
// thresholds (see docs/TIER1_BROKER_HUB_SOURCE.md). Unifying them would change
// what a surface reports and is an owner decision.
//
// Pure source analysis (TypeScript AST): no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const AUTHORITY = "lib/brokerHub/freshness.ts";
/** The shared pure heartbeat policy (repo-relative key; domain and dashboard files use repo-relative keys). */
export const POLICY = "lib/domain/src/broker-health/heartbeatPolicy.ts";
/** Extra trees scanned since round 5, keyed by repo-relative path. */
export const EXTRA_ROOTS = ["lib/domain/src", "artifacts/trading-dashboard/src"] as const;

export type Rule = "threshold_const" | "threshold_compare" | "threshold_bypass";

/** Reviewed exceptions: file → allowed hit count and why. */
export const ALLOW: Record<string, { count: number; why: string }> = {
  "lib/positionGuardian/assess.ts": {
    count: 1,
    why: "GUARDIAN_DEFAULTS.maxSnapshotAgeMs is the Position Guardian's own tunable (position snapshot age before it refuses to assess), owned by the Position Guardian domain and overridable per call; not a bridge connection threshold",
  },
  "lib/live/masterBridgePool.ts": {
    count: 1,
    why: "Shared-master pool ACCOUNT snapshot freshness (POOL_SNAPSHOT_FRESH_BUDGET_MS = MT5_ACCOUNT_SNAPSHOT_FRESH_MS, 60 s): the pool's balance/equity snapshot is stamped by the connection heartbeat, but it answers 'is the mirrored account snapshot fresh', a distinct concept owner decision 17 keeps off the heartbeat policy",
  },
  "lib/scalp/flameRead.ts": {
    count: 3,
    why: "Scalp execution-quality grading (owner decision 17: preserve stricter execution requirements). BLOCKED past 2 x the policy fresh bound (30 s) is STRICTER than the policy's 60 s offline line; EXCELLENT (<= 4 s) and GOOD (<= 8 s) are quality sub-bands inside the fresh band. Not-fresh → POOR goes through the policy classifier",
  },
  "lib/domain/src/signal-intelligence/scoring.ts": {
    count: 1,
    why: "Signal execution-score curve point: inside the policy's degraded band, ages past 2 x the fresh bound (30 s) cost the heavy penalty, as before. A score, not a freshness classification; degraded/offline come from the policy classifier",
  },
};

/** Split an identifier into lower-case words (camelCase and SNAKE_CASE). */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const THRESHOLD_WORDS = new Set([
  "fresh", "stale", "live", "degraded", "lockdown", "offline", "stable", "max", "threshold",
  "window", "connected", "disconnected", "budget",
]);

/** A name that declares a heartbeat / bridge-snapshot freshness threshold. */
export function isThresholdName(name: string): boolean {
  const w = words(name);
  if (!w.some((x) => THRESHOLD_WORDS.has(x))) return false;
  if (w.includes("heartbeat") || w.includes("hb")) return true;
  if (w.includes("watchdog") && (w.includes("fresh") || w.includes("stale"))) return true;
  if (w.includes("snapshot") && (w.includes("account") || w.includes("pool") || w.includes("broker") || w.includes("mt5"))) return true;
  if (w.includes("snapshot") && w.includes("age") && w.includes("max")) return true;
  return false;
}

/** An identifier that names a heartbeat / broker-snapshot age. */
export function isAgeIdentifier(name: string): boolean {
  const w = words(name);
  if (w.includes("heartbeat") || w.includes("hb")) return true;
  return /^(broker|snapshot|accountSnapshot|accountSync)Age(Ms|Sec|Seconds|S)?$/.test(name);
}

/** Value of a numeric literal expression (12, 15_000, 5 * 60_000, (2 * 60) * 1000), or null. */
export function literalValue(e: ts.Expression): number | null {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isParenthesizedExpression(e)) return literalValue(e.expression);
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return literalValue(e.expression);
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AsteriskToken || e.operatorToken.kind === ts.SyntaxKind.SlashToken)) {
    const l = literalValue(e.left);
    const r = literalValue(e.right);
    if (l == null || r == null) return null;
    return e.operatorToken.kind === ts.SyntaxKind.AsteriskToken ? l * r : l / r;
  }
  return null;
}

const COMPARE = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** The declaration (variable or parameter) an identifier refers to, by walking enclosing scopes. */
function declarationOf(id: ts.Identifier): ts.Node | null {
  const name = id.text;
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      for (const st of n.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
    if (ts.isFunctionLike(n)) {
      for (const p of n.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return p;
    }
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return d;
    }
  }
  return null;
}

/** A value reference (not a property name or declaration name). */
function isReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if ((ts.isPropertyAssignment(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === n) return false;
  return true;
}

/** An identifier that names an MT5 heartbeat (not a snapshot) age: the word heartbeat or hb. */
export function isHeartbeatAgeIdentifier(name: string): boolean {
  const w = words(name);
  return w.includes("heartbeat") || w.includes("hb");
}

function namesAge(e: ts.Node, tainted: ReadonlySet<ts.Node> = new Set(), match: (name: string) => boolean = isAgeIdentifier): boolean {
  let found = false;
  const v = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n)) {
      if (match(n.text)) { found = true; return; }
      if (tainted.size && isReference(n)) {
        const d = declarationOf(n);
        if (d && tainted.has(d)) { found = true; return; }
      }
    }
    if (ts.isPrivateIdentifier(n) && match(n.text.slice(1))) { found = true; return; }
    ts.forEachChild(n, v);
  };
  v(e);
  return found;
}

export interface Hit { line: number; rule: Rule; msg: string }

/** Every raw threshold in one file (key relative to api-server/src), ignoring the allowlist. */
/** SCREAMING_CASE constant name referenced by e (identifier, property, or literal arithmetic over one), else null. */
export function constantRef(e: ts.Expression): string | null {
  const SCREAM = /^[A-Z][A-Z0-9_]*[A-Z0-9]$/;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) return constantRef(e.expression);
  if (ts.isIdentifier(e)) return SCREAM.test(e.text) ? e.text : null;
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && (e.expression.text === "Number" || e.expression.text === "Math")) return null;
    return SCREAM.test(e.name.text) ? e.name.text : null;
  }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AsteriskToken || e.operatorToken.kind === ts.SyntaxKind.SlashToken)) {
    const l = constantRef(e.left);
    const r = constantRef(e.right);
    if (l && (r || literalValue(e.right) != null)) return l;
    if (r && literalValue(e.left) != null) return r;
  }
  return null;
}

export function scanSource(key: string, source: string): Hit[] {
  if (key === AUTHORITY || key === POLICY) return [];
  const file = ts.createSourceFile(key, source, ts.ScriptTarget.Latest, true, key.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Hit[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  // A local computed from a heartbeat/snapshot age (const age = now - r.lastHeartbeat...)
  // is a heartbeat age too, whatever it is called.
  const tainted = new Set<ts.Node>();
  const taint = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && namesAge(node.initializer, tainted)) tainted.add(node);
    ts.forEachChild(node, taint);
  };
  taint(file);
  // Heartbeat-only taint for threshold_bypass (snapshot ages and object /
  // array literals that merely carry a heartbeat field are not heartbeat ages).
  const hbTainted = new Set<ts.Node>();
  const hbTaint = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && !ts.isObjectLiteralExpression(node.initializer) && !ts.isArrayLiteralExpression(node.initializer)
      && namesAge(node.initializer, hbTainted, isHeartbeatAgeIdentifier)) hbTainted.add(node);
    ts.forEachChild(node, hbTaint);
  };
  hbTaint(file);
  const isThreshold = (e: ts.Expression) => { const v = literalValue(e); return v != null && v >= 2; };
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && isThresholdName(node.name.text) && isThreshold(node.initializer)) {
      out.push({ line: at(node), rule: "threshold_const", msg: `declares heartbeat/snapshot freshness threshold ${node.name.text} = ${node.initializer.getText(file)}; import a named threshold from ${AUTHORITY}` });
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && isThresholdName(node.name.text) && isThreshold(node.initializer)) {
      out.push({ line: at(node), rule: "threshold_const", msg: `declares heartbeat/snapshot freshness threshold ${node.name.text}: ${node.initializer.getText(file)}; import a named threshold from ${AUTHORITY}` });
    }
    if (ts.isBinaryExpression(node) && COMPARE.has(node.operatorToken.kind)) {
      const lv = literalValue(node.left);
      const rv = literalValue(node.right);
      const lit = lv != null ? node.left : rv != null ? node.right : null;
      const other = lv != null ? node.right : node.left;
      const val = lv ?? rv;
      if (lit && val != null && val >= 2 && literalValue(other) == null && namesAge(other, tainted)) {
        out.push({ line: at(node), rule: "threshold_compare", msg: `compares a heartbeat/snapshot age with the raw literal ${lit.getText(file)} (${node.getText(file).replace(/\s+/g, " ").slice(0, 90)}); compare with a named threshold from ${AUTHORITY}` });
      } else if (lv == null && rv == null) {
        const lc = constantRef(node.left);
        const rc = constantRef(node.right);
        const name = lc ?? rc;
        const ageSide = lc ? node.right : node.left;
        if (name && !(lc && rc) && namesAge(ageSide, hbTainted, isHeartbeatAgeIdentifier)) {
          out.push({ line: at(node), rule: "threshold_bypass", msg: `compares a heartbeat age with the named constant ${name} (${node.getText(file).replace(/\s+/g, " ").slice(0, 90)}); classify it through ${POLICY} (classifyHeartbeatAge*/isHeartbeatAge*)` });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return out;
}

/** Violations for one file after the allowlist (count-exact). */
export function scanFile(key: string, source: string): string[] {
  const hits = scanSource(key, source);
  const allow = ALLOW[key];
  if (allow && hits.length <= allow.count) return [];
  if (allow) return [`${hits.length} raw thresholds but the allowlist entry allows ${allow.count}; a new one was added — import it from ${AUTHORITY}`, ...hits.map((h) => `${h.line}: ${h.msg}`)];
  return hits.map((h) => `${h.line}: ${h.msg}`);
}

/** Allowlist entries whose file is gone or now has fewer hits than allowed. */
export function staleEntries(read: (key: string) => string | null): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(ALLOW)) {
    const src = read(key);
    if (src == null) { out.push(`${key}: allowlisted but the file no longer exists — remove the entry`); continue; }
    const n = scanSource(key, src).length;
    if (n < entry.count) out.push(`${key}: allowlisted for ${entry.count} raw threshold(s) but has ${n} — lower the count${n === 0 ? " (remove the entry)" : ""}`);
  }
  return out;
}

/**
 * The shared policy must keep the owner's bounds and classifier; the server
 * authority must re-export it, keep its snapshot thresholds, and define no
 * heartbeat threshold of its own.
 */
export function checkAuthorityShape(read: (key: string) => string | null, readRepo: (key: string) => string | null = () => null): string[] {
  const src = read(AUTHORITY);
  if (!src) return [`artifacts/api-server/src/${AUTHORITY} is missing (the freshness threshold authority)`];
  const out: string[] = [];
  if (!/export const MT5_ACCOUNT_SNAPSHOT_FRESH_MS\b/.test(src)) out.push(`${AUTHORITY} lost MT5_ACCOUNT_SNAPSHOT_FRESH_MS`);
  if (!/from "@workspace\/domain\/broker-health\/heartbeatPolicy"/.test(src) || !/\bclassifyHeartbeatAgeMs\b/.test(src)) {
    out.push(`${AUTHORITY} must re-export the shared heartbeat policy (classifyHeartbeatAgeMs) from @workspace/domain/broker-health/heartbeatPolicy`);
  }
  const own = src.match(/export const \w*HEARTBEAT\w*/g);
  if (own) out.push(`${AUTHORITY} defines its own heartbeat threshold(s) (${own.join(", ")}); heartbeat bounds live only in ${POLICY}`);
  const pol = readRepo(POLICY);
  if (!pol) { out.push(`${POLICY} is missing (the shared heartbeat policy)`); return out; }
  if (!/export const MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000;/.test(pol)) out.push(`${POLICY} lost MT5_HEARTBEAT_FRESH_BELOW_MS = 15_000 (owner decision 17)`);
  if (!/export const MT5_HEARTBEAT_OFFLINE_AT_MS = 60_000;/.test(pol)) out.push(`${POLICY} lost MT5_HEARTBEAT_OFFLINE_AT_MS = 60_000 (owner decision 17)`);
  for (const fn of ["classifyHeartbeatAgeMs", "classifyHeartbeatAgeSeconds", "heartbeatAllowsExecution"]) {
    if (!new RegExp(`export function ${fn}\\(`).test(pol)) out.push(`${POLICY} lost ${fn}()`);
  }
  if (/^import /m.test(pol)) out.push(`${POLICY} must stay pure (no imports)`);
  return out;
}

export function checkSingleBridgeFreshnessSource(): CheckResult {
  const violations: string[] = [];
  let scanned = 0;
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    scanned++;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  for (const root of EXTRA_ROOTS) {
    for (const file of walk(join(ROOT, root), { skip: (p) => p.includes("__qa__") || /\.test\.tsx?$/.test(p) })) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      scanned++;
      const key = rel(file);
      for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${key}:${v}`);
    }
  }
  const readRepo = (key: string) => {
    const p = join(ROOT, key);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  const read = (key: string) => {
    if (EXTRA_ROOTS.some((r) => key.startsWith(`${r}/`))) return readRepo(key);
    const p = join(API_SRC, key);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  };
  for (const s of staleEntries(read)) violations.push(`stale allowlist: ${s}`);
  for (const s of checkAuthorityShape(read, readRepo)) violations.push(s);
  return {
    name: "single-bridge-freshness-source",
    ok: violations.length === 0,
    violations,
    notes: [`${scanned} files scanned (api-server, lib/domain, trading-dashboard); heartbeat bounds only in ${POLICY}, snapshot thresholds only in ${AUTHORITY}; ${Object.keys(ALLOW).length} reviewed exceptions`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleBridgeFreshnessSource();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
