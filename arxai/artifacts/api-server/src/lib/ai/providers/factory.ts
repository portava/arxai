// Task #705 — Provider factory. Selects the AI provider by key. Default is the
// managed Replit Anthropic provider; the raw-key provider is an inert alternate
// unless explicitly selected and configured.

import { type AIProvider } from "./types";
import { ReplitManagedClaudeProvider } from "./claudeProvider";
import { AnthropicApiKeyProvider } from "./anthropicApiKeyProvider";

export type AIProviderKey = "replit_managed" | "anthropic_api_key";

export const SUPPORTED_PROVIDERS: readonly AIProviderKey[] = [
  "replit_managed",
  "anthropic_api_key",
] as const;

export function isSupportedProvider(value: string): value is AIProviderKey {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function getAIProvider(key: AIProviderKey): AIProvider {
  switch (key) {
    case "anthropic_api_key":
      return new AnthropicApiKeyProvider();
    case "replit_managed":
    default:
      return new ReplitManagedClaudeProvider();
  }
}
