// One LLM gateway (Tier 1 Platform Safety).
//
// Model SDKs are imported only under artifacts/api-server/src/lib/ai/ —
// lib/ai/llmGateway.ts for chat, voice and the Fix Agent's provider factory.
// A route or library that imports an SDK directly bypasses the gateway's
// timeout, provider status and never-log-a-key rule, and fails here.
//
// Pure source analysis: no network, no DB.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, walk, rel, reportResult, type CheckResult } from "./_lib.js";

const API_SRC = join(ROOT, "artifacts/api-server/src");
export const GATEWAY_DIR = "lib/ai/";

const SDK_IMPORT = /(?:from\s+|import\s*\(\s*)["'](@workspace\/integrations-openai-ai-server[^"']*|@workspace\/integrations-anthropic-ai[^"']*|openai|@anthropic-ai\/sdk)["']/;

export function scanFile(key: string, src: string): string[] {
  if (key.startsWith(GATEWAY_DIR)) return [];
  const m = SDK_IMPORT.exec(src);
  return m ? [`imports the model SDK ${m[1]} directly; call lib/ai/llmGateway.ts`] : [];
}

export function checkSingleLlmGateway(): CheckResult {
  const violations: string[] = [];
  for (const file of walk(API_SRC, { skip: (p) => p.includes("__qa__") || p.endsWith(".test.ts") || p.includes("/src/scripts/") })) {
    if (!file.endsWith(".ts")) continue;
    const key = file.slice(API_SRC.length + 1);
    for (const v of scanFile(key, readFileSync(file, "utf8"))) violations.push(`${rel(file)}: ${v}`);
  }
  return { name: "single-llm-gateway", ok: violations.length === 0, violations, notes: [`model SDKs only under ${GATEWAY_DIR}`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkSingleLlmGateway();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
