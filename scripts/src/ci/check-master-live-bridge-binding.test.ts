import assert from "node:assert/strict";
import { hasMasterGateInSharedBranch } from "./check-master-live-bridge-binding.js";

const wrap = (body: string) => `export async function dispatchLiveCommand() { ${body} }`;
const gate = "const mlg = await loadAndEvaluateMasterLiveBridgeGate();";
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "SHARED_MASTER_MT5") { ${"/* long gate */".repeat(500)} ${gate} }`)), true);
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "USER_OWNED_MT5") { ${gate} }`)), false);
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "SHARED_MASTER_MT5") { unrelated(); } ${gate}`)), false);
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "SHARED_MASTER_MT5") { unrelated(); } else { ${gate} }`)), false);
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "SHARED_MASTER_MT5") { /* ${gate} */ }`)), false);
assert.equal(hasMasterGateInSharedBranch(wrap(`if (routingMode === "SHARED_MASTER_MT5") { const unused = async () => { ${gate} }; }`)), false);
assert.equal(hasMasterGateInSharedBranch(`async function unrelated() { if (routingMode === "SHARED_MASTER_MT5") { ${gate} } }`), false);
console.log("PASS master-live-bridge-binding syntax fixtures (7 assertions)");
