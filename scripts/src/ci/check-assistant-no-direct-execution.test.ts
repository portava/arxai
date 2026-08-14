// Regression suite for the assistant-no-direct-execution CI guard (#750/#755).
//
// Exercises the pure `scanAssistantForViolations` against synthetic assistant-
// route snippets. The sanctioned pipeline (executeInstant + recordAndExecuteRuby)
// must stay clean; every direct-execution escape — including ALIASED imports
// (local `as` and cross-file re-export) of a forbidden command table / order-send
// primitive — MUST be flagged. Pure source analysis: no network, DB, or fs.

import {
  scanAssistantForViolations,
  resolveLocalAliases,
  collectReexportAliasesFromFiles,
  buildOriginIntegrity,
  resolveModuleSpecifier,
  type ForbiddenAlias,
  type OriginConfig,
} from "./check-assistant-no-direct-execution.js";

export {};

// A minimal sanctioned tail so the REQUIRED checks are satisfied; append it to
// any "should stay clean" or "should still flag the bypass" snippet so a test
// failure is unambiguously about the forbidden scan, not a MISSING path.
const SANCTIONED = `
  const r = await executeInstant({ source: "ruby_text" });
  await recordAndExecuteRuby(userId, action);
`;

type Case = {
  name: string;
  src: string;
  // Cross-file re-export aliases the real checker would have discovered.
  extra?: ForbiddenAlias[];
  shouldFlag: boolean;
};

