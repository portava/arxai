// One Broker Hub read contract, one factory (Tier 1 Broker & Account Hub).
//
// Every venue the Hub reads implements ReadOnlyBrokerAdapter
// (@workspace/domain/broker-hub). lib/brokerHub/readAdapters.ts is the only
// place a venue adapter is constructed; everyone else asks
// brokerReadAdapter() and reads through the interface. This guard fails when:
//   1. a file outside the factory constructs a venue adapter class,
//   2. a venue adapter file does not implement ReadOnlyBrokerAdapter,
//   3. a venue in BROKER_READ_VENUES has no case in the factory.
//
// Pure source analysis: no network, no DB.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const FACTORY = "lib/brokerHub/readAdapters.ts";
/** Venue adapter files and the class each one exports. */
export const VENUE_ADAPTERS: Record<string, string> = {
  "lib/brokerHub/mt5ReadOnlyAdapter.ts": "Mt5ReadOnlyAdapter",
  "lib/brokerHub/derivReadOnlyAdapter.ts": "DerivReadOnlyAdapter",
};

const CONSTRUCT = /\bnew\s+([A-Z]\w*ReadOnlyAdapter)\s*\(/;

export function scanFile(key: string, src: string): string[] {
  if (key === FACTORY) return [];
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    const m = CONSTRUCT.exec(line);
    if (m) out.push(`${i + 1}: constructs ${m[1]} directly; call brokerReadAdapter() in ${FACTORY}`);
  });
  return out;
}

/** Venues listed in the factory and whether each has a case. */
export function scanFactory(src: string): string[] {
  const list = /BROKER_READ_VENUES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!list) return ["BROKER_READ_VENUES not found"];
  const venues = [...list[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  return venues.filter((v) => !new RegExp(`case\\s+"${v}"\\s*:`).test(src)).map((v) => `venue ${v} has no adapter case`);
}

export function checkBrokerReadAdapterSingleFactory(): CheckResult {
  const violations: string[] = [];
  const factoryPath = join(API_SRC, FACTORY);
  if (!existsSync(factoryPath)) violations.push(`artifacts/api-server/src/${FACTORY} missing`);
  else for (const v of scanFactory(readFileSync(factoryPath, "utf8"))) violations.push(`artifacts/api-server/src/${FACTORY}: ${v}`);
  for (const [file, cls] of Object.entries(VENUE_ADAPTERS)) {
    const p = join(API_SRC, file);
    if (!existsSync(p)) { violations.push(`artifacts/api-server/src/${file} missing`); continue; }
    if (!new RegExp(`class\\s+${cls}\\s+implements\\s+ReadOnlyBrokerAdapter\\b`).test(readFileSync(p, "utf8"))) {
      violations.push(`artifacts/api-server/src/${file}: ${cls} must implement ReadOnlyBrokerAdapter`);
    }
  }
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}:${v}`);
  }
  return {
    name: "broker-read-adapter-single-factory",
    ok: violations.length === 0,
    violations,
    notes: [`${Object.keys(VENUE_ADAPTERS).length} venue adapters, constructed only in ${FACTORY}`],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkBrokerReadAdapterSingleFactory();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
