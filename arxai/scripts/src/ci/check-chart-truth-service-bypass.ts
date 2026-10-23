// check-chart-truth-service-bypass.ts
//
// Static-analysis CI guard — the SERVICE-LAYER sibling of
// `check-chart-truth-bypass.ts`.
//
// The route guard proves no chart ROUTE can ship raw `routeCandles()` candles
// straight to an HTTP response. But routes are not the only leak surface: a
// shared helper under `artifacts/api-server/src/lib` or
// `artifacts/api-server/src/brain` can call the raw `routeCandles`
// (marketDataRouter) accessor and RETURN the raw `Candle[]` (or the whole
// result object) to whoever calls it — and that caller may then forward it to a
// client, an assistant, or a decision path having never passed it through the
// OHLC integrity gate (`runCandleTruth` / `normalizeCandles`, reached via
// `getChartCandles`). This guard closes that gap.
//
// HOW IT WORKS (AST-based per-flow taint analysis, no network/DB):
//
//   For every service file under lib/ and brain/ that references routeCandles:
//
//     1. SOURCE — `routeCandles` is recognised even under an import alias.
//
//     2. TAINT — A variable assigned directly from `routeCandles(...)` is a raw
//        source. A value derived from such a source's `.candles` array —
//        `?? []` / `|| []`, IDENTITY-PRESERVING array chains
//        (`.filter`/`.slice`/`.sort`/`.reverse`/`.concat`/`.flat`), object
//        destructuring (`const { candles } = routed`), and ternaries — is a raw
//        candle array.
//
//        CRITICAL DIFFERENCE vs. the route guard: `.map` / `.flatMap` are NOT
//        treated as raw. They are the transformation boundary — a helper that
//        maps candles into ATR inputs, signal candles, indicator numbers, or
//        any other shape is a legitimate internal consumer and must stay clean.
//        Identity-preserving chains (`.filter`, `.slice`, …) keep the original
//        Candle objects, so a helper returning those is still leaking raw,
//        unvalidated candles and IS flagged.
//
//     3. SINK — A raw-candle value is a VIOLATION when it leaves the helper:
//          a. a `return` statement (or a concise arrow-function body) whose
//             expression resolves to a raw candle array, OR to the whole raw
//             routeCandles() result object; OR
//          b. a raw-candle array assigned to a `candles:` property of ANY
//             object literal (the canonical chart payload shape) — catching
//             `return { candles: routed.candles }` and the
//             `const out = { candles: routed.candles }; return out;` indirection.
//        `<src>.candles.length` (a count) and single-element access
//        (`<src>.candles[0]`) are explicitly allowed.
//
//   Taint is tracked PER VALUE, so a helper that transforms candles via `.map`
//   and a sibling helper that returns them raw are judged independently.
//
// This is intentionally precise rather than "every service routeCandles call
// must be wrapped": ATR/volatility/diagnostics helpers that map/transform
// candles into other shapes, or return a count, keep passing. The guard exits 1
// only if a raw candle array (or the raw result object) can be RETURNED from a
// shared service helper unvalidated.

import { join } from "node:path";
import * as ts from "typescript";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

const SERVICE_DIRS = [
  join(ROOT, "artifacts/api-server/src/lib"),
  join(ROOT, "artifacts/api-server/src/brain"),
];

// Identity-preserving array operations: the result still holds the original raw
// Candle objects, so returning one is still a raw leak. `.map` / `.flatMap`
// are deliberately EXCLUDED — they transform candles into another shape and
// mark the legitimate internal-consumer boundary.
const IDENTITY_CHAIN_METHODS = new Set([
  "filter",
  "slice",
  "concat",
  "reverse",
  "sort",
  "flat",
]);

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isSatisfiesExpression(e)) e = e.expression;
    else break;
  }
  return e;
}

