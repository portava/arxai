import { createHash } from "node:crypto";
import { prepareCausalResearch, finalizeCausalResearch, RESEARCH_ENGINE_VERSION, type ResearchInput, type ResearchConfig } from "./researchCore.js";
export * from "./researchCore.js";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Existing synchronous server API; v1 bytes and fingerprints are unchanged. */
export function runCausalResearch(raw: ResearchInput, config: ResearchConfig) {
  const prepared = prepareCausalResearch(raw, config);
  const strategy = fingerprint([RESEARCH_ENGINE_VERSION, prepared.config.strategy]);
  const input = fingerprint([RESEARCH_ENGINE_VERSION, prepared.input]);
  const configuration = fingerprint([RESEARCH_ENGINE_VERSION, prepared.config]);
  const result = fingerprint([input, configuration, strategy, prepared.body]);
  return finalizeCausalResearch(prepared, { algorithm: "sha256", input, configuration, strategy, result });
}

import { prepareCausalResearchV2, finalizeCausalResearchV2, RESEARCH_V2_ENGINE_VERSION, type ResearchV2Input, type ResearchV2Config } from "./researchCore.js";
export function runCausalResearchV2(raw: ResearchV2Input, config: ResearchV2Config) {
  const prepared = prepareCausalResearchV2(raw, config);
  const strategy = fingerprint([RESEARCH_V2_ENGINE_VERSION, prepared.config.strategy]);
  const input = fingerprint([RESEARCH_V2_ENGINE_VERSION, prepared.input]);
  const configuration = fingerprint([RESEARCH_V2_ENGINE_VERSION, prepared.config]);
  const result = fingerprint([input, configuration, strategy, prepared.body]);
  return finalizeCausalResearchV2(prepared, { algorithm: "sha256", input, configuration, strategy, result });
}
