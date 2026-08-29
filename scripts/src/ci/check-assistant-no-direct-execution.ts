// CI guard — assistant-no-direct-execution (Task #750, hardened in #755,
// provenance-aware in the follow-up).
//
// Eleanor ("Ruby") is a permission-bounded executor, NEVER a second execution
// path. Every Ruby trade action (OPEN / CLOSE / MODIFY / watch-fire) MUST route
// through the existing instant-trade router (`executeInstant` via the
// `recordAndExecuteRuby` ledger boundary) → live command pipeline → 23-gate
// Phase B dispatch. The assistant route must therefore NEVER:
//   - insert directly into any broker command table (mt5 demo/live command
//     queues, arx live commands),
//   - call the legacy `/api/me/trades/close` bypass,
//   - call a broker order-send primitive directly.
//
// A future edit that adds any of these would silently bypass the gate stack.
// This guard locks the invariant at build time. Comments are stripped so
// doc-comment prose that mentions these tokens never trips a false positive.
//
// ── Aliased / indirect bypass hardening ──────────────────────────────────────
// A pure name-scan can be defeated by importing a forbidden symbol under a
// different name. This guard closes the two tractable, deterministic alias
// vectors:
//   1. LOCAL alias — `import { mt5CommandsTable as q } ...; db.insert(q)`. We
//      parse the assistant route's own import specifiers, map every `X as Y`
//      whose `X` is a forbidden symbol, and ban the local binding `Y` too.
//      (Kept strict/name-based: the assistant's own imports are the most direct
//      vector and `pgTable`/order-send names do not collide in practice.)
//   2. CROSS-FILE re-export alias — another module does
//      `export { mt5CommandsTable as commandQueue }` and the assistant imports
//      `commandQueue`. We walk the api-server + db source trees for such one-hop
//      re-export aliases of the forbidden symbols and ban those bindings.
//
// ── Provenance-aware re-export resolution (this upgrade) ─────────────────────
// The earlier re-export detection was purely NAME-BASED: any one-hop
// `export { X as Y }` whose left-hand name `X` matched a forbidden symbol was
// banned, regardless of where `X` actually came from. That is security-favorable
// but over-bans — an unrelated module that happens to export a same-named symbol
// would be flagged. We now resolve each re-export's PROVENANCE one hop:
//   • We trace the re-exported symbol back to its true original name + source
//     module (un-aliasing a `import { Orig as X }` local binding for bare
//     `export { X as Y }`, or taking the `from "..."` source directly).
//   • A re-export is GENUINE (banned) only when the original name is forbidden
//     AND its source resolves to a curated forbidden-origin module/specifier
//     (`FORBIDDEN_ORIGINS`) — the real command-table / order-send homes.
//   • An unrelated same-named export whose source resolves to a NON-forbidden
//     module that genuinely AND INDEPENDENTLY defines its own symbol (i.e. not a
//     launder of a forbidden import) is NOT flagged.
//   • FAIL CLOSED: if the original name is forbidden but provenance cannot be
//     resolved safely within one hop (external/unresolvable specifier, a missing
//     local binding, a resolved file that does not itself define the symbol —
//     i.e. a multi-hop chain — or a same-name TRAMPOLINE that merely re-binds a
//     forbidden import under the same name), the alias is still banned.
// `FORBIDDEN_ORIGINS` is integrity-checked at runtime: if a curated origin file
// no longer defines its symbol (moved/renamed), the guard FAILS LOUDLY rather
// than silently losing provenance, so the curation cannot rot unnoticed.
//
// Out of scope (documented, deferred to human review — see the import-boundary
// escape-ladder memory): reflection / dynamic string-built identifiers
// (`tableRegistry["mt5"+"CommandsTable"]`), MULTI-HOP re-export chains (we fail
// closed on these rather than follow them), and a bypass buried inside an
// arbitrary helper in a third file that the assistant merely calls. A static
// name-scan cannot soundly resolve those without a full type-aware call-graph.
import { join, posix } from "node:path";
import { ROOT, walk, read, rel, reportResult, type CheckResult } from "./_lib.js";

const ASSISTANT_ROUTE = "artifacts/api-server/src/routes/meAssistant.ts";

// Source trees scanned for re-export aliases of the forbidden symbols.
const REEXPORT_SCAN_ROOTS = ["artifacts/api-server/src", "lib/db/src"];