function bindingKey(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * Analyse one service source file and return human-readable violation strings.
 * Exported so the regression suite can exercise it on synthetic snippets.
 */
export function analyzeChartTruthServiceBypass(src: string, filePath = "service.ts"): string[] {
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  const routeCandlesNames = new Set<string>(["routeCandles"]);
  const collectImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const spec of node.importClause.namedBindings.elements) {
        const imported = spec.propertyName?.text ?? spec.name.text;
        if (imported === "routeCandles") routeCandlesNames.add(spec.name.text);
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(sf);

  function calleeIsRouteCandles(call: ts.CallExpression): boolean {
    const c = call.expression;
    if (ts.isIdentifier(c)) return routeCandlesNames.has(c.text);
    if (ts.isPropertyAccessExpression(c)) return c.name.text === "routeCandles";
    return false;
  }
  function isRouteCandlesCall(expr: ts.Expression): boolean {
    const u = unwrap(expr);
    return ts.isCallExpression(u) && calleeIsRouteCandles(u);
  }

  const tainted = new Set<string>();
  const candleArrayVars = new Set<string>();

  function isCandlesElementAccess(n: ts.ElementAccessExpression): boolean {
    const arg = n.argumentExpression;
    return (
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === "candles"
    );
  }

  // Resolves to the raw-candle SOURCE OBJECT (the whole routed result).
  function resolvesToRawSourceObject(expr: ts.Expression): boolean {
    const u = unwrap(expr);
    if (ts.isIdentifier(u) && tainted.has(u.text)) return true;
    if (ts.isCallExpression(u) && calleeIsRouteCandles(u)) return true;
    if (
      ts.isBinaryExpression(u) &&
      (u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        u.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return resolvesToRawSourceObject(u.left) || resolvesToRawSourceObject(u.right);
    }
    if (ts.isConditionalExpression(u)) {
      return resolvesToRawSourceObject(u.whenTrue) || resolvesToRawSourceObject(u.whenFalse);
    }
    return false;
  }

  // Resolves to a raw candle ARRAY still carrying unvalidated Candle objects.
  function derivesFromRawCandles(expr: ts.Expression): boolean {
    const u = unwrap(expr);
    if (ts.isPropertyAccessExpression(u) && u.name.text === "candles") {
      return resolvesToRawSourceObject(u.expression);
    }
    if (ts.isElementAccessExpression(u) && isCandlesElementAccess(u)) {
      return resolvesToRawSourceObject(u.expression);
    }
    if (ts.isIdentifier(u) && candleArrayVars.has(u.text)) return true;
    // Identity-preserving array-method chain (NOT map/flatMap).
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression)) {
      if (IDENTITY_CHAIN_METHODS.has(u.expression.name.text)) {
        return derivesFromRawCandles(u.expression.expression);
      }
    }
    // `<rawCandles> ?? []` / `<rawCandles> || []`
    if (
      ts.isBinaryExpression(u) &&
      (u.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        u.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return derivesFromRawCandles(u.left) || derivesFromRawCandles(u.right);
    }
    if (ts.isConditionalExpression(u)) {
      return derivesFromRawCandles(u.whenTrue) || derivesFromRawCandles(u.whenFalse);
    }
    return false;
  }

  // Pass 1: collect raw sources (variables assigned from routeCandles()).
  const collectTaint = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (isRouteCandlesCall(node.initializer)) tainted.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isRouteCandlesCall(node.right)
    ) {
      tainted.add(node.left.text);
    }
    ts.forEachChild(node, collectTaint);
  };
  collectTaint(sf);

  // Pass 2: collect derived raw-candle-array variables to a fixpoint.
  const addCandleArrayVar = (name: string): boolean => {
    if (candleArrayVars.has(name)) return false;
    candleArrayVars.add(name);
    return true;
  };

  const handleObjectBinding = (pattern: ts.ObjectBindingPattern, init: ts.Expression): boolean => {
    if (!resolvesToRawSourceObject(init)) return false;
    let changed = false;
    for (const el of pattern.elements) {
      const srcKey = el.propertyName
        ? bindingKey(el.propertyName)
        : bindingKey(el.name as ts.PropertyName);
      if (srcKey === "candles" && ts.isIdentifier(el.name)) {
        if (addCandleArrayVar(el.name.text)) changed = true;
      }
    }
    return changed;
  };

  const handleObjectLiteralAssign = (
    lhs: ts.ObjectLiteralExpression,
    rhs: ts.Expression,
  ): boolean => {
    if (!resolvesToRawSourceObject(rhs)) return false;
    let changed = false;
    for (const prop of lhs.properties) {
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "candles") {
        if (addCandleArrayVar(prop.name.text)) changed = true;
      } else if (
        ts.isPropertyAssignment(prop) &&
        bindingKey(prop.name) === "candles" &&
        ts.isIdentifier(prop.initializer)
      ) {
        if (addCandleArrayVar(prop.initializer.text)) changed = true;
      }
    }
    return changed;
  };

  let grew = true;
  while (grew) {
    grew = false;
    const collectArrays = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && derivesFromRawCandles(node.initializer)) {
          if (addCandleArrayVar(node.name.text)) grew = true;
        } else if (ts.isObjectBindingPattern(node.name)) {
          if (handleObjectBinding(node.name, node.initializer)) grew = true;
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(node.left) && derivesFromRawCandles(node.right)) {
          if (addCandleArrayVar(node.left.text)) grew = true;
        } else if (ts.isObjectLiteralExpression(node.left)) {
          if (handleObjectLiteralAssign(node.left, node.right)) grew = true;
        }
      }
      ts.forEachChild(node, collectArrays);
    };
    collectArrays(sf);
  }

  // Does an expression returned from a helper carry the whole raw source object
  // (e.g. `return routed;` / `return routed ?? fallbackResult;`)? A member
  // access into it (`routed.candles`) is handled by the candle-array path.
  function isReturnedWholeRawSource(expr: ts.Expression): boolean {
    const u = unwrap(expr);
    if (ts.isPropertyAccessExpression(u) || ts.isElementAccessExpression(u)) return false;
    return resolvesToRawSourceObject(u);
  }

  const violations = new Set<string>();
  const here = filePath === "service.ts" ? filePath : rel(filePath);

  const RAW_ARRAY_MSG = `Service file ${here} RETURNS a raw routeCandles() candle array without passing it through getChartCandles/runCandleTruth/normalizeCandles — a caller can forward these unvalidated candles, bypassing the OHLC integrity gate. Map/transform the candles into another shape, or validate them, before returning.`;
  const RAW_OBJECT_MSG = `Service file ${here} RETURNS the raw routeCandles() result object (carrying unvalidated candles) without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`;
  const RAW_FIELD_MSG = `Service file ${here} assigns a raw routeCandles() candle array to a \`candles\` field without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`;

  const checkReturnedExpr = (expr: ts.Expression): void => {
    if (derivesFromRawCandles(expr)) violations.add(RAW_ARRAY_MSG);
    else if (isReturnedWholeRawSource(expr)) violations.add(RAW_OBJECT_MSG);
  };

  const detect = (node: ts.Node): void => {
    // (a) raw candles leaving via a `return` statement.
    if (ts.isReturnStatement(node) && node.expression) {
      checkReturnedExpr(node.expression);
    }
    // (a') raw candles leaving via a concise arrow-function body.
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      checkReturnedExpr(node.body);
    }

    // (b) raw candles assigned to a `candles:` object-literal property anywhere.
    if (ts.isPropertyAssignment(node) && bindingKey(node.name) === "candles") {
      if (derivesFromRawCandles(node.initializer)) violations.add(RAW_FIELD_MSG);
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === "candles" &&
      candleArrayVars.has(node.name.text)
    ) {
      violations.add(RAW_FIELD_MSG);
    }

    ts.forEachChild(node, detect);
  };
  detect(sf);

  return [...violations];
}

