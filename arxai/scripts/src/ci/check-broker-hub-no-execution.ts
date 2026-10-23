// ── Broker-Hub containment/source guard (Task #8) ───────────────────────────
//
// Phase 0A broker-hub modules (lib/domain/src/broker-hub and
// artifacts/api-server/src/lib/brokerHub) are READ-ONLY discovery/health
// surfaces. They must NEVER reach:
//
//   A. Execution/instant/demo pipeline imports:
//        executeInstant, instantTrade, liveCommandPipeline, dispatchLive,
//        placeLiveOrder*, dispatchToBroker, /live/instantTrade path,
//        /live/liveCommandPipeline path
//
//   B. Execution table mutations (INSERT/UPDATE/DELETE):
//        mt5CommandsTable, mt5DemoCommandsTable, arxLiveCommandsTable,
//        arxLivePositionsTable
//        (direct SELECT / .select() on mt5CommandsTable is allowed in
//        projections — only mutation is forbidden)
//
//   C. Mailbox/enqueue writes:
//        enqueueCommand, enqueueMailbox, mailboxWrite, enqueueLiveCommand
//
//   D. Adapter mutation methods (presence of any of these method names
//      implies an order/cancel/close/credential mutation interface):
//        submitOrder, cancelOrder, closePosition, rotateCredentials,
//        updateCredentials
//
//   E. Mock/demo fallbacks (broker-hub modules must never silently degrade
//      to fake data):
//        mockProvider, demoFallback, isMock, useMock, DEMO_FALLBACK,
//        canPlaceLiveTrade: true (serialised live-eligible flag)
//
//   F. Outbound network calls (broker-hub is a pure read surface):
//        fetch(, axios., got., needle., superagent.
//
//   G. Shared-token / legacy MT5 provider dependencies:
//        MT5_BRIDGE_TOKEN, MT5BridgeProvider (the legacy global provider must
//        not be re-used; per-user projection must use mt5_connection rows)
//
// Allowed exception: direct READ of mt5CommandsTable is permitted inside
// broker-hub modules via .select() — only .insert()/.update()/.delete() on
// that table are forbidden.  The other three execution tables are forbidden
// for any access (select or mutation) only via their mutating call forms; see
// rule B.
//
// The guard is designed to work gracefully when the broker-hub directories do
// not yet exist — it passes with a note rather than failing.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

// ── Directories to guard ─────────────────────────────────────────────────────

const HUB_DIRS = [
  join(ROOT, "lib/domain/src/broker-hub"),
  join(ROOT, "artifacts/api-server/src/lib/brokerHub"),
];

// ── Comment stripping ────────────────────────────────────────────────────────

/** Blank block-comments (preserving newlines) and strip line-comment tails. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return noBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// ── Forbidden patterns ───────────────────────────────────────────────────────

type Forbidden = { rx: RegExp; why: string };

/** A. Execution/instant/demo pipeline imports. */
const EXEC_PIPELINE: Forbidden[] = [
  {
    rx: /\bexecuteInstant\b/,
    why: "executeInstant (instant-trade router) must never be reachable from broker-hub",
  },
  {
    rx: /\binstantTrade\b/,
    why: "instantTrade module must never be imported in broker-hub",
  },
  {
    rx: /\bliveCommandPipeline\b/,
    why: "liveCommandPipeline (Phase B live dispatch) must never be imported in broker-hub",
  },
  {
    rx: /\bdispatchLive\b/,
    why: "dispatchLive must never be called from broker-hub",
  },
  {
    rx: /\bplaceLiveOrder(?:Guarded|Unsafe)?\b/,
    why: "placeLiveOrder* primitives must never be called from broker-hub",
  },
  {
    rx: /\bdispatchToBroker\b/,
    why: "dispatchToBroker (broker placement primitive) must never be called from broker-hub",
  },
  {
    rx: /\/live\/instantTrade/,
    why: "instantTrade module path must never be imported from broker-hub",
  },
  {
    rx: /\/live\/liveCommandPipeline/,
    why: "liveCommandPipeline module path must never be imported from broker-hub",
  },
];