// Forbidden command/order tables — a direct insert into any of these queues
// bypasses executeInstant + the live pipeline + the 23-gate dispatch.
export const FORBIDDEN_TABLE_SYMBOLS = [
  "mt5CommandsTable",
  "mt5DemoCommandsTable",
  "arxLiveCommandsTable",
] as const;

// Forbidden broker order-send primitives / legacy chokepoint.
export const FORBIDDEN_ORDER_SEND_SYMBOLS = [
  "orderSend",
  "placeOrder",
  "placeLiveOrderGuarded",
] as const;

const ALL_FORBIDDEN_SYMBOLS: readonly string[] = [
  ...FORBIDDEN_TABLE_SYMBOLS,
  ...FORBIDDEN_ORDER_SEND_SYMBOLS,
];

// Curated, runtime-verified provenance for each forbidden symbol: the real
// module(s) that genuinely define / export it. A re-export alias is treated as a
// GENUINE forbidden alias only when its original name resolves (one hop) to one
// of these — `files` are repo-relative source paths, `specifiers` are the bare
// import specifiers (package barrels) under which the symbol is legitimately
// reachable. A symbol with NO known in-repo origin (e.g. `orderSend`, a
// broker-side primitive) keeps empty origins and is treated strictly: any
// re-export of that name fails closed because no source can prove it unrelated.
export type OriginConfig = Record<
  string,
  { files: readonly string[]; specifiers: readonly string[] }
>;

const DB_SPECIFIERS = ["@workspace/db", "@workspace/db/schema"] as const;

export const FORBIDDEN_ORIGINS: OriginConfig = {
  mt5CommandsTable: {
    files: ["lib/db/src/schema/mt5Commands.ts"],
    specifiers: [...DB_SPECIFIERS],
  },
  mt5DemoCommandsTable: {
    files: ["lib/db/src/schema/mt5DemoExecution.ts"],
    specifiers: [...DB_SPECIFIERS],
  },
  arxLiveCommandsTable: {
    files: ["lib/db/src/schema/arxLiveExecution.ts"],
    specifiers: [...DB_SPECIFIERS],
  },
  placeOrder: {
    files: ["artifacts/api-server/src/lib/adminTrading/placeOrder.ts"],
    specifiers: [],
  },
  placeLiveOrderGuarded: {
    files: [
      "artifacts/api-server/src/lib/adminTrading/placeOrder.ts",
      "artifacts/api-server/src/lib/liveTrading/guard.ts",
    ],
    specifiers: [],
  },
  orderSend: { files: [], specifiers: [] },
};

export type ForbiddenAlias = { id: string; kind: "table" | "fn"; origin: string };

export type Needle = { rx: RegExp; why: string };

// Strip comments WITHOUT shifting line/column positions, so a violation can be
// pinpointed back to the exact `line:col` in the original source file. Block
// comments are blanked to spaces (newlines preserved) and whole-line `//`
// comments are blanked to an empty line that is KEPT in place. Earlier this
// removed those lines outright, which silently drifted every reported line
// number below a comment — making the guard point at the wrong code.
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

function symbolKind(sym: string): "table" | "fn" | null {
  if ((FORBIDDEN_TABLE_SYMBOLS as readonly string[]).includes(sym)) return "table";
  if ((FORBIDDEN_ORDER_SEND_SYMBOLS as readonly string[]).includes(sym)) return "fn";
  return null;
}

