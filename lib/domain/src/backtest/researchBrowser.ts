import { prepareCausalResearch, finalizeCausalResearch, RESEARCH_ENGINE_VERSION, ResearchInputError, type ResearchInput, type ResearchConfig } from "./researchCore.js";
/** WebCrypto hashing; no Node imports, I/O, model, clock or broker access. */
export async function fingerprintResearch(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function requireWorker() {
  // Node may exercise WebCrypto parity offline. A browser must use a Worker;
  // marking this function async does not move the simulation off the UI thread.
  if ("document" in globalThis) throw new ResearchInputError("RESEARCH_WORKER_REQUIRED");
}
export async function runCausalResearchWeb(raw: ResearchInput, config: ResearchConfig) {
  requireWorker();
  // Copy, validate, simulate and freeze BEFORE the first await: caller mutation
  // during async hashing cannot mix input versions or change the result body.
  const prepared = prepareCausalResearch(raw, config);
  const [strategy, input, configuration] = await Promise.all([
    fingerprintResearch([RESEARCH_ENGINE_VERSION, prepared.config.strategy]),
    fingerprintResearch([RESEARCH_ENGINE_VERSION, prepared.input]),
    fingerprintResearch([RESEARCH_ENGINE_VERSION, prepared.config]),
  ]);
  const result = await fingerprintResearch([input, configuration, strategy, prepared.body]);
  return finalizeCausalResearch(prepared, { algorithm: "sha256", input, configuration, strategy, result });
}
