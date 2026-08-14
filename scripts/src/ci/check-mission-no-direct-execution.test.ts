// Regression suite for the mission-no-direct-execution CI guard (#804).
//
// Profit Mission is another live-trade entry point: its OPEN and its protective
// exit management must route ONLY through the Global Instant Trade Router
// (`executeInstant`, source "mission") → live command pipeline → 18-gate Phase B
// dispatch — and must stamp the originating `missionId`. This suite exercises:
//
//   1. the DISPATCH-surface REQUIRED anchors (executeInstant + source "mission"
//      + missionId) and the shared import-aware forbidden scan
//      (`scanForViolations`) against synthetic mission-dispatch snippets;
//   2. the ISOLATION forbidden scan (`scanForbiddenStrings` +
//      DISPATCH_SEAM_FORBIDDEN) that keeps the planning/backtest surfaces away
//      from the execution seam — including the precision case that a lookalike
//      `missionExecutionQuality` import is NOT flagged;
//   3. the Math.random honesty ban.
//
// Pure source analysis: no network, DB, or fs.

import {
  scanForViolations,
  type ForbiddenAlias,
} from "./check-assistant-no-direct-execution.js";
import {
  MISSION_DISPATCH_REQUIRED,
  DISPATCH_SEAM_FORBIDDEN,
  MATH_RANDOM_FORBIDDEN,
  scanForbiddenStrings,
} from "./check-mission-no-direct-execution.js";

export {};

// A minimal sanctioned tail satisfying all three dispatch anchors, so a failure
// on a "stay clean" / "still flag the bypass" case is unambiguously about the
// forbidden scan and not a MISSING sanctioned path.
const SANCTIONED = `
  const result = await executeInstant({
    userId,
    intent: { ...intent, source: "mission", missionId },
    ip,
    ua,
  });
`;

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
}

// ── 1. DISPATCH surface: REQUIRED anchors + import-aware forbidden scan ───────
type DispatchCase = {
  name: string;
  src: string;
  extra?: ForbiddenAlias[];
  shouldFlag: boolean;
};

const dispatchCases: DispatchCase[] = [
  // Must stay CLEAN.
  {
    name: "sanctioned mission dispatch (executeInstant + source mission + missionId)",
    shouldFlag: false,
    src: SANCTIONED,
  },
  {
    name: "doc-comment naming a forbidden table is stripped, not flagged",
    shouldFlag: false,
    src: `// never insert into arxLiveCommandsTable from a mission\n/* mt5CommandsTable is off-limits here */\n${SANCTIONED}`,
  },

  // Must be FLAGGED — missing a sanctioned anchor.
  {
    name: "missing missionId ownership tag is flagged",
    shouldFlag: true,
    src: `const result = await executeInstant({ userId, intent: { ...intent, source: "mission" }, ip, ua });`,
  },
  {
    name: 'missing source "mission" tag is flagged',
    shouldFlag: true,
    src: `const result = await executeInstant({ userId, intent: { ...intent, missionId }, ip, ua });`,
  },
  {
    name: "missing executeInstant router call is flagged",
    shouldFlag: true,
    src: `const noop = { source: "mission", missionId };`,
  },

  // Must be FLAGGED — direct-execution escapes even WITH the sanctioned tail.
  {
    name: "direct insert into arxLiveCommandsTable",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable } from "@workspace/db";\nawait db.insert(arxLiveCommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct insert into mt5CommandsTable",
    shouldFlag: true,
    src: `import { mt5CommandsTable } from "@workspace/db";\nawait db.insert(mt5CommandsTable).values({});\n${SANCTIONED}`,
  },
  {
    name: "direct broker order-send call",
    shouldFlag: true,
    src: `await orderSend({ symbol });\n${SANCTIONED}`,
  },
  {
    name: "direct placeLiveOrderGuarded call",
    shouldFlag: true,
    src: `await placeLiveOrderGuarded({ symbol });\n${SANCTIONED}`,
  },
  {
    name: "legacy /api/me/trades/close bypass string",
    shouldFlag: true,
    src: `await fetch("/api/me/trades/close", { method: "POST" });\n${SANCTIONED}`,
  },
  {
    name: "local alias of a command table caught at its usage",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable as q } from "@workspace/db";\nawait db.insert(q).values({});\n${SANCTIONED}`,
  },
  {
    name: "imported re-export alias of an order-send primitive",
    shouldFlag: true,
    extra: [{ id: "sendItNow", kind: "fn", origin: "artifacts/api-server/src/lib/reexport.ts" }],
    src: `import { sendItNow } from "../lib/reexport.js";\nawait sendItNow({ symbol });\n${SANCTIONED}`,
  },
];

for (const c of dispatchCases) {
  const flags = scanForViolations(c.src, c.extra ?? [], MISSION_DISPATCH_REQUIRED);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    `dispatch: ${c.name}`,
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

// ── 2. ISOLATION: planning/backtest surface must not reach the dispatch seam ──
type StringCase = { name: string; src: string; shouldFlag: boolean };

const isolationCases: StringCase[] = [
  {
    name: "pure engine with no dispatch tokens stays clean",
    shouldFlag: false,
    src: `export function feasibility(x: number): number { return x * 2; }`,
  },
  {
    name: "lookalike missionExecutionQuality import is NOT flagged (precision)",
    shouldFlag: false,
    src: `import { scoreQuality } from "../missionExecutionQuality.js";`,
  },
  {
    name: "forbidden token mentioned only in a comment is stripped, not flagged",
    shouldFlag: false,
    src: `// a mission must never call executeInstant from here\nconst ok = true;`,
  },
  {
    name: "reaching executeInstant is flagged",
    shouldFlag: true,
    src: `const r = await executeInstant({ intent });`,
  },
  {
    name: "importing the mission dispatch service is flagged",
    shouldFlag: true,
    src: `import { runMissionExecution } from "../missionExecution.js";`,
  },
  {
    name: "touching the live command pipeline is flagged",
    shouldFlag: true,
    src: `import { liveCommandPipeline } from "../live/liveCommandPipeline.js";`,
  },
  {
    name: "referencing a broker command table is flagged",
    shouldFlag: true,
    src: `import { arxLiveCommandsTable } from "@workspace/db";`,
  },
  {
    name: "legacy close bypass string is flagged",
    shouldFlag: true,
    src: `await fetch("/api/me/trades/close");`,
  },
];

for (const c of isolationCases) {
  const flags = scanForbiddenStrings(c.src, DISPATCH_SEAM_FORBIDDEN);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    `isolation: ${c.name}`,
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

// ── 3. Math.random honesty ban ───────────────────────────────────────────────
const randomCases: StringCase[] = [
  {
    name: "no randomness stays clean",
    shouldFlag: false,
    src: `const progress = filled / target;`,
  },
  {
    name: "Math.random mentioned only in a comment is stripped, not flagged",
    shouldFlag: false,
    src: `// never seed progress with Math.random()\nconst p = real;`,
  },
  {
    name: "Math.random() usage is flagged",
    shouldFlag: true,
    src: `const fakeProgress = Math.random();`,
  },
];

for (const c of randomCases) {
  const flags = scanForbiddenStrings(c.src, MATH_RANDOM_FORBIDDEN);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    `math-random: ${c.name}`,
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

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} mission-guard tests passed`);
process.exit(failed === 0 ? 0 : 1);