// Does `src` contain a genuine top-level declaration of `sym` (const/let/var/
// function/class, export optional)? Used to verify curated origins.
function definesSymbol(src: string, sym: string): boolean {
  const rx = new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var|class|(?:async\\s+)?function)\\s+${escapeRe(sym)}\\b`,
  );
  return rx.test(stripComments(src));
}

// Does `src` INDEPENDENTLY define `sym` — i.e. a genuine FRESH declaration, not a
// launder/re-binding of some (possibly forbidden) imported value carrying the
// same name? This is the precision/fail-closed crux that earns the "unrelated
// same-name" exemption, and it must be sound WITHOUT recursive provenance
// tracing (multi-hop tracing is explicitly out of scope — we fail closed there).
//
// Two definition shapes are distinguished:
//   • A `function` / `class` declaration creates a DEFINITIONALLY-FRESH binding:
//     `export function placeOrder() { … }` is a brand-new function object, not an
//     alias of any imported value, so it is genuinely a different same-named
//     symbol → independent. (A wrapper whose BODY happens to call a forbidden
//     primitive is the explicitly out-of-scope "forbidden call buried in a helper
//     that X merely calls" case — indistinguishable by text scan from the
//     thousands of legitimate functions, incl. the REQUIRED executeInstant, that
//     reach the pipeline; that boundary belongs to the fenced architecture +
//     review, not this regex.)
//   • A `const`/`let`/`var` binding is independent ONLY when its initializer
//     CONSTRUCTS a fresh value (a call / object / array / literal / `new` /
//     template). When the initializer is a bare identifier or a member-access
//     chain — `const mt5CommandsTable = t` or `= db.mt5CommandsTable` or `= u` —
//     the binding IS (a re-binding of) another value and can never be proven
//     non-forbidden within one hop, so it FAILS CLOSED. This single check closes
//     named-import, namespace-import (`import * as db`), default-import, and
//     renamed-hop laundering uniformly, because every such launder ends in an
//     identifier/member re-binding regardless of how the value was imported.
function independentlyDefinesSymbol(src: string, sym: string): boolean {
  const stripped = stripComments(src);
  const fnClass = new RegExp(
    `\\b(?:export\\s+)?(?:default\\s+)?(?:(?:async\\s+)?function|class)\\s+${escapeRe(sym)}\\b`,
  );
  if (fnClass.test(stripped)) return true;

  const decl = new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRe(sym)}\\s*=\\s*([^;\\n]+)`,
  );
  const m = decl.exec(stripped);
  if (m === null) return false; // no recognised fresh definition → fail closed
  // POSITIVE proof required: independence is granted ONLY when the initializer is
  // a tightly-curated fresh-value construction (see isFreshConstruction). Every
  // other shape — bare/parenthesised identifier, dotted OR bracket member-access,
  // type-asserted reference, an arbitrary wrapper call (`id(t)`), or a `new` —
  // is (or may launder) a re-binding of an existing, possibly forbidden value and
  // FAILS CLOSED.
  return isFreshConstruction(m[1]);
}

// Is `rhs` a positively-recognised fresh-value construction (so the bound symbol
// is genuinely NEW, not an alias/launder of an existing value)? Deliberately a
// TIGHT allowlist — anything not matched returns false (fail closed). Only two
// classes can be proven fresh in one hop without a real parser:
//   • a fresh FUNCTION value — arrow / function / generator expression — whose
//     binding is a brand-new function object (a wrapper body that calls a
//     forbidden primitive is the documented out-of-scope helper case, identical to
//     the function-DECLARATION boundary above); and
//   • a curated drizzle table-builder CALL (`pgTable`/`pgView`/`pgMaterializedView`)
//     that constructs a brand-new table under its own name — provably not the
//     forbidden table. An ARBITRARY call (`id(t)`, `wrap.make(t)`) or `new X(t)`
//     could RETURN/embed an existing forbidden reference, so it is NOT exempt.
// Pathological launders (IIFE `(()=>t)()`, computed reflection, char-code
// construction) remain out of scope — they require AST/runtime evaluation and
// belong to the fenced architecture + human review, per the guard doctrine.
function isFreshConstruction(rhs: string): boolean {
  const s = rhs.trim().replace(/^await\s+/, "");
  if (/^(?:async\s+)?function\b/.test(s)) return true; // function/async-function expression
  if (/^(?:async\s+)?\*?\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s)) return true; // arrow
  if (/^(?:pgTable|pgView|pgMaterializedView)\s*\(/.test(s)) return true; // curated table builder
  return false;
}

// Base forbidden needles built from the symbol lists. Tables are banned as bare
// identifiers; order-send helpers are banned as call sites; the legacy close URL
// is banned as a string literal.
const BASE_FORBIDDEN: Needle[] = [
  ...FORBIDDEN_TABLE_SYMBOLS.map((s) => ({
    rx: new RegExp(`\\b${escapeRe(s)}\\b`),
    why: `direct use of the ${s} command queue — must route through executeInstant`,
  })),
  ...FORBIDDEN_ORDER_SEND_SYMBOLS.map((s) => ({
    rx: new RegExp(`\\b${escapeRe(s)}\\s*\\(`),
    why: `direct call to ${s} — the assistant must never touch a broker order-send primitive`,
  })),
  {
    rx: /["'`][^"'`]*\/api\/me\/trades\/close[^"'`]*["'`]/,
    why: "legacy /api/me/trades/close bypass must not be used by the assistant",
  },
];

