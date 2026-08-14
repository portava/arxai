// check-chart-truth-bypass.ts
//
// Static-analysis CI guard: proves that no chart route can silently bypass the
// OHLC integrity gate by shipping raw, unvalidated candles to the client.
//
// The chart-truth pipeline validates OHLC, rejects duplicates, and flags
// outliers inside `runCandleTruth` (candleTruthEngine) / `normalizeCandles`
// (candleNormalization), reached through the canonical entry point
// `getChartCandles` (chartDataService). The complementary risk to the
// mock-leak guard is a NEW route that calls the raw `routeCandles`
// (marketDataRouter) accessor and returns the raw `Candle[]` straight back to
// the client — bypassing all of that validation.
//
// HOW IT WORKS (AST-based per-flow taint analysis, no network/DB):
//
//   For every route file under artifacts/api-server/src/routes:
//
//     1. SOURCE — `routeCandles` is recognised even when imported under an
//        alias (`import { routeCandles as rc }`).
//
//     2. TAINT — Any variable assigned directly from a `routeCandles(...)`
//        call is a raw-candle source. Any value derived from such a source's
//        `.candles` array — including `?? []` / `|| []`, array chains
//        (`.map`/`.filter`/…), AND object destructuring
//        (`const { candles } = routed`, `const { candles: c } = routed`,
//        `({ candles } = routed)`) — is a raw-candle array.
//
//     3. SINK — A raw-candle value is a VIOLATION when it flows into the
//        client, detected as:
//          a. the raw `.candles` array (or a derived candle-array variable)
//             appearing inside a response call — `res.json(...)`,
//             `res.send(...)`, `res.jsonp(...)`, including chained forms such
//             as `res.status(200).json(...)` and inline
//             `res.json((await routeCandles(...)).candles)`; OR
//          b. a raw-candle value assigned to a `candles:` property of ANY
//             object literal (the canonical chart-response shape), which
//             catches the `const out = { candles: routed.candles }; res.json(out)`
//             indirection.
//        `<src>.candles.length` (a count) is explicitly allowed.
//
//   Because taint is tracked PER VALUE (only raw `routeCandles` results are
//   tainted; values returned by `getChartCandles`/`runCandleTruth`/
//   `normalizeCandles` are NOT), a file is judged flow-by-flow: one endpoint
//   serving validated candles via `getChartCandles` does not excuse another
//   endpoint in the same file leaking raw `routeCandles().candles`.
//
// This is intentionally precise rather than "every routeCandles call must be
// wrapped": internal-only uses (computing ATR/volatility, or an admin probe
// that returns `candles.length`) are legitimate and must keep passing. The
// guard exits 1 only if a raw candle array can reach the client unvalidated.

import { join } from "node:path";
import * as ts from "typescript";
import type { CheckResult } from "./_lib.js";
import { ROOT, walk, read, rel } from "./_lib.js";

const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");

const RESPONSE_METHODS = new Set(["json", "send", "jsonp"]);
const RESPONSE_ROOTS = new Set(["res", "response", "reply"]);
const ARRAY_CHAIN_METHODS = new Set([
  "map",
  "filter",
  "slice",
  "concat",
  "reverse",
  "sort",
  "flat",
  "flatMap",
]);

// Strip away wrappers that don't change identity of the underlying expression.
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
 * Analyse one route source file and return human-readable violation strings.
 * Exported so the regression suite can exercise it on synthetic snippets.
 */
