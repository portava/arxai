// Raw Anthropic API-key provider ("anthropic_api_key") — Task #707.
//
// Fully-implemented alternate path: lets an operator point the Fix Agent at a
// directly-keyed Anthropic account (their own billing) instead of the managed
// Replit proxy, by setting the ANTHROPIC_API_KEY secret and
// CLAUDE_PROVIDER=anthropic_api_key. No other code changes are required — the
// service, redaction, dry-run, audit, and import-boundary guarantees are
// identical to the managed provider because both go through the same AIProvider
// seam (lib/ai/providers/types.ts).
//
// The default deployment still uses the managed Replit provider; this provider
// is inert (isConfigured()=false → fails closed) unless the key secret is set.
//
// SAFETY: the key is read from a secret env var, used ONLY to construct the SDK
// client, and is NEVER logged, returned, or persisted. Per-request timeout and
// retry are honoured. Anything sent to the model is already redacted + capped by
// the service before it reaches complete().

import {
  type AIProvider,
  type AICompletionRequest,
  type AICompletionResponse,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from "./types";

/** Secret env var holding the operator's own Anthropic API key. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Read + trim the key from the secret. Empty/whitespace-only => null. */
function readApiKey(): string | null {
  const raw = process.env[ANTHROPIC_API_KEY_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class AnthropicApiKeyProvider implements AIProvider {
  readonly name = "anthropic_api_key";

  isConfigured(): boolean {
    return readApiKey() !== null;
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResponse> {
    const apiKey = readApiKey();
    if (apiKey === null) {
      throw new Error("PROVIDER_NOT_CONFIGURED:anthropic_api_key");
    }

    // Reuse the SDK that ships with the integration package; construct a client
    // bound to the raw key (default Anthropic base URL) rather than the managed
    // proxy. Lazy-import so server boot never depends on this alternate path.
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      {
        timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: req.maxRetries ?? DEFAULT_MAX_RETRIES,
      },
    );

    const text = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .trim();

    return {
      text,
      model: message.model ?? req.model,
      provider: this.name,
      usage: {
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
      },
    };
  }
}