// The sanctioned execution path must remain present. Each scanned route declares
// WHICH sanctioned anchors it must contain — they differ per surface:
//   • the assistant route flows through the append-only Ruby ledger boundary
//     (`recordAndExecuteRuby`) before reaching `executeInstant`;
//   • the chart/scanner instant-trade router calls `executeInstant` directly.
// Both must dispatch through `executeInstant`; only the assistant carries the
// extra ledger boundary.
export const ASSISTANT_REQUIRED: Needle[] = [
  { rx: /\bexecuteInstant\b/, why: "the assistant must dispatch through the instant-trade router (executeInstant)" },
  { rx: /\brecordAndExecuteRuby\b/, why: "every Ruby trade action must flow through the append-only ledger boundary" },
];

// Back-compat alias for the original (assistant-only) name.
const REQUIRED = ASSISTANT_REQUIRED;

// Parse `import { ... } from "..."` specifiers in `stripped` and return every
// LOCAL binding that aliases a forbidden symbol (`X as Y` where X is forbidden).
export function resolveLocalAliases(stripped: string): ForbiddenAlias[] {
  const out: ForbiddenAlias[] = [];
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    for (const spec of m[1].split(",")) {
      const mm = spec.trim().match(/^(\w+)\s+as\s+(\w+)$/);
      if (!mm) continue;
      const kind = symbolKind(mm[1]);
      if (kind) out.push({ id: mm[2], kind, origin: "local-alias" });
    }
  }
  return out;
}

function aliasNeedle(a: ForbiddenAlias): Needle {
  const rx =
    a.kind === "table"
      ? new RegExp(`\\b${escapeRe(a.id)}\\b`)
      : new RegExp(`\\b${escapeRe(a.id)}\\s*\\(`);
  return {
    rx,
    why: `aliased ${a.kind === "table" ? "command-table" : "order-send"} binding "${a.id}" (alias of a forbidden symbol via ${a.origin}) — must route through executeInstant`,
  };
}

// Pure, testable scanner shared by every no-direct-execution guard.
// `extraAliases` carries cross-file re-export aliases discovered by the caller;
// local `as` aliases are resolved from `src` itself. `required` declares the
// sanctioned-path anchors the scanned route MUST contain (defaults to the
// assistant's executeInstant + recordAndExecuteRuby).
export function scanForViolations(
  src: string,
  extraAliases: ForbiddenAlias[] = [],
  required: Needle[] = ASSISTANT_REQUIRED,
): string[] {
  const stripped = stripComments(src);
  const aliases = [...extraAliases, ...resolveLocalAliases(stripped)];
  const needles = [...BASE_FORBIDDEN, ...aliases.map(aliasNeedle)];

  const violations: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const { rx, why } of needles) {
      // `exec` (the needles are non-global) gives the exact match index so we
      // can report `line:col` + the precise off-limits token, not just the line.
      const m = rx.exec(line);
      if (m !== null) {
        const col = m.index + 1;
        const token = m[0].trim();
        violations.push(
          `:${i + 1}:${col} [${why}] off-limits code \`${token}\` → ${line.trim().slice(0, 120)}`,
        );
      }
    }
  });
  for (const { rx, why } of required) {
    if (!rx.test(stripped)) {
      violations.push(`: MISSING sanctioned execution path — ${why}`);
    }
  }
  return violations;
}

// Back-compat wrapper retaining the original assistant-route signature.
export function scanAssistantForViolations(
  src: string,
  extraAliases: ForbiddenAlias[] = [],
): string[] {
  return scanForViolations(src, extraAliases, ASSISTANT_REQUIRED);
}

// ── Provenance resolution helpers ────────────────────────────────────────────

// Resolve a RELATIVE module specifier imported from `fromRel` to a repo-relative
// file path present in `fileKeys`, honouring the TS-ESM `.js`→`.ts` convention
// and `index.ts` folder modules. Returns null for non-relative specifiers
// (package/alias imports — those are matched via curated `specifiers`) and for
// relative paths that do not resolve to a scanned file.
export function resolveModuleSpecifier(
  fromRel: string,
  spec: string,
  fileKeys: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const baseDir = posix.dirname(fromRel.replace(/\\/g, "/"));
  const target = posix.normalize(posix.join(baseDir, spec)).replace(/\\/g, "/");
  const cands: string[] = [];
  if (target.endsWith(".js")) {
    const stem = target.slice(0, -3);
    cands.push(`${stem}.ts`, `${stem}.tsx`, posix.join(stem, "index.ts"));
  } else if (target.endsWith(".ts") || target.endsWith(".tsx")) {
    cands.push(target);
  }
  cands.push(`${target}.ts`, `${target}.tsx`, posix.join(target, "index.ts"), target);
  for (const c of cands) if (fileKeys.has(c)) return c;
  return null;
}

