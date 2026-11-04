// AI chat audit 2026-11-04 (A9). Tool results used to be cut with
// JSON.stringify(result).slice(0, N), which hands the model (and the memory
// block) a truncated, unparseable JSON fragment. This helper keeps the output
// valid JSON: when the full serialization fits it is returned unchanged;
// otherwise a JSON envelope carries a bounded preview plus an explicit
// truncation marker so the model knows data is missing instead of guessing.

export interface TruncatedToolResult {
  truncated: true;
  originalChars: number;
  keptChars: number;
  note: string;
  preview: string;
}

const MARKER_OVERHEAD = 220;

export function toolResultText(result: unknown, maxChars: number): string {
  let full: string;
  try {
    full = JSON.stringify(result);
  } catch {
    full = JSON.stringify({ unserializable: true, type: typeof result });
  }
  if (full === undefined) full = "null";
  if (full.length <= maxChars) return full;
  let keep = Math.max(0, maxChars - MARKER_OVERHEAD);
  // The preview is re-escaped inside the envelope (quotes, backslashes), so
  // shrink until the serialized envelope itself fits the budget.
  for (let i = 0; i < 8; i++) {
    const envelope: TruncatedToolResult = {
      truncated: true,
      originalChars: full.length,
      keptChars: keep,
      note: "Tool result exceeded the size budget. 'preview' is a raw JSON prefix, not a complete object; missing fields are unknown, not absent. Re-call the tool with a smaller limit if you need them.",
      preview: full.slice(0, keep),
    };
    const out = JSON.stringify(envelope);
    if (out.length <= maxChars || keep === 0) return out;
    keep = Math.max(0, keep - (out.length - maxChars) - 16);
  }
  return JSON.stringify({ truncated: true, originalChars: full.length, keptChars: 0, note: "Tool result exceeded the size budget.", preview: "" });
}

export function isTruncatedToolResultText(text: string): boolean {
  try {
    const v = JSON.parse(text) as { truncated?: unknown };
    return !!v && typeof v === "object" && v.truncated === true;
  } catch {
    return false;
  }
}
