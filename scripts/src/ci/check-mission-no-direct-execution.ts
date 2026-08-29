// CI guard — mission-no-direct-execution (Task #804).
//
// Sibling of the assistant- and chart-trade-no-direct-execution guards
// (#750/#754). Profit Mission is ANOTHER live-trade entry point: when a mission
// is authorized to trade, its OPEN and its protective-exit management
// (CLOSE / MODIFY_SL_TP / MOVE_SL_TO_BREAKEVEN / PARTIAL_CLOSE) MUST route
// through the Global Instant Trade Router (`executeInstant`, tagged
// `source: "mission"`) → live command pipeline → 23-gate Phase B dispatch,
// exactly like a manual trade. There is NO second execution path.
//
// This guard locks that invariant across the whole mission surface:
//
//   1. NO mission backend surface (the mission services + the mission route)
//      may launder a live order around the router: no direct insert into a
//      broker command table (mt5 demo/live queues, arx live commands), no
//      legacy `/api/me/trades/close` bypass, and no direct broker order-send
//      primitive — including via a local `as` alias or a cross-file re-export
//      alias (provenance-resolved, fail-closed) of any of those.
//
//   2. The two mission surfaces that DO dispatch/manage live trades
//      (`missionExecution.ts`, `missionExitManager.ts`) must ADDITIONALLY keep
//      the sanctioned anchors present: `executeInstant`, `source: "mission"`,
//      and the originating `missionId` ownership tag (the #804 additive tag).
//      Their loss would mean the mission path stopped routing through the
//      router or stopped stamping its ownership.
//
//   3. The pure planning/feasibility/backtest surfaces — the
//      `missionTestingLabService` and every `lib/domain/src/profit-mission`
//      engine — must NEVER reach the dispatch seam at all (no `executeInstant`,
//      no live command pipeline, no import of the mission dispatch service, no
//      order-send / command-table / legacy-close reference). A "what-if"
//      simulation must never be able to reach a real broker.
//
//   4. NO mission surface (backend, domain, or the mission frontend) may use
//      `Math.random` — mission progress, P&L, readiness, and projections must
//      derive from real broker/engine evidence, never fabricated randomness
//      (the Profit Mission "performance truth" invariant).
//
// It reuses the assistant guard's hardened, provenance-aware scanner and
// cross-file re-export alias resolution for the import/symbol surface, plus a
// small comment-stripped raw-string scan for the isolation + Math.random tokens
// that never appear as imported symbols. Comments are stripped before scanning
// so doc-comment prose that names these tokens never trips a false positive.
// Pure source analysis: no network/DB, only reads the scanned files.
import { join } from "node:path";
import { ROOT, read, rel, walk, reportResult, type CheckResult } from "./_lib.js";
import {
  scanForViolations,
  collectReexportAliases,
  type Needle,
} from "./check-assistant-no-direct-execution.js";

// Every mission backend surface. Each must be free of any direct
// command-table / order-send / legacy-close bypass (the assistant guard's
// BASE_FORBIDDEN, applied via `scanForViolations`).
const MISSION_BACKEND_FILES = [
  "artifacts/api-server/src/lib/missionAgents.ts",
  "artifacts/api-server/src/lib/missionBriefingService.ts",
  "artifacts/api-server/src/lib/missionCertificateService.ts",
  "artifacts/api-server/src/lib/missionDrafts.ts",
  "artifacts/api-server/src/lib/missionDriftService.ts",
  "artifacts/api-server/src/lib/missionDriver.ts",
  "artifacts/api-server/src/lib/missionExecutionModeService.ts",
  "artifacts/api-server/src/lib/missionExecutionQuality.ts",
  "artifacts/api-server/src/lib/missionExecution.ts",
  "artifacts/api-server/src/lib/missionExitManager.ts",
  "artifacts/api-server/src/lib/missionPromotionService.ts",
  "artifacts/api-server/src/lib/missionRiskService.ts",
  "artifacts/api-server/src/lib/missionTestingLabService.ts",
  "artifacts/api-server/src/lib/profitMissionJournal.ts",
  "artifacts/api-server/src/lib/profitMissionSerialize.ts",
  "artifacts/api-server/src/routes/profitMissions.ts",
];