const cases: Case[] = [
  // ── Must stay CLEAN ────────────────────────────────────────────────────────
  {
    name: "sanctioned pipeline only (executeInstant + recordAndExecuteRuby)",
    shouldFlag: false,
    src: SANCTIONED,
  },
  {
    name: "doc-comment mentioning a forbidden table is stripped, not flagged",
    shouldFlag: false,
    src: `// never insert into mt5CommandsTable directly\n/* arxLiveCommandsTable is off-limits */\n${SANCTIONED}`,
  },
  {
    name: "similarly-named identifier (mt5CommandsTableName) is not the table",
    shouldFlag: false,
    src: `const mt5CommandsTableName = "x";\nconst placeOrderLabel = "Place order";\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — direct literal escapes ───────────────────────────────
  {
    name: "direct insert into mt5CommandsTable",
    shouldFlag: true,
    src: `import { db, mt5CommandsTable } from "@workspace/db";\nawait db.insert(mt5CommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct arxLiveCommandsTable insert",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable } from "@workspace/db";\nawait db.insert(arxLiveCommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct broker order-send call",
    shouldFlag: true,
    src: `await orderSend({ symbol });\n${SANCTIONED}`,
  },
  {
    name: "legacy /api/me/trades/close bypass string",
    shouldFlag: true,
    src: `await fetch("/api/me/trades/close", { method: "POST" });\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — LOCAL alias bypass (the #755 vector) ──────────────────
  {
    name: "local alias of a command table caught at its usage",
    shouldFlag: true,
    src: `import { mt5CommandsTable as q } from "@workspace/db";\nawait db.insert(q).values({});\n${SANCTIONED}`,
  },
  {
    name: "local alias of an order-send primitive caught at its call site",
    shouldFlag: true,
    src: `import { placeLiveOrderGuarded as fire } from "../lib/liveTrading/guard.js";\nawait fire({ symbol });\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — CROSS-FILE re-export alias bypass (the #755 vector) ───
  {
    name: "imported re-export alias of a command table (no literal token present)",
    shouldFlag: true,
    extra: [{ id: "commandQueue", kind: "table", origin: "lib/db/src/reexport.ts" }],
    src: `import { commandQueue } from "@workspace/db/reexport.js";\nawait db.insert(commandQueue).values({});\n${SANCTIONED}`,
  },
  {
    name: "imported re-export alias of an order-send primitive",
    shouldFlag: true,
    extra: [{ id: "sendItNow", kind: "fn", origin: "artifacts/api-server/src/lib/reexport.ts" }],
    src: `import { sendItNow } from "../lib/reexport.js";\nawait sendItNow({ symbol });\n${SANCTIONED}`,
  },

  // ── Must be FLAGGED — sanctioned path removed ──────────────────────────────
  {
    name: "missing executeInstant + recordAndExecuteRuby is flagged",
    shouldFlag: true,
    src: `const noop = 1;\n`,
  },
];

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}

for (const c of cases) {
  const flags = scanAssistantForViolations(c.src, c.extra ?? []);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    c.name,
    ok,
    ok
      ? c.shouldFlag
        ? `flagged (${flags.length})`
        : "clean"
      : c.shouldFlag
        ? "expected a violation but got none"
        : `expected clean but got: ${flags[0]}`,
  );
}

// Direct unit check on the local-alias resolver: an aliased forbidden import is
// resolved to its local binding with the correct kind.
{
  const aliases = resolveLocalAliases(
    `import { mt5CommandsTable as q, orderSend as fire } from "x";`,
  );
  const hasTable = aliases.some((a) => a.id === "q" && a.kind === "table");
  const hasFn = aliases.some((a) => a.id === "fire" && a.kind === "fn");
  record("resolveLocalAliases maps both table + fn aliases", hasTable && hasFn,
    hasTable && hasFn ? "resolved" : `got ${JSON.stringify(aliases)}`);
}

// ── Provenance-aware re-export resolution ────────────────────────────────────
// `collectReexportAliasesFromFiles` resolves each cross-file `export { X as Y }`
// one hop back to its true origin and only bans bindings that GENUINELY trace to
// a curated forbidden-origin module/specifier — while failing closed when
// provenance cannot be resolved safely. These cases feed synthetic in-memory
// file maps (no fs) and assert exactly which alias bindings are returned.

// A curated origin config mirroring real provenance, scoped to the synthetic
// files below so the cases are self-contained.
const PROV_ORIGINS: OriginConfig = {
  mt5CommandsTable: {
    files: ["lib/db/src/schema/mt5Commands.ts"],
    specifiers: ["@workspace/db", "@workspace/db/schema"],
  },
  placeLiveOrderGuarded: {
    files: ["artifacts/api-server/src/lib/liveTrading/guard.ts"],
    specifiers: [],
  },
  placeOrder: {
    files: ["artifacts/api-server/src/lib/adminTrading/placeOrder.ts"],
    specifiers: [],
  },
  orderSend: { files: [], specifiers: [] },
  mt5DemoCommandsTable: { files: [], specifiers: [] },
  arxLiveCommandsTable: { files: [], specifiers: [] },
};

// Genuine origin sources (so `definesSymbol` integrity + same-name checks work).
const ORIGIN_FILES: Array<[string, string]> = [
  ["lib/db/src/schema/mt5Commands.ts", `export const mt5CommandsTable = pgTable("mt5_commands", {});`],
  ["artifacts/api-server/src/lib/liveTrading/guard.ts", `export async function placeLiveOrderGuarded(a) { return a; }`],
  ["artifacts/api-server/src/lib/adminTrading/placeOrder.ts", `export async function placeOrder(i) { return i; }`],
];

type ProvCase = {
  name: string;
  files: Array<[string, string]>;
  // alias binding names that MUST be returned (banned).
  expectFlagged: string[];
  // alias binding names that MUST NOT be returned.
  expectClean: string[];
};

const provCases: ProvCase[] = [
  // (a) TRUE aliases are caught — relative re-export resolving to the origin file.
  {
    name: "(a) true alias: relative re-export of a command table from its origin file is caught",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/barrel.ts",
        `export { mt5CommandsTable as commandQueue } from "./schema/mt5Commands.js";`,
      ],
    ],
    expectFlagged: ["commandQueue"],
    expectClean: [],
  },
  // (a) TRUE alias via the curated package specifier (bare re-export of a local import).
  {
    name: "(a) true alias: re-export of a table imported from @workspace/db is caught",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/dbAlias.ts",
        `import { mt5CommandsTable } from "@workspace/db";\nexport { mt5CommandsTable as cmds };`,
      ],
    ],
    expectFlagged: ["cmds"],
    expectClean: [],
  },
  // (a) TRUE alias: order-send primitive re-exported from its origin file.
  {
    name: "(a) true alias: re-export of placeLiveOrderGuarded from its origin file is caught",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/fireBarrel.ts",
        `export { placeLiveOrderGuarded as fireNow } from "./liveTrading/guard.js";`,
      ],
    ],
    expectFlagged: ["fireNow"],
    expectClean: [],
  },
  // (b) UNRELATED same-name export does NOT fail — a sibling module genuinely
  // defines its own `placeOrder` unrelated to the broker primitive.
  {
    name: "(b) unrelated same-name export from a non-forbidden module is NOT flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/ui/orderForm.ts",
        `export function placeOrder() { /* renders a UI order card */ }`,
      ],
      [
        "artifacts/api-server/src/ui/barrel.ts",
        `export { placeOrder as submitOrderCard } from "./orderForm.js";`,
      ],
    ],
    expectFlagged: [],
    expectClean: ["submitOrderCard"],
  },
  // (b) UNRELATED via un-aliasing: the re-exported binding's TRUE original name
  // is not forbidden, so the forbidden-looking local alias is ignored.
  {
    name: "(b) bare re-export whose true original is non-forbidden is NOT flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/ui/unalias.ts",
        `import { renderButton as placeOrder } from "./widgets.js";\nexport { placeOrder as place };`,
      ],
      ["artifacts/api-server/src/ui/widgets.ts", `export function renderButton() {}`],
    ],
    expectFlagged: [],
    expectClean: ["place"],
  },
  // (c) FAIL CLOSED — external/unresolvable specifier for a forbidden name.
  {
    name: "(c) fail closed: re-export of a forbidden name from an unresolvable source is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/sneaky.ts",
        `export { placeLiveOrderGuarded as fire } from "some-external-pkg";`,
      ],
    ],
    expectFlagged: ["fire"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — multi-hop chain: resolves to a scanned file that does NOT
  // itself define the symbol (it re-exports it from elsewhere). We do not follow.
  {
    name: "(c) fail closed: multi-hop re-export chain is flagged (not followed)",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/hop1.ts",
        `export { mt5CommandsTable } from "./schema/mt5Commands.js";`,
      ],
      [
        "lib/db/src/hop2.ts",
        `export { mt5CommandsTable as q } from "./hop1.js";`,
      ],
    ],
    expectFlagged: ["q"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — same-name TRAMPOLINE: a launder module imports the
  // forbidden table and re-binds it under the same name, then a barrel re-exports
  // that. The launder file "defines" mt5CommandsTable but is NOT independent, so
  // it must NOT earn the unrelated-exemption.
  {
    name: "(c) fail closed: same-name table trampoline (launder of a forbidden import) is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/launder.ts",
        `import { mt5CommandsTable as t } from "@workspace/db";\nexport const mt5CommandsTable = t;`,
      ],
      [
        "lib/db/src/trampoline.ts",
        `export { mt5CommandsTable as q } from "./launder.js";`,
      ],
    ],
    expectFlagged: ["q"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — same-name function-REFERENCE trampoline: a const re-binds
  // the forbidden function by reference (not a fresh function declaration).
  {
    name: "(c) fail closed: same-name function-reference trampoline (const re-bind) is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/fnLaunder.ts",
        `import { placeLiveOrderGuarded as g } from "./liveTrading/guard.js";\nexport const placeLiveOrderGuarded = g;`,
      ],
      [
        "artifacts/api-server/src/lib/fnTrampoline.ts",
        `export { placeLiveOrderGuarded as fire2 } from "./fnLaunder.js";`,
      ],
    ],
    expectFlagged: ["fire2"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — NAMESPACE-import laundering: `import * as db` then re-bind a
  // member of it under the forbidden name. The const initializer is a member-
  // access chain → not a fresh construction → fail closed.
  {
    name: "(c) fail closed: namespace-import laundering (member-access re-bind) is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/nsLaunder.ts",
        `import * as db from "@workspace/db";\nexport const mt5CommandsTable = db.mt5CommandsTable;`,
      ],
      [
        "lib/db/src/nsTrampoline.ts",
        `export { mt5CommandsTable as nsq } from "./nsLaunder.js";`,
      ],
    ],
    expectFlagged: ["nsq"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — RENAMED-HOP laundering: an intermediary re-exports the table
  // under an unrelated local name, a second file imports THAT name and re-binds it
  // to the forbidden name, a barrel re-exports it. The independence scan can't see
  // through the rename, but the final const re-bind (`= u`) is a bare identifier →
  // fail closed.
  {
    name: "(c) fail closed: renamed-hop laundering chain is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/hopA.ts",
        `export { mt5CommandsTable as t } from "@workspace/db";`,
      ],
      [
        "lib/db/src/hopB.ts",
        `import { t as u } from "./hopA.js";\nexport const mt5CommandsTable = u;`,
      ],
      [
        "lib/db/src/hopBarrel.ts",
        `export { mt5CommandsTable as hq } from "./hopB.js";`,
      ],
    ],
    expectFlagged: ["hq"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — minimally-altered one-hop launder RHS variants that are NOT
  // bare identifiers but are still re-bindings: parenthesised identifier, bracket-
  // member access, and a TS type-asserted reference. None is a fresh construction,
  // so all must fail closed.
  {
    name: "(c) fail closed: parenthesised-identifier launder is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/parenLaunder.ts",
        `import { mt5CommandsTable as t } from "@workspace/db";\nexport const mt5CommandsTable = (t);`,
      ],
      [
        "lib/db/src/parenTrampoline.ts",
        `export { mt5CommandsTable as pq } from "./parenLaunder.js";`,
      ],
    ],
    expectFlagged: ["pq"],
    expectClean: [],
  },
  {
    name: "(c) fail closed: bracket-member launder is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/bracketLaunder.ts",
        `import * as db from "@workspace/db";\nexport const mt5CommandsTable = db["mt5CommandsTable"];`,
      ],
      [
        "lib/db/src/bracketTrampoline.ts",
        `export { mt5CommandsTable as bq } from "./bracketLaunder.js";`,
      ],
    ],
    expectFlagged: ["bq"],
    expectClean: [],
  },
  {
    name: "(c) fail closed: type-asserted launder is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/assertLaunder.ts",
        `import { mt5CommandsTable as t } from "@workspace/db";\nexport const mt5CommandsTable = t as any;`,
      ],
      [
        "lib/db/src/assertTrampoline.ts",
        `export { mt5CommandsTable as aq } from "./assertLaunder.js";`,
      ],
    ],
    expectFlagged: ["aq"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — arbitrary wrapper-CALL launder: a non-curated call that
  // simply RETURNS the forbidden import (`id(t)`) is not provably fresh.
  {
    name: "(c) fail closed: arbitrary wrapper-call launder (id(t)) is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/callLaunder.ts",
        `import { mt5CommandsTable as t } from "@workspace/db";\nconst id = (x) => x;\nexport const mt5CommandsTable = id(t);`,
      ],
      [
        "lib/db/src/callTrampoline.ts",
        `export { mt5CommandsTable as cq } from "./callLaunder.js";`,
      ],
    ],
    expectFlagged: ["cq"],
    expectClean: [],
  },
  // (c) FAIL CLOSED — `new`-expression launder: a constructor that embeds/returns
  // the forbidden import is not provably fresh.
  {
    name: "(c) fail closed: new-expression launder (new Wrapper(t)) is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "lib/db/src/newLaunder.ts",
        `import { mt5CommandsTable as t } from "@workspace/db";\nexport const mt5CommandsTable = new Wrapper(t);`,
      ],
      [
        "lib/db/src/newTrampoline.ts",
        `export { mt5CommandsTable as nq } from "./newLaunder.js";`,
      ],
    ],
    expectFlagged: ["nq"],
    expectClean: [],
  },
  // (scope policy) DOCUMENTED OUT-OF-SCOPE — an ARROW-const wrapper whose BODY
  // calls a forbidden primitive is a fresh function value and is NOT flagged,
  // mirroring the function-DECLARATION wrapper boundary (text scan cannot tell it
  // apart from every legitimate helper that reaches the pipeline).
  {
    name: "(scope policy) arrow-const wrapper around a forbidden primitive is NOT flagged (out of scope)",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/arrowWrapper.ts",
        `import { placeLiveOrderGuarded as g } from "./liveTrading/guard.js";\nexport const placeLiveOrderGuarded = (a) => g(a);`,
      ],
      [
        "artifacts/api-server/src/lib/arrowWrapperReexport.ts",
        `export { placeLiveOrderGuarded as wrapArrowFire } from "./arrowWrapper.js";`,
      ],
    ],
    expectFlagged: [],
    expectClean: ["wrapArrowFire"],
  },
  // (b) PRECISION — a genuinely unrelated same-named function defined as an ARROW
  // const in a non-forbidden module is a fresh function value → NOT flagged.
  {
    name: "(b) genuine unrelated same-name arrow-const function is NOT flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/ui/arrowOrder.ts",
        `export const placeOrder = () => { /* renders a UI order card */ };`,
      ],
      [
        "artifacts/api-server/src/ui/arrowReexport.ts",
        `export { placeOrder as submitArrowCard } from "./arrowOrder.js";`,
      ],
    ],
    expectFlagged: [],
    expectClean: ["submitArrowCard"],
  },
  // (scope policy) DOCUMENTED OUT-OF-SCOPE — a function-DECLARATION wrapper whose
  // BODY calls a forbidden primitive is a genuinely-fresh binding and is NOT
  // flagged. This is the same boundary as "a forbidden call buried in an arbitrary
  // helper that the assistant merely calls": indistinguishable by text scan from
  // every legitimate function (incl. the REQUIRED executeInstant) that reaches the
  // pipeline. Codified here so the scope boundary is explicit, not accidental.
  {
    name: "(scope policy) function-declaration wrapper around a forbidden primitive is NOT flagged (out of scope)",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/wrapper.ts",
        `import { placeLiveOrderGuarded as g } from "./liveTrading/guard.js";\nexport function placeLiveOrderGuarded(a) { return g(a); }`,
      ],
      [
        "artifacts/api-server/src/lib/wrapperReexport.ts",
        `export { placeLiveOrderGuarded as wrapFire } from "./wrapper.js";`,
      ],
    ],
    expectFlagged: [],
    expectClean: ["wrapFire"],
  },
  // (b) PRECISION — a genuinely unrelated same-named const TABLE constructed via a
  // fresh `pgTable(...)` call in a non-forbidden module is NOT a launder and must
  // stay exempt (no false positive from the const-initializer rule).
  {
    name: "(b) genuine unrelated same-name const table (fresh pgTable call) is NOT flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/ui/localTable.ts",
        `import { pgTable, text } from "drizzle-orm/pg-core";\nexport const mt5CommandsTable = pgTable("ui_local_unrelated", { id: text("id") });`,
      ],
      [
        "artifacts/api-server/src/ui/localTableReexport.ts",
        `export { mt5CommandsTable as uiLocalTable } from "./localTable.js";`,
      ],
    ],
    expectFlagged: [],
    expectClean: ["uiLocalTable"],
  },
  // (c) FAIL CLOSED — orderSend has no in-repo origin, so any re-export of it is
  // strict (cannot be proven unrelated).
  {
    name: "(c) fail closed: orderSend (no in-repo origin) re-export is flagged",
    files: [
      ...ORIGIN_FILES,
      [
        "artifacts/api-server/src/lib/os.ts",
        `import { orderSend } from "./broker.js";\nexport { orderSend as fireOs };`,
      ],
      ["artifacts/api-server/src/lib/broker.ts", `export const helper = 1;`],
    ],
    expectFlagged: ["fireOs"],
    expectClean: [],
  },
];