type ImportBinding = { original: string; module: string };

// Map every named local binding in `stripped` to its original export name +
// source module (`import { a, b as c } from "M"` → a→{a,M}, c→{b,M}).
function parseNamedImports(stripped: string): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(stripped)) !== null) {
    const module = m[2];
    for (const spec of m[1].split(",")) {
      const mm = spec.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (!mm) continue;
      const original = mm[1];
      const local = mm[2] ?? mm[1];
      out.set(local, { original, module });
    }
  }
  return out;
}

type ReexportSpec = { original: string; exported: string; from: string | null };

// Extract every `export { ... }` / `export { ... } from "..."` re-export spec.
function parseReexports(stripped: string): ReexportSpec[] {
  const out: ReexportSpec[] = [];
  const re = /export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const from = m[2] ?? null;
    for (const spec of m[1].split(",")) {
      const mm = spec.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (!mm) continue;
      out.push({ original: mm[1], exported: mm[2] ?? mm[1], from });
    }
  }
  return out;
}

// Verify the curated `FORBIDDEN_ORIGINS` against the real file map. A declared
// origin file that is missing or no longer defines its symbol is an integrity
// failure (the guard must fail loudly, never silently lose provenance).
export function buildOriginIntegrity(
  files: ReadonlyMap<string, string>,
  origins: OriginConfig = FORBIDDEN_ORIGINS,
): string[] {
  const issues: string[] = [];
  for (const sym of Object.keys(origins)) {
    for (const f of origins[sym].files) {
      const src = files.get(f);
      if (src === undefined) {
        issues.push(`curated origin "${f}" for forbidden symbol "${sym}" was not found in the scanned source tree — fix FORBIDDEN_ORIGINS`);
      } else if (!definesSymbol(src, sym)) {
        issues.push(`curated origin "${f}" no longer defines forbidden symbol "${sym}" (moved/renamed?) — fix FORBIDDEN_ORIGINS`);
      }
    }
  }
  return issues;
}

