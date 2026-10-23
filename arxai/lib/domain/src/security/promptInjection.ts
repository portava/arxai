// ── @workspace/domain/security — prompt-injection detector ──────────────────
// Pure, deterministic, IO-free. Scans EXTERNAL text (market news, economic
// calendar, third-party provider messages, user-uploaded content, alerts) for
// prompt-injection / instruction-override patterns BEFORE that text is handed
// to the assistant model.
//
// SAFETY:
//   - This NEVER executes or interprets the text. It only flags injection
//     patterns and returns a neutralized copy that is safe to use as DATA.
//   - On detection the caller logs a redacted security event and keeps using
//     the (neutralized) content strictly as data, never as instructions.
//   - Conservative: a false positive only replaces a phrase with a marker; it
//     never blocks a feature or fabricates content.

/** Replacement marker substituted for a detected injection span. */
export const INJECTION_NEUTRALIZED_MARKER = "[filtered]";

export interface PromptInjectionResult {
  /** True when at least one injection pattern matched. */
  detected: boolean;
  /** Names of the matched pattern families (deduped, stable order). */
  patterns: string[];
  /** Neutralized text — safe to use as data. Equal to the input when clean. */
  sanitized: string;
}

interface InjectionPattern {
  name: string;
  re: RegExp;
}

// Each RegExp is global + case-insensitive so we can both detect and replace
// every occurrence. Patterns are intentionally bounded ([^.\n]{0,N}) so a match
// stays within a single clause and cannot swallow a whole paragraph.
const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: "ignore_instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|the|these|any)\b[^.\n]{0,30}\b(?:instruction|instructions|prompt|prompts|context|rules?|messages?|guardrails?)\b/gi,
  },
  {
    name: "system_prompt_exfil",
    re: /\b(?:reveal|show|print|repeat|output|display|leak|expose|tell\s+me|give\s+me)\b[^.\n]{0,40}\b(?:system|developer|hidden|initial|original)\b[^.\n]{0,20}\b(?:prompt|instructions?|message|rules?)\b/gi,
  },
  {
    name: "role_override",
    re: /\b(?:you\s+are\s+now|from\s+now\s+on|act\s+as|pretend\s+to\s+be|roleplay\s+as|behave\s+as|you\s+must\s+now|switch\s+to)\b/gi,
  },
  {
    name: "new_instructions",
    re: /\b(?:new|updated|revised|real|actual)\b[^.\n]{0,15}\b(?:instructions?|task|role|system\s*prompt|directive)\b\s*:?/gi,
  },
  {
    name: "jailbreak",
    re: /\b(?:jailbreak|developer\s+mode|dan\s+mode|do\s+anything\s+now|unfiltered\s+mode|sudo\s+mode|admin\s+mode|god\s+mode)\b/gi,
  },
  {
    name: "secret_exfil",
    re: /\b(?:reveal|show|print|give\s+me|leak|expose|what\s+is|send\s+me)\b[^.\n]{0,30}\b(?:api[\s_-]?key|secret|token|password|env(?:ironment)?\s*variable|credentials?|session\s*secret|bridge\s*token)\b/gi,
  },
  {
    name: "instruction_delimiter",
    re: /<\|[^|>]{0,40}\|>|<\/?\s*system\s*>|\[\/?\s*(?:system|inst|instructions?)\s*\]|#{2,}\s*(?:system|instruction)/gi,
  },
  {
    name: "tool_injection",
    re: /\b(?:call|invoke|execute|run|trigger)\b[^.\n]{0,20}\b(?:tool|function|requestliveorder|requestdemoorder|placeorder|executeinstant)\b/gi,
  },
];

/**
 * Scan external text for prompt-injection patterns. Returns the matched pattern
 * names and a neutralized copy in which each injection span is replaced by
 * {@link INJECTION_NEUTRALIZED_MARKER}. Pure and deterministic.
 */
export function scanForPromptInjection(text: string | null | undefined): PromptInjectionResult {
  const input = typeof text === "string" ? text : "";
  if (input.length === 0) {
    return { detected: false, patterns: [], sanitized: input };
  }

  const matched = new Set<string>();
  let sanitized = input;

  for (const { name, re } of INJECTION_PATTERNS) {
    // Reset lastIndex (these are shared global regexes).
    re.lastIndex = 0;
    if (re.test(sanitized)) {
      matched.add(name);
      re.lastIndex = 0;
      sanitized = sanitized.replace(re, ` ${INJECTION_NEUTRALIZED_MARKER} `);
    }
  }

  if (matched.size === 0) {
    return { detected: false, patterns: [], sanitized: input };
  }

  // Tidy whitespace introduced by replacements.
  sanitized = sanitized.replace(/\s{2,}/g, " ").trim();

  return {
    detected: true,
    patterns: [...matched],
    sanitized,
  };
}
