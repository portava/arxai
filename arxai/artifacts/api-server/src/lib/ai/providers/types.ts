// Task #705 — Provider-agnostic AI completion contract for the Backend Fix Agent.
//
// The Fix Agent never talks to a concrete SDK directly; it always goes through
// an AIProvider. This keeps the managed-Replit-Anthropic path and the raw
// API-key path ("anthropic_api_key") interchangeable, and keeps a single seam to
// enforce timeout, retry, and "never log a key" behaviour.

export type AIRole = "user" | "assistant";

export interface AIMessage {
  role: AIRole;
  content: string;
}

export interface AICompletionRequest {
  /** System prompt — the agent's advisory-only contract lives here. */
  system: string;
  messages: AIMessage[];
  model: string;
  /** Hard cap on output tokens. */
  maxTokens?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Retry attempts on transient/network failures. */
  maxRetries?: number;
}

export interface AICompletionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AICompletionResponse {
  text: string;
  model: string;
  provider: string;
  usage: AICompletionUsage;
}

export interface AIProvider {
  /** Stable provider key, e.g. "replit_managed" | "anthropic_api_key". */
  readonly name: string;
  /** True when the provider has the env it needs to make a real call. */
  isConfigured(): boolean;
  /** Make a single completion call. Implementations MUST NOT log credentials. */
  complete(req: AICompletionRequest): Promise<AICompletionResponse>;
}

export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