for (const c of provCases) {
  const aliases = collectReexportAliasesFromFiles(new Map(c.files), PROV_ORIGINS);
  const ids = new Set(aliases.map((a) => a.id));
  const missing = c.expectFlagged.filter((id) => !ids.has(id));
  const leaked = c.expectClean.filter((id) => ids.has(id));
  const ok = missing.length === 0 && leaked.length === 0;
  record(
    c.name,
    ok,
    ok
      ? `aliases=[${[...ids].join(",") || "none"}]`
      : `missing=[${missing.join(",")}] leaked=[${leaked.join(",")}] got=[${[...ids].join(",")}]`,
  );
}

// resolveModuleSpecifier: TS-ESM `.js` import resolves to the `.ts` source.
{
  const keys = new Set(["lib/db/src/schema/mt5Commands.ts"]);
  const resolved = resolveModuleSpecifier("lib/db/src/barrel.ts", "./schema/mt5Commands.js", keys);
  const ok = resolved === "lib/db/src/schema/mt5Commands.ts";
  record("resolveModuleSpecifier maps .js specifier to .ts source", ok, ok ? "resolved" : `got ${resolved}`);
  const ext = resolveModuleSpecifier("lib/db/src/barrel.ts", "@workspace/db", keys);
  record("resolveModuleSpecifier returns null for non-relative specifier", ext === null, ext === null ? "null" : `got ${ext}`);
}

