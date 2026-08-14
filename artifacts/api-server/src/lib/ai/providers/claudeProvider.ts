// Task #705 — Replit-managed Anthropic provider ("replit_managed").
//
// Uses the Replit AI Integrations proxy (no raw API key in our code; billed to
// Replit credits). The integration client throws at import time if its env is
// missing, so we lazy-import it inside complete() to keep server boot resilient
// when the integration isn't provisioned.

import {
  type AIProvider,
  type AICompletionRequest,
  type AICompletionResponse,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from "./types";

export class ReplitManagedClaudeProvider implements AIProvider {
  readonly name = "replit_managed";

  isConfigured(): boolean {
    return (
      typeof process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL === "string" &&
      process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL.length > 0 &&
      typeof process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY === "string" &&
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY.length > 0
    );
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error("PROVIDER_NOT_CONFIGURED:replit_managed");
    }

    // Lazy import: the client constructs (and throws if env missing) at import.
    const { anthropic } = await import("@workspace/integrations-anthropic-ai");

    const message = await anthropic.messages.create(
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
