// Negative fixtures for check-single-llm-gateway. Pure, no IO.
import assert from "node:assert/strict";
import { scanFile } from "./check-single-llm-gateway.js";

export {};

assert.deepEqual(scanFile("lib/ai/llmGateway.ts", `const { openai } = await import("@workspace/integrations-openai-ai-server");`), []);
assert.equal(scanFile("routes/x.ts", `import { openai } from "@workspace/integrations-openai-ai-server";`).length, 1);
assert.equal(scanFile("routes/x.ts", `const a = await import("@workspace/integrations-openai-ai-server/audio");`).length, 1);
assert.equal(scanFile("lib/assistant/y.ts", `import OpenAI from "openai";`).length, 1);
assert.equal(scanFile("lib/assistant/y.ts", `const A = (await import("@anthropic-ai/sdk")).default;`).length, 1);
assert.deepEqual(scanFile("routes/x.ts", `import { completeChat } from "../lib/ai/llmGateway.js";`), []);

console.log("check-single-llm-gateway fixtures: ok");