// buildOriginIntegrity: a healthy map yields no issues; a tampered origin (the
// symbol no longer defined there) is surfaced so the guard fails loudly.
{
  const healthy = new Map(ORIGIN_FILES);
  const issuesHealthy = buildOriginIntegrity(healthy, PROV_ORIGINS);
  record("buildOriginIntegrity passes when curated origins genuinely define their symbols", issuesHealthy.length === 0,
    issuesHealthy.length === 0 ? "no issues" : `got ${JSON.stringify(issuesHealthy)}`);

  const tampered = new Map<string, string>(ORIGIN_FILES);
  tampered.set("lib/db/src/schema/mt5Commands.ts", `export const SOMETHING_ELSE = 1;`);
  const issuesTampered = buildOriginIntegrity(tampered, PROV_ORIGINS);
  const caught = issuesTampered.some((i) => i.includes("mt5CommandsTable"));
  record("buildOriginIntegrity fails closed when a curated origin no longer defines its symbol", caught,
    caught ? "integrity violation surfaced" : `got ${JSON.stringify(issuesTampered)}`);

  const missingFile = new Map<string, string>(ORIGIN_FILES);
  missingFile.delete("artifacts/api-server/src/lib/liveTrading/guard.ts");
  const issuesMissing = buildOriginIntegrity(missingFile, PROV_ORIGINS);
  const caughtMissing = issuesMissing.some((i) => i.includes("placeLiveOrderGuarded"));
  record("buildOriginIntegrity fails closed when a curated origin file is missing", caughtMissing,
    caughtMissing ? "missing-origin surfaced" : `got ${JSON.stringify(issuesMissing)}`);
}