/**
 * B. Execution table MUTATIONS (INSERT/UPDATE/DELETE).
 *
 * mt5CommandsTable SELECT is explicitly allowed (projection reads), so we only
 * forbid the three mutation verbs on that table.
 * For the other three tables (mt5DemoCommandsTable, arxLiveCommandsTable,
 * arxLivePositionsTable) we also forbid mutation forms only.
 */
const EXEC_TABLE_MUTATIONS: Forbidden[] = [
  {
    rx: /\.\s*(?:insert|update|delete)\b|\[\s*["'](?:insert|update|delete)["']\s*\]/,
    why: "broker-hub is a read-only boundary and must not perform any database mutation",
  },
  {
    rx: /\.\s*(?:execute|executeRaw|unsafe|query)\s*\(|\[\s*["'](?:execute|executeRaw|unsafe|query)["']\s*\]/,
    why: "broker-hub must not use raw database execution/query APIs; use allowlisted read projections",
  },
  {
    rx: /\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_$][\w$]*\s+SET|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i,
    why: "broker-hub source contains a raw SQL mutation statement",
  },
  {
    rx: /\{\s*(?:insert|update|delete|execute|executeRaw|unsafe|query)\s*(?::\s*[A-Za-z_$][\w$]*)?\s*(?:,|\})/,
    why: "broker-hub must not destructure a database mutation/raw execution method",
  },
  {
    rx: /\.insert\s*\(\s*mt5CommandsTable/,
    why: "broker-hub must not INSERT into mt5CommandsTable (execution mailbox); SELECT is allowed",
  },
  {
    rx: /\.update\s*\(\s*mt5CommandsTable/,
    why: "broker-hub must not UPDATE mt5CommandsTable (execution mailbox)",
  },
  {
    rx: /\.delete\s*\(\s*mt5CommandsTable/,
    why: "broker-hub must not DELETE from mt5CommandsTable (execution mailbox)",
  },
  {
    rx: /\.insert\s*\(\s*mt5DemoCommandsTable/,
    why: "broker-hub must not INSERT into mt5DemoCommandsTable (demo mailbox)",
  },
  {
    rx: /\.update\s*\(\s*mt5DemoCommandsTable/,
    why: "broker-hub must not UPDATE mt5DemoCommandsTable (demo mailbox)",
  },
  {
    rx: /\.delete\s*\(\s*mt5DemoCommandsTable/,
    why: "broker-hub must not DELETE from mt5DemoCommandsTable (demo mailbox)",
  },
  {
    rx: /\.insert\s*\(\s*arxLiveCommandsTable/,
    why: "broker-hub must not INSERT into arxLiveCommandsTable (live command mailbox)",
  },
  {
    rx: /\.update\s*\(\s*arxLiveCommandsTable/,
    why: "broker-hub must not UPDATE arxLiveCommandsTable (live command mailbox)",
  },
  {
    rx: /\.delete\s*\(\s*arxLiveCommandsTable/,
    why: "broker-hub must not DELETE from arxLiveCommandsTable (live command mailbox)",
  },
  {
    rx: /\.insert\s*\(\s*arxLivePositionsTable/,
    why: "broker-hub must not INSERT into arxLivePositionsTable (live positions table)",
  },
  {
    rx: /\.update\s*\(\s*arxLivePositionsTable/,
    why: "broker-hub must not UPDATE arxLivePositionsTable (live positions table)",
  },
  {
    rx: /\.delete\s*\(\s*arxLivePositionsTable/,
    why: "broker-hub must not DELETE from arxLivePositionsTable (live positions table)",
  },
];

/** C. Mailbox / enqueue writes. */
const MAILBOX_WRITES: Forbidden[] = [
  {
    rx: /\benqueueCommand\b/,
    why: "enqueueCommand (mailbox write) must never be called from broker-hub",
  },
  {
    rx: /\benqueueMailbox\b/,
    why: "enqueueMailbox (mailbox write) must never be called from broker-hub",
  },
  {
    rx: /\bmailboxWrite\b/,
    why: "mailboxWrite must never be called from broker-hub",
  },
  {
    rx: /\benqueueLiveCommand\b/,
    why: "enqueueLiveCommand must never be called from broker-hub",
  },
];

/** D. Adapter mutation method names. */
const ADAPTER_MUTATIONS: Forbidden[] = [
  {
    rx: /\bsubmitOrder\b/,
    why: "broker-hub read adapter must not expose or call submitOrder (order mutation)",
  },
  {
    rx: /\bcancelOrder\b/,
    why: "broker-hub read adapter must not expose or call cancelOrder (order mutation)",
  },
  {
    rx: /\bclosePosition\b/,
    why: "broker-hub read adapter must not expose or call closePosition (position mutation)",
  },
  {
    rx: /\brotateCredentials\b/,
    why: "broker-hub read adapter must not expose or call rotateCredentials (credential mutation)",
  },
  {
    rx: /\bupdateCredentials\b/,
    why: "broker-hub read adapter must not expose or call updateCredentials (credential mutation)",
  },
];

/** E. Mock/demo fallbacks. */
const MOCK_FALLBACKS: Forbidden[] = [
  {
    rx: /\bmockProvider\b/,
    why: "broker-hub must not fall back to a mock provider (Phase 0A unavailability must be explicit)",
  },
  {
    rx: /\bdemoFallback\b/,
    why: "broker-hub must not use demoFallback (Phase 0A unavailability must be explicit)",
  },
  {
    rx: /\bisMock\b/,
    why: "broker-hub must not reference isMock (mock guard implies mock data could be served)",
  },
  {
    rx: /\buseMock\b/,
    why: "broker-hub must not reference useMock (mock guard implies mock data could be served)",
  },
  {
    rx: /\bDEMO_FALLBACK\b/,
    why: "broker-hub must not reference DEMO_FALLBACK constant (explicit unavailability required)",
  },
  {
    rx: /canPlaceLiveTrade\s*:\s*true/,
    why: "broker-hub must never serialise canPlaceLiveTrade:true (Phase 0A brokers are never execution-eligible)",
  },
  {
    rx: /\bMockBrokerProvider\b|\/mockProvider\b/,
    why: "broker-hub must not instantiate or import the legacy mock provider",
  },
  {
    rx: /\bgetBrokerProvider\b|\/broker\/registry\b/,
    why: "broker-hub must not use the process-global legacy broker registry",
  },
  {
    rx: /\bbrokerReadOnly\b/,
    why: "broker-hub must not use the legacy demo-backed broker read-only service",
  },
];

/** F. Outbound network calls. */
const NETWORK_CALLS: Forbidden[] = [
  {
    rx: /\bfetch\s*\(/,
    why: "broker-hub must not make outbound network calls (fetch) — it is a pure read surface",
  },
  {
    rx: /\baxios\s*\./,
    why: "broker-hub must not make outbound network calls (axios) — it is a pure read surface",
  },
  {
    rx: /\bgot\s*\./,
    why: "broker-hub must not make outbound network calls (got) — it is a pure read surface",
  },
  {
    rx: /\bneedle\s*\./,
    why: "broker-hub must not make outbound network calls (needle) — it is a pure read surface",
  },
  {
    rx: /\bsuperagent\s*\./,
    why: "broker-hub must not make outbound network calls (superagent) — it is a pure read surface",
  },
  {
    rx: /\b(?:http|https)\s*\.\s*(?:request|get)\s*\(/,
    why: "broker-hub must not make outbound network calls through node http/https",
  },
  {
    rx: /\bXMLHttpRequest\b/,
    why: "broker-hub must not make outbound network calls through XMLHttpRequest",
  },
];

/** G. Shared-token / legacy MT5 provider. */
const LEGACY_MT5: Forbidden[] = [
  {
    rx: /\bMT5_BRIDGE_TOKEN\b/,
    why: "broker-hub must not depend on the shared MT5_BRIDGE_TOKEN (per-user projection reads mt5_connection rows directly)",
  },
  {
    rx: /\bMT5BridgeProvider\b/,
    why: "broker-hub must not wrap the legacy global MT5BridgeProvider (use per-user mt5_connection projection)",
  },
];

const ALL_FORBIDDEN: Forbidden[] = [
  ...EXEC_PIPELINE,
  ...EXEC_TABLE_MUTATIONS,
  ...MAILBOX_WRITES,
  ...ADAPTER_MUTATIONS,
  ...MOCK_FALLBACKS,
  ...NETWORK_CALLS,
  ...LEGACY_MT5,
];

// ── Scanner ──────────────────────────────────────────────────────────────────

type LineViolation = { line: number; col: number; token: string; why: string };

function aliasesForImportedName(src: string, importedName: string): string[] {
  const aliases = new Set<string>([importedName]);
  const importRx = /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g;
  for (const match of src.matchAll(importRx)) {
    for (const specifier of match[1].split(",")) {
      const alias = new RegExp(
        `^\\s*${importedName}\\s*(?:as\\s+([A-Za-z_$][\\w$]*))?\\s*$`,
      ).exec(specifier);
      if (alias) aliases.add(alias[1] ?? importedName);
    }
  }
  return [...aliases];
}

function tableMutationPatterns(src: string): Forbidden[] {
  const patterns: Forbidden[] = [];
  const tableNames = [
    "mt5CommandsTable",
    "mt5DemoCommandsTable",
    "arxLiveCommandsTable",
    "arxLivePositionsTable",
  ];
  for (const tableName of tableNames) {
    for (const localName of aliasesForImportedName(src, tableName)) {
      patterns.push({
        rx: new RegExp(
          `(?:\\.\\s*(?:insert|update|delete)\\s*\\(|\\[\\s*["'](?:insert|update|delete)["']\\s*\\]\\s*\\()\\s*${localName}\\b`,
        ),
        why: `broker-hub must not mutate ${tableName}, including through import aliases`,
      });
    }
  }
  return patterns;
}

function scanSource(src: string, forbidden: Forbidden[]): LineViolation[] {
  const stripped = stripComments(src);
  const out: LineViolation[] = [];
  for (const { rx, why } of forbidden) {
    const flags = rx.flags.includes("g") ? rx.flags : `${rx.flags}g`;
    const globalRx = new RegExp(rx.source, flags);
    for (const match of stripped.matchAll(globalRx)) {
      const offset = match.index;
      const before = stripped.slice(0, offset);
      const line = before.split("\n").length;
      const lastNewline = before.lastIndexOf("\n");
      const col = offset - lastNewline;
      out.push({ line, col, token: match[0].trim(), why });
    }
  }
  return out;
}

export function scanBrokerHubSourceForViolations(src: string): readonly LineViolation[] {
  const stripped = stripComments(src);
  return scanSource(stripped, [...ALL_FORBIDDEN, ...tableMutationPatterns(stripped)]);
}

// ── Exported check function ──────────────────────────────────────────────────

export function checkBrokerHubNoExecution(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  let totalDirs = 0;
  let totalFiles = 0;

  for (const dir of HUB_DIRS) {
    if (!existsSync(dir)) {
      notes.push(
        `${rel(dir)}: directory does not yet exist — guard will activate when it is created`,
      );
      continue;
    }
    totalDirs++;

    let files: string[];
    try {
      files = walk(dir).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
      );
    } catch {
      notes.push(`${rel(dir)}: could not walk directory — skipping`);
      continue;
    }

    for (const file of files) {
      // Skip test files — they exercise the guard with synthetic violation snippets.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;

      let src: string;
      try {
        src = readFileSync(file, "utf-8");
      } catch {
        violations.push(`${rel(file)}: cannot read source file`);
        continue;
      }
      totalFiles++;

      const isDomainFile = file.startsWith(join(ROOT, "lib/domain/src/broker-hub"));
      if (
        isDomainFile &&
        /@workspace\/db|drizzle-orm|express|node:(?:http|https|net|tls)|process\.env/.test(
          stripComments(src),
        )
      ) {
        violations.push(
          `${rel(file)}: broker-hub domain contract contains an IO/runtime dependency`,
        );
      }

      for (const { line, col, token, why } of scanBrokerHubSourceForViolations(src)) {
        violations.push(`${rel(file)}:${line}:${col} [${why}] — \`${token}\``);
      }
    }
  }

  if (totalDirs === 0) {
    // Neither directory exists yet; treat as vacuously passing with a note.
    notes.push(
      "broker-hub directories are not yet created — containment guard is standing by",
    );
  }

  return {
    name: "broker-hub-no-execution",
    ok: violations.length === 0,
    violations,
    notes: [
      `hub directories found: ${totalDirs}/${HUB_DIRS.length}`,
      `source files scanned: ${totalFiles}`,
      `forbidden-pattern groups: ${ALL_FORBIDDEN.length}`,
      ...notes,
    ],
  };
}

// ── Standalone runner ────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkBrokerHubNoExecution();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