export function analyzeChartTruthBypass(src: string, filePath = "route.ts"): string[] {
  const sf = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  // Local names that refer to the imported `routeCandles` (alias-aware).
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

  // Variables assigned directly from a routeCandles(...) call — raw sources.
  const tainted = new Set<string>();
  // Variables derived from a raw source's `.candles` array — raw candle arrays.
  const candleArrayVars = new Set<string>();

  // Does this expression resolve to the raw-candle SOURCE OBJECT (the routed
  // result), e.g. `routed`, `await routeCandles(...)`, `routed ?? {}`.
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
    return false;
  }

  // Does this expression resolve to a raw candle ARRAY (not yet validated)?
  function derivesFromRawCandles(expr: ts.Expression): boolean {
    const u = unwrap(expr);
    if (ts.isPropertyAccessExpression(u) && u.name.text === "candles") {
      return resolvesToRawSourceObject(u.expression);
    }
    if (ts.isElementAccessExpression(u) && isCandlesElementAccess(u)) {
      return resolvesToRawSourceObject(u.expression);
    }
    if (ts.isIdentifier(u) && candleArrayVars.has(u.text)) return true;
    // Array-method chain: `<rawCandles>.map(...)`, `.filter(...)`, etc.
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression)) {
      if (ARRAY_CHAIN_METHODS.has(u.expression.name.text)) {
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
    return false;
  }

  function isCandlesElementAccess(n: ts.ElementAccessExpression): boolean {
    const arg = n.argumentExpression;
    return (
      (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === "candles"
    );
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

  // Pass 2: collect derived raw-candle-array variables. Iterate to a fixpoint
  // so chains across multiple declarations resolve.
  const addCandleArrayVar = (name: string): boolean => {
    if (candleArrayVars.has(name)) return false;
    candleArrayVars.add(name);
    return true;
  };

  // From an object binding pattern destructuring a raw source, mark the local
  // bound to the `candles` key as a candle-array var.
  const handleObjectBinding = (
    pattern: ts.ObjectBindingPattern,
    init: ts.Expression,
  ): boolean => {
    if (!resolvesToRawSourceObject(init)) return false;
    let changed = false;
    for (const el of pattern.elements) {
      const srcKey = el.propertyName ? bindingKey(el.propertyName) : bindingKey(el.name as ts.PropertyName);
      if (srcKey === "candles" && ts.isIdentifier(el.name)) {
        if (addCandleArrayVar(el.name.text)) changed = true;
      }
    }
    return changed;
  };

  // Destructuring assignment: `({ candles } = routed)` / `({ candles: c } = routed)`.
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
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
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

  // Identify a response sink call: callee `.json`/`.send`/`.jsonp` whose
  // member chain roots at `res`/`response`/`reply` (covers `res.status().json`).
  function chainRoot(expr: ts.Expression): ts.Expression {
    let e: ts.Node = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(e)) e = e.expression;
      else if (ts.isElementAccessExpression(e)) e = e.expression;
      else if (ts.isCallExpression(e)) e = e.expression;
      else break;
    }
    return e as ts.Expression;
  }
  function isResponseSink(call: ts.CallExpression): boolean {
    const c = call.expression;
    if (!ts.isPropertyAccessExpression(c)) return false;
    if (!RESPONSE_METHODS.has(c.name.text)) return false;
    const root = chainRoot(c.expression);
    return ts.isIdentifier(root) && RESPONSE_ROOTS.has(root.text);
  }

  // Is `n` a raw source OBJECT (the whole routeCandles result) used as a value
  // — e.g. `res.json(routed)` or inline `res.json(await routeCandles(...))`?
  // A member access into it (`routed.candles`, `routed.ok`, `routed.candles.length`)
  // is NOT the whole object and is handled by the candle-array path instead.
  function isRawSourceObjectValue(n: ts.Node): boolean {
    if (ts.isIdentifier(n) && tainted.has(n.text)) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && p.name === n) return false;
      if (ts.isBindingElement(p)) return false;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) return false;
      if (ts.isElementAccessExpression(p) && p.expression === n) return false;
      if (ts.isPropertyAssignment(p) && p.name === n) return false;
      if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        return false;
      }
      return true;
    }
    if (ts.isCallExpression(n) && calleeIsRouteCandles(n)) {
      let cur: ts.Node = n;
      let par = cur.parent;
      while (
        par &&
        (ts.isParenthesizedExpression(par) ||
          ts.isAwaitExpression(par) ||
          ts.isAsExpression(par) ||
          ts.isNonNullExpression(par) ||
          ts.isSatisfiesExpression(par))
      ) {
        cur = par;
        par = par.parent;
      }
      // Accessing into the call result (`.candles`/`.ok`/…) — not the whole object.
      if (
        par &&
        (ts.isPropertyAccessExpression(par) || ts.isElementAccessExpression(par)) &&
        par.expression === cur
      ) {
        return false;
      }
      // Bound to a variable / destructured — taint already tracks those.
      if (par && (ts.isVariableDeclaration(par) || ts.isBindingElement(par))) return false;
      return true;
    }
    return false;
  }

  // Is `n` a raw-candle VALUE being passed as a whole (not a count, not a
  // scalar member access)?
  function isRawCandleValue(n: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(n) && n.name.text === "candles") {
      const parent = n.parent;
      const isCount =
        ts.isPropertyAccessExpression(parent) &&
        parent.name.text === "length" &&
        parent.expression === n;
      if (isCount) return false;
      return resolvesToRawSourceObject(n.expression);
    }
    if (ts.isIdentifier(n) && candleArrayVars.has(n.text)) {
      const p = n.parent;
      // Skip declaration sites and member/element accesses (`c.length`, `c[0]`).
      if (ts.isVariableDeclaration(p) && p.name === n) return false;
      if (ts.isBindingElement(p)) return false;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) return false;
      if (ts.isElementAccessExpression(p) && p.expression === n) return false;
      return true;
    }
    return false;
  }

  const violations = new Set<string>();
  const here = filePath === "route.ts" ? filePath : rel(filePath);

  const detect = (node: ts.Node): void => {
    // (a) raw candles inside a response sink subtree
    if (ts.isCallExpression(node) && isResponseSink(node)) {
      const scan = (n: ts.Node): void => {
        if (isRawCandleValue(n)) {
          violations.add(
            `Route file ${here} returns a raw candle array sourced from routeCandles() in an HTTP response without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`,
          );
        }
        if (isRawSourceObjectValue(n)) {
          violations.add(
            `Route file ${here} returns the raw routeCandles() result object (carrying unvalidated candles) in an HTTP response without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`,
          );
        }
        ts.forEachChild(n, scan);
      };
      for (const arg of node.arguments) scan(arg);
    }

    // (b) raw candles assigned to a `candles:` object-literal property anywhere
    //     (catches `const out = { candles: routed.candles }; res.json(out)`).
    if (ts.isPropertyAssignment(node) && bindingKey(node.name) === "candles") {
      if (derivesFromRawCandles(node.initializer)) {
        violations.add(
          `Route file ${here} assigns a raw routeCandles() candle array to a \`candles\` response field without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`,
        );
      }
    }
    if (
      ts.isShorthandPropertyAssignment(node) &&
      node.name.text === "candles" &&
      candleArrayVars.has(node.name.text)
    ) {
      violations.add(
        `Route file ${here} returns a raw routeCandles() candle array via a \`candles\` response field without passing it through getChartCandles/runCandleTruth/normalizeCandles — this bypasses the OHLC integrity gate.`,
      );
    }

    ts.forEachChild(node, detect);
  };
  detect(sf);

  return [...violations];
}

export function checkChartTruthBypass(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  let routeFiles: string[];
  try {
    routeFiles = walk(ROUTES_DIR, {
      exts: [".ts"],
      skip: (p) => p.includes("node_modules") || p.includes("dist") || p.endsWith(".test.ts"),
    });
  } catch {
    return {
      name: "chart-truth-bypass",
      ok: false,
      violations: [`routes directory not found (${rel(ROUTES_DIR)})`],
    };
  }

  let routeCandlesFiles = 0;

  for (const rf of routeFiles) {
    let src: string;
    try {
      src = read(rf);
    } catch {
      continue;
    }
    if (!/routeCandles\b/.test(src)) continue;
    routeCandlesFiles++;
    violations.push(...analyzeChartTruthBypass(src, rf));
  }

  notes.push(
    `AST-scanned ${routeFiles.length} route file(s); ${routeCandlesFiles} reference routeCandles.`,
  );
  notes.push(
    "Per-flow taint (incl. destructuring + import aliases): raw routeCandles() candle arrays may never reach a client response unvalidated ✓",
  );

  return {
    name: "chart-truth-bypass",
    ok: violations.length === 0,
    violations,
    notes,
  };
}
