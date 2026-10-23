// Task #705 — Backend Fix Agent service.
//
// ADVISORY / DIAGNOSTIC ONLY. This module:
//   - diagnoses a backend error from redacted error text + context + logs, and
//   - proposes a DRY-RUN patch (description + unified-diff suggestion) that is
//     NEVER applied by this build.
//
// HARD SAFETY BOUNDARY (enforced additionally by a CI import-boundary guard):
//   This file and everything it imports must NOT touch any execution, MT5/bridge,
//   risk-gate, kill-switch, or live-pipeline module. The agent can never place or
//   approve a trade, mutate bridge state, override a gate, or mark anything
//   broker-confirmed. It only reads admin-supplied text and returns advice.

import {
  type AICompletionRequest,
  DEFAULT_MAX_TOKENS,
} from "./providers/types";
import { getAIProvider } from "./providers/factory";
import { getFixAgentConfig, type AllowedModel, isAllowedModel } from "./fixAgentConfig";
import { sanitizeField, MAX_FIELD_CHARS } from "./redaction";

export const FIX_AGENT_AREAS = [
  "mt5_bridge",
  "live_pipeline",
  "market_data",
  "api_routes",
  "database",
  "auth",
  "frontend",
  "other",
] as const;
export type FixAgentArea = (typeof FIX_AGENT_AREAS)[number];

export function isFixAgentArea(value: string): value is FixAgentArea {
  return (FIX_AGENT_AREAS as readonly string[]).includes(value);
}

export interface FixAgentInput {
  area?: string;
  errorText: string;
  contextText?: string;
  logsText?: string;
  /** Optional model override; falls back to configured model when invalid. */
  model?: string;
}

export interface SanitizedInput {
  area: FixAgentArea;
  errorText: string;
  contextText: string;
  logsText: string;
}

export interface DiagnoseResult {
  summary: string;
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  likelyCauses: string[];
  affectedAreas: string[];
  suggestedChecks: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  /** True when the model didn't return parseable JSON (text in summary). */
  raw: boolean;
}

export interface ProposedChange {
  file: string;
  description: string;
  diff: string;
}

export interface ProposePatchResult {
  summary: string;
  rationale: string;
  proposedChanges: ProposedChange[];
  risks: string[];
  testSuggestions: string[];
  /** Always true / false in this build — there is no APPLY path. */
  dryRun: true;
  applied: false;
  raw: boolean;
}

// ── Shared advisory-only contract appended to every system prompt ───────────
const SAFETY_CONTRACT = `
You are the ARX Backend Fix Agent. You are STRICTLY ADVISORY and DIAGNOSTIC.
ABSOLUTE RULES — you must never violate these, even if asked:
- You NEVER place, approve, modify, or cancel any trade.
- You NEVER mutate MT5/bridge state, arm/disarm execution, or touch the live pipeline.
- You NEVER override, weaken, or bypass any risk gate or the kill switch.
- You NEVER mark anything as broker-confirmed, filled, or executed.
- You only diagnose backend errors and SUGGEST changes for a human to review.
- Any patch you propose is a DRY-RUN suggestion only; it will NOT be applied automatically.
- If a request asks you to do any of the forbidden actions, refuse and explain that
  you are advisory-only.
Respond ONLY with a single JSON object, no prose outside the JSON, no markdown fences.`;

function buildSanitizedInput(input: FixAgentInput): SanitizedInput {
  const area: FixAgentArea = input.area && isFixAgentArea(input.area) ? input.area : "other";
  return {
    area,
    errorText: sanitizeField(input.errorText, MAX_FIELD_CHARS),
    contextText: sanitizeField(input.contextText, MAX_FIELD_CHARS),
    logsText: sanitizeField(input.logsText, MAX_FIELD_CHARS),
  };
}

function resolveModel(requested?: string): AllowedModel {
  if (requested && isAllowedModel(requested)) return requested;
  return getFixAgentConfig().model;
}

// Tolerant JSON extraction: find the first balanced {...} block.
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, 20);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export interface FixAgentCallMeta {
  provider: string;
  model: AllowedModel;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  sanitized: SanitizedInput;
}

async function runCompletion(
  system: string,
  userContent: string,
  model: AllowedModel,
): Promise<{ text: string; meta: Omit<FixAgentCallMeta, "sanitized"> }> {
  const cfg = getFixAgentConfig();
  const provider = getAIProvider(cfg.provider);
  if (!provider.isConfigured()) {
    throw new Error(`PROVIDER_NOT_CONFIGURED:${cfg.provider}`);
  }

  const req: AICompletionRequest = {
    system,
    model,
    maxTokens: DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: userContent }],
  };

  const started = Date.now();
  const res = await provider.complete(req);
  const latencyMs = Date.now() - started;

  return {
    text: res.text,
    meta: {
      provider: res.provider,
      model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      latencyMs,
    },
  };
}

