// The one LLM gateway for the API (Tier 1 Platform Safety).
//
// Every model call goes through here: Ruby chat (streaming with tools), Ruby
// voice, the memory summariser, the trade coach, and the Backend Fix Agent's
// provider factory. Before this, three files imported the OpenAI client
// directly, each with its own timeout and error handling. One seam means one
// place for the timeout, the provider status, and the rule that a credential
// is never logged or returned.
//
// It changes no model and no prompt; it only owns the client.

import type { AIProvider } from "./providers/types.js";
import { getAIProvider as getFixAgentProvider, type AIProviderKey } from "./providers/factory.js";

export const CHAT_PROVIDER = "openai" as const;

/** A chat call stops waiting after this long (per call, not per stream chunk). */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

type ChatRole = "system" | "user" | "assistant";

export interface ChatCompletionInput {
  /** What the call is for, kept for logs and audits (never the prompt). */
  purpose: "assistant_memory_summary" | "trade_coach";
  model: string;
  messages: Array<{ role: ChatRole; content: string }>;
  maxTokens: number;
  /** Older chat models read max_tokens; newer ones max_completion_tokens (default). */
  tokenParam?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  /** Ask for a JSON object response. */
  json?: boolean;
  timeoutMs?: number;
}

async function client() {
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  return openai;
}

export function withTimeout<T>(p: Promise<T>, ms: number, purpose: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`llm_timeout:${purpose}`)), ms); }),
  ]);
}

/** One non-streaming chat completion; returns the reply text ("" when the model returned none). */
export async function completeChat(input: ChatCompletionInput): Promise<string> {
  const openai = await client();
  const res = await withTimeout(openai.chat.completions.create({
    model: input.model,
    messages: input.messages,
    ...(input.tokenParam === "max_tokens" ? { max_tokens: input.maxTokens } : { max_completion_tokens: input.maxTokens }),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.json ? { response_format: { type: "json_object" as const } } : {}),
  }), input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, input.purpose);
  return res.choices?.[0]?.message?.content ?? "";
}

export interface ToolChatStreamChunk {
  choices: Array<{
    delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
}

/** Ruby chat: a streaming completion with tool definitions. The caller consumes the stream. */
export async function streamToolChat(input: {
  model: string;
  messages: unknown[];
  tools: unknown[];
  toolChoice: unknown;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<AsyncIterable<ToolChatStreamChunk>> {
  const openai = await client();
  const stream = await withTimeout(openai.chat.completions.create({
    model: input.model,
    max_completion_tokens: input.maxTokens,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: input.messages as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: input.tools as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tool_choice: input.toolChoice as any,
    stream: true,
  }), input.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, "assistant_chat");
  return stream as unknown as AsyncIterable<ToolChatStreamChunk>;
}

/** Ruby voice: the audio helpers (format conversion, voice chat stream). */
export async function voiceAudio() {
  return import("@workspace/integrations-openai-ai-server/audio");
}

/** Whether the chat provider has its key. Never returns or logs the key. */
export function chatProviderConfigured(): boolean {
  const key = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  return Boolean(key && key.trim().length > 0);
}

/** The Backend Fix Agent's provider (Anthropic, managed or raw key). */
export function fixAgentProvider(key: AIProviderKey): AIProvider {
  return getFixAgentProvider(key);
}