export function checkChartTruthServiceBypass(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  let serviceFiles: string[] = [];
  for (const dir of SERVICE_DIRS) {
    try {
      serviceFiles.push(
        ...walk(dir, {
          exts: [".ts"],
          skip: (p) => p.includes("node_modules") || p.includes("dist") || p.endsWith(".test.ts"),
        }),
      );
    } catch {
      // A missing brain/ dir is acceptable; a missing lib/ dir is a real problem.
      if (dir.endsWith("/lib")) {
        return {
          name: "chart-truth-service-bypass",
          ok: false,
          violations: [`service directory not found (${rel(dir)})`],
        };
      }
    }
  }

  let routeCandlesFiles = 0;
  for (const f of serviceFiles) {
    let src: string;
    try {
      src = read(f);
    } catch {
      continue;
    }
    if (!/routeCandles\b/.test(src)) continue;
    routeCandlesFiles++;
    violations.push(...analyzeChartTruthServiceBypass(src, f));
  }

  notes.push(
    `AST-scanned ${serviceFiles.length} service file(s) under lib/ + brain/; ${routeCandlesFiles} reference routeCandles.`,
  );
  notes.push(
    "Per-flow taint (incl. destructuring + import aliases): a shared helper may never RETURN raw routeCandles() candles; map/transform/count uses pass ✓",
  );

  return {
    name: "chart-truth-service-bypass",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
