import { runCausalResearchV2Web } from "@workspace/domain/backtest/research-browser";
import type { ResearchV2Config, ResearchV2Input } from "@workspace/domain/backtest/research-core";

// This module is loaded only by a dedicated worker. The existing deterministic
// engine has no network, storage, execution, or account dependencies.
self.onmessage = async (event: MessageEvent<{ id: number; input: ResearchV2Input; config: ResearchV2Config }>) => {
  const { id, input, config } = event.data;
  try {
    const result = await runCausalResearchV2Web(input, config);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Historical calculation failed." });
  }
};