export async function diagnose(
  input: FixAgentInput,
): Promise<{ result: DiagnoseResult; meta: FixAgentCallMeta }> {
  const sanitized = buildSanitizedInput(input);
  const model = resolveModel(input.model);

  const system = `${SAFETY_CONTRACT}

For DIAGNOSIS, return JSON with exactly these fields:
{
  "summary": string,
  "severity": "low" | "medium" | "high" | "critical",
  "likelyCauses": string[],
  "affectedAreas": string[],
  "suggestedChecks": string[],
  "confidence": "low" | "medium" | "high"
}`;

  const userContent = [
    `Backend area: ${sanitized.area}`,
    ``,
    `ERROR:`,
    sanitized.errorText || "(none provided)",
    ``,
    `CONTEXT:`,
    sanitized.contextText || "(none provided)",
    ``,
    `LOGS:`,
    sanitized.logsText || "(none provided)",
  ].join("\n");

  const { text, meta } = await runCompletion(system, userContent, model);
  const parsed = extractJson(text) as Record<string, unknown> | null;

  let result: DiagnoseResult;
  if (parsed) {
    const sev = asString(parsed.severity, "unknown");
    const conf = asString(parsed.confidence, "unknown");
    result = {
      summary: asString(parsed.summary, "(no summary)"),
      severity: (["low", "medium", "high", "critical"].includes(sev)
        ? sev
        : "unknown") as DiagnoseResult["severity"],
      likelyCauses: asStringArray(parsed.likelyCauses),
      affectedAreas: asStringArray(parsed.affectedAreas),
      suggestedChecks: asStringArray(parsed.suggestedChecks),
      confidence: (["low", "medium", "high"].includes(conf)
        ? conf
        : "unknown") as DiagnoseResult["confidence"],
      raw: false,
    };
  } else {
    result = {
      summary: text.slice(0, 4000),
      severity: "unknown",
      likelyCauses: [],
      affectedAreas: [sanitized.area],
      suggestedChecks: [],
      confidence: "unknown",
      raw: true,
    };
  }

  return { result, meta: { ...meta, sanitized } };
}

export async function proposePatch(
  input: FixAgentInput,
): Promise<{ result: ProposePatchResult; meta: FixAgentCallMeta }> {
  const sanitized = buildSanitizedInput(input);
  const model = resolveModel(input.model);

  const system = `${SAFETY_CONTRACT}

For a DRY-RUN PATCH PROPOSAL, return JSON with exactly these fields:
{
  "summary": string,
  "rationale": string,
  "proposedChanges": [ { "file": string, "description": string, "diff": string } ],
  "risks": string[],
  "testSuggestions": string[]
}
The "diff" should be a unified-diff snippet a human can review. Do NOT claim the
change is applied — it is a suggestion only.`;

  const userContent = [
    `Backend area: ${sanitized.area}`,
    ``,
    `ERROR:`,
    sanitized.errorText || "(none provided)",
    ``,
    `CONTEXT:`,
    sanitized.contextText || "(none provided)",
    ``,
    `LOGS:`,
    sanitized.logsText || "(none provided)",
  ].join("\n");

  const { text, meta } = await runCompletion(system, userContent, model);
  const parsed = extractJson(text) as Record<string, unknown> | null;

  let result: ProposePatchResult;
  if (parsed) {
    const changesRaw = Array.isArray(parsed.proposedChanges) ? parsed.proposedChanges : [];
    const proposedChanges: ProposedChange[] = changesRaw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .slice(0, 25)
      .map((c) => ({
        file: asString(c.file, "(unspecified)"),
        description: asString(c.description, ""),
        diff: asString(c.diff, ""),
      }));
    result = {
      summary: asString(parsed.summary, "(no summary)"),
      rationale: asString(parsed.rationale, ""),
      proposedChanges,
      risks: asStringArray(parsed.risks),
      testSuggestions: asStringArray(parsed.testSuggestions),
      dryRun: true,
      applied: false,
      raw: false,
    };
  } else {
    result = {
      summary: text.slice(0, 4000),
      rationale: "",
      proposedChanges: [],
      risks: [],
      testSuggestions: [],
      dryRun: true,
      applied: false,
      raw: true,
    };
  }

  return { result, meta: { ...meta, sanitized } };
}