// ── Pinpoint precision (#756) ────────────────────────────────────────────────
// A violation must locate the EXACT off-limits code: an accurate `line:col`
// (NOT shifted by comments above it) plus the precise matched token. This is the
// regression lock for the line-preserving stripComments + exec-based reporting.
{
  // 1-based line/col of the first occurrence of `token` in `src`.
  function locate(src: string, token: string): { line: number; col: number } {
    const idx = src.indexOf(token);
    const before = src.slice(0, idx);
    const line = before.split("\n").length;
    const col = idx - before.lastIndexOf("\n");
    return { line, col };
  }

  // A forbidden table usage preceded by a whole-line `//` comment and a
  // multi-line `/* ... */` block — both of which used to delete lines and drift
  // every reported line number below them.
  const raw =
    `// header comment\n` +
    `/* a block\n   comment\n   spanning lines */\n` +
    `const ok = 1;\n` +
    `await db.insert(mt5CommandsTable).values({});\n` +
    SANCTIONED;
  const { line, col } = locate(raw, "mt5CommandsTable");
  const flags = scanAssistantForViolations(raw, []);
  const hit = flags.find((f) => f.includes("mt5CommandsTable"));

  const okLoc = hit !== undefined && hit.startsWith(`:${line}:${col} `);
  record(
    "pinpoint: reports accurate line:col unshifted by comments above",
    okLoc,
    okLoc ? `located at :${line}:${col}` : `got ${hit ?? "no flag"} (expected :${line}:${col})`,
  );

  const okToken = hit !== undefined && hit.includes("off-limits code `mt5CommandsTable`");
  record(
    "pinpoint: reports the exact off-limits token",
    okToken,
    okToken ? "exact token surfaced" : `got ${hit ?? "no flag"}`,
  );

  // The order-send needle should pinpoint the call-site column + token too.
  const raw2 = `const x = 1;\nawait orderSend({ symbol });\n${SANCTIONED}`;
  const loc2 = locate(raw2, "orderSend");
  const hit2 = scanAssistantForViolations(raw2, []).find((f) => f.includes("orderSend"));
  const okFn =
    hit2 !== undefined &&
    hit2.startsWith(`:${loc2.line}:${loc2.col} `) &&
    hit2.includes("off-limits code `orderSend(`");
  record(
    "pinpoint: order-send call-site reports accurate line:col + token",
    okFn,
    okFn ? `located at :${loc2.line}:${loc2.col}` : `got ${hit2 ?? "no flag"}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} assistant-no-direct-execution cases passed`,
);
process.exit(failed === 0 ? 0 : 1);