// The two mission surfaces that DO dispatch/manage a live trade. Each MUST keep
// the sanctioned router anchors present in ADDITION to the forbidden scan.
const MISSION_DISPATCH_FILES = new Set<string>([
  "artifacts/api-server/src/lib/missionExecution.ts",
  "artifacts/api-server/src/lib/missionExitManager.ts",
]);

// Sanctioned anchors the dispatch/exit surfaces MUST contain: the router entry,
// the mission source tag, and the originating missionId ownership tag (#804).
export const MISSION_DISPATCH_REQUIRED: Needle[] = [
  {
    rx: /\bexecuteInstant\b/,
    why: "mission dispatch/exit must route through the Global Instant Trade Router (executeInstant), never a second execution path",
  },
  {
    rx: /source:\s*["']mission["']/,
    why: 'mission trade intents must be tagged source "mission" so the router routes + audits them as mission trades',
  },
  {
    rx: /\bmissionId\b/,
    why: "mission trade intents must carry the originating missionId ownership tag (#804 additive tag)",
  },
];

// The pure planning/feasibility/backtest surfaces that must NEVER reach the
// live dispatch seam. `missionTestingLabService` (the api-server backtest
// service) plus every `lib/domain/src/profit-mission` engine.
const MISSION_ISOLATED_EXPLICIT = [
  "artifacts/api-server/src/lib/missionTestingLabService.ts",
];
const MISSION_DOMAIN_DIR = "lib/domain/src/profit-mission";

// Dispatch-seam tokens the isolated planning/backtest surfaces must NEVER touch.
// These are import specifiers / call primitives / endpoint + table strings that
// would only appear if a "what-if" surface were wired to real execution.
export const DISPATCH_SEAM_FORBIDDEN: Needle[] = [
  {
    rx: /\bexecuteInstant\b/,
    why: "planning/backtest surface must never reach the live dispatch router (executeInstant)",
  },
  {
    rx: /\bliveCommandPipeline\b/,
    why: "planning/backtest surface must never touch the live command pipeline",
  },
  {
    rx: /from\s+["'][^"']*\/missionExecution(?:\.js)?["']/,
    why: "planning/backtest surface must never import the mission dispatch service",
  },
  {
    rx: /\b(?:placeLiveOrderGuarded|orderSend|placeOrder)\s*\(/,
    why: "planning/backtest surface must never call a broker order-send primitive",
  },
  {
    rx: /\b(?:mt5CommandsTable|mt5DemoCommandsTable|arxLiveCommandsTable)\b/,
    why: "planning/backtest surface must never reference a broker command table",
  },
  {
    rx: /\/api\/me\/trades\/close\b/,
    why: "planning/backtest surface must never use the legacy close bypass",
  },
];

// Mission frontend surfaces subject to the Math.random ban.
const MISSION_FRONTEND_FILES = [
  "artifacts/trading-dashboard/src/pages/profit-missions.tsx",
  "artifacts/trading-dashboard/src/components/missions/missionPerformanceFormat.ts",
  "artifacts/trading-dashboard/src/components/missions/MissionPerformanceView.tsx",
];

// The honesty ban: no fabricated randomness anywhere on the mission surface.
export const MATH_RANDOM_FORBIDDEN: Needle[] = [
  {
    rx: /\bMath\.random\s*\(/,
    why: "mission progress/P&L/readiness/projections must derive from real broker/engine evidence, never Math.random",
  },
];

// Comment-stripped, position-preserving scan for raw-string forbidden tokens.
// Block comments are blanked to spaces (newlines preserved) and whole-line `//`
// comments are blanked, so a token mentioned only in a comment never trips the
// guard while reported line/col still point at real code.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => (l.trimStart().startsWith("//") ? "" : l))
    .join("\n");
}

export function scanForbiddenStrings(src: string, forbidden: Needle[]): string[] {
  const stripped = stripComments(src);
  const out: string[] = [];
  stripped.split("\n").forEach((line, i) => {
    for (const { rx, why } of forbidden) {
      const m = rx.exec(line);
      if (m !== null) {
        out.push(
          `:${i + 1}:${m.index + 1} [${why}] off-limits \`${m[0].trim()}\` → ${line.trim().slice(0, 120)}`,
        );
      }
    }
  });
  return out;
}

export function checkMissionNoDirectExecution(): CheckResult {
  const violations: string[] = [];

  const { aliases, integrity } = collectReexportAliases();

  // 1 + 2. Backend forbidden scan (all files) + sanctioned-anchor scan (the two
  //        dispatch surfaces). scanForViolations is import-aware and resolves
  //        local/cross-file re-export aliases fail-closed.
  let backendScanned = 0;
  for (const relPath of MISSION_BACKEND_FILES) {
    let src: string;
    try {
      src = read(join(ROOT, relPath));
    } catch {
      violations.push(`${relPath}: cannot read (mission surface is missing)`);
      continue;
    }
    backendScanned++;
    const required = MISSION_DISPATCH_FILES.has(relPath)
      ? MISSION_DISPATCH_REQUIRED
      : [];
    for (const v of scanForViolations(src, aliases, required)) {
      violations.push(`${relPath}${v}`);
    }
  }

  // 3. Isolation scan — the planning/feasibility/backtest surfaces must never
  //    reach the dispatch seam. Walk the domain engine dir so new engines are
  //    auto-covered; skip test files (they carry synthetic bypass snippets).
  const isolatedFiles = [
    ...MISSION_ISOLATED_EXPLICIT.map((r) => join(ROOT, r)),
    ...walk(join(ROOT, MISSION_DOMAIN_DIR)).filter(
      (p) => !/\.test\.tsx?$/.test(p) && !/__qa__|__tests__/.test(p),
    ),
  ];
  let isolatedScanned = 0;
  for (const abs of isolatedFiles) {
    let src: string;
    try {
      src = read(abs);
    } catch {
      violations.push(`${rel(abs)}: cannot read (mission planning/backtest surface is missing)`);
      continue;
    }
    isolatedScanned++;
    for (const v of scanForbiddenStrings(src, DISPATCH_SEAM_FORBIDDEN)) {
      violations.push(`${rel(abs)}${v}`);
    }
  }

  // 4. Math.random ban across backend + domain + frontend mission surfaces.
  const randomFiles = new Set<string>([
    ...MISSION_BACKEND_FILES.map((r) => join(ROOT, r)),
    ...MISSION_FRONTEND_FILES.map((r) => join(ROOT, r)),
    ...walk(join(ROOT, MISSION_DOMAIN_DIR)).filter(
      (p) => !/\.test\.tsx?$/.test(p) && !/__qa__|__tests__/.test(p),
    ),
  ]);
  let randomScanned = 0;
  for (const abs of randomFiles) {
    let src: string;
    try {
      src = read(abs);
    } catch {
      // Frontend files are the only ones not already reported above; a missing
      // FE mission file is a real gap for the honesty ban.
      violations.push(`${rel(abs)}: cannot read (mission surface is missing)`);
      continue;
    }
    randomScanned++;
    for (const v of scanForbiddenStrings(src, MATH_RANDOM_FORBIDDEN)) {
      violations.push(`${rel(abs)}${v}`);
    }
  }

  // Curation rot is a guard-integrity failure: provenance can no longer be
  // trusted, so fail loudly rather than silently under-ban.
  for (const issue of integrity) {
    violations.push(`FORBIDDEN_ORIGINS integrity: ${issue}`);
  }

  return {
    name: "mission-no-direct-execution (Profit Mission trades route ONLY through executeInstant → 23-gate dispatch; planning/backtest never touches execution; no fabricated randomness)",
    ok: violations.length === 0,
    violations,
    notes: [
      `mission backend surfaces scanned: ${backendScanned}/${MISSION_BACKEND_FILES.length}`,
      `dispatch surfaces anchored (executeInstant + source "mission" + missionId): ${MISSION_DISPATCH_FILES.size}`,
      `isolated planning/backtest surfaces scanned: ${isolatedScanned}`,
      `Math.random-scanned surfaces: ${randomScanned}`,
      `provenance-resolved re-export alias bindings: ${aliases.length}`,
      `curated forbidden-origin integrity issues: ${integrity.length}`,
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkMissionNoDirectExecution();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