// Pure, testable provenance-aware collector. Given an in-memory map of
// repo-relative path → RAW source for the scanned trees, return the set of
// re-export alias bindings that GENUINELY trace (one hop) to a forbidden origin
// or whose provenance cannot be safely resolved (fail closed).
export function collectReexportAliasesFromFiles(
  files: ReadonlyMap<string, string>,
  origins: OriginConfig = FORBIDDEN_ORIGINS,
): ForbiddenAlias[] {
  const fileKeys = new Set(files.keys());
  const out: ForbiddenAlias[] = [];

  for (const [fileRel, raw] of files) {
    const stripped = stripComments(raw);
    if (!stripped.includes("export")) continue;
    const reexports = parseReexports(stripped);
    if (reexports.length === 0) continue;
    const imports = parseNamedImports(stripped);

    for (const rx of reexports) {
      // Resolve the TRUE original name + source module of the re-exported symbol.
      let original: string;
      let sourceSpec: string | null;
      let sourceMode: "from" | "local-import" | "self" | "unresolved";

      if (rx.from !== null) {
        // `export { X as Y } from "M"` — X is M's own export name.
        original = rx.original;
        sourceSpec = rx.from;
        sourceMode = "from";
      } else {
        // Bare `export { X as Y }` — un-alias X via this file's imports / locals.
        const binding = imports.get(rx.original);
        if (binding) {
          original = binding.original;
          sourceSpec = binding.module;
          sourceMode = "local-import";
        } else if (definesSymbol(raw, rx.original)) {
          original = rx.original;
          sourceSpec = null; // defined right here
          sourceMode = "self";
        } else {
          original = rx.original;
          sourceSpec = null;
          sourceMode = "unresolved";
        }
      }

      const kind = symbolKind(original);
      if (!kind) continue; // not a forbidden symbol at its true origin → ignore

      // Skip same-name no-op re-exports (Y === forbidden literal) — already
      // covered by the BASE_FORBIDDEN direct-name scan; no new binding to ban.
      if (
        rx.exported === original &&
        (ALL_FORBIDDEN_SYMBOLS as readonly string[]).includes(rx.exported)
      ) {
        continue;
      }

      const cfg = origins[original] ?? { files: [], specifiers: [] };

      // GENUINE via a curated package specifier (e.g. tables from @workspace/db).
      if (sourceSpec !== null && cfg.specifiers.includes(sourceSpec)) {
        out.push({ id: rx.exported, kind, origin: `${fileRel} → ${sourceSpec} (forbidden origin)` });
        continue;
      }

      const resolvedFile =
        sourceMode === "self"
          ? fileRel
          : sourceSpec !== null
            ? resolveModuleSpecifier(fileRel, sourceSpec, fileKeys)
            : null;

      if (resolvedFile !== null && cfg.files.includes(resolvedFile)) {
        // GENUINE: resolves to a curated forbidden-origin file.
        out.push({ id: rx.exported, kind, origin: `${fileRel} → ${resolvedFile} (forbidden origin)` });
        continue;
      }

      if (resolvedFile !== null) {
        const resolvedSrc = files.get(resolvedFile);
        if (resolvedSrc !== undefined && independentlyDefinesSymbol(resolvedSrc, original)) {
          // Resolves to a NON-forbidden module that genuinely AND independently
          // defines its own same-named symbol (not a launder of a forbidden
          // import) → unrelated → do NOT ban (precision).
          continue;
        }
        // Resolves to a scanned file that does NOT independently define the
        // symbol — either it does not define it (multi-hop chain) or it launders
        // a forbidden import under the same name (trampoline) → FAIL CLOSED.
        out.push({ id: rx.exported, kind, origin: `${fileRel} → ${resolvedFile} (unresolved provenance — fail closed)` });
        continue;
      }

      // Unresolvable: external/package specifier not curated, or a bare
      // re-export whose local binding could not be traced → FAIL CLOSED.
      out.push({
        id: rx.exported,
        kind,
        origin: `${fileRel} (${sourceMode === "unresolved" ? "untraceable local binding" : `external/unresolved source ${sourceSpec ?? "?"}`} — fail closed)`,
      });
    }
  }
  return out;
}

// Walk the api-server + db source for re-export aliases of forbidden symbols and
// resolve each one's provenance. Returns the genuine/fail-closed alias bindings
// plus any curation-integrity issues to surface as guard failures.
export function collectReexportAliases(): {
  aliases: ForbiddenAlias[];
  integrity: string[];
} {
  const files = new Map<string, string>();
  for (const r of REEXPORT_SCAN_ROOTS) {
    for (const file of walk(join(ROOT, r))) {
      try {
        files.set(rel(file).replace(/\\/g, "/"), read(file));
      } catch {
        continue;
      }
    }
  }
  return {
    aliases: collectReexportAliasesFromFiles(files, FORBIDDEN_ORIGINS),
    integrity: buildOriginIntegrity(files, FORBIDDEN_ORIGINS),
  };
}

export function checkAssistantNoDirectExecution(): CheckResult {
  const abs = join(ROOT, ASSISTANT_ROUTE);
  let src: string;
  try {
    src = read(abs);
  } catch {
    return {
      name: "assistant-no-direct-execution",
      ok: false,
      violations: [`${ASSISTANT_ROUTE}: cannot read (assistant route is missing)`],
    };
  }

  const { aliases, integrity } = collectReexportAliases();
  const violations = scanAssistantForViolations(src, aliases).map(
    (v) => `${ASSISTANT_ROUTE}${v}`,
  );
  // Curation rot is a guard-integrity failure: provenance can no longer be
  // trusted, so fail loudly rather than silently under-ban.
  for (const issue of integrity) {
    violations.push(`FORBIDDEN_ORIGINS integrity: ${issue}`);
  }

  return {
    name: "assistant-no-direct-execution (Ruby routes ONLY through executeInstant, never a 2nd execution path)",
    ok: violations.length === 0,
    violations,
    notes: [
      `scanned ${rel(abs)}`,
      `provenance-resolved re-export alias bindings: ${aliases.length}`,
      `curated forbidden-origin integrity issues: ${integrity.length}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkAssistantNoDirectExecution();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
