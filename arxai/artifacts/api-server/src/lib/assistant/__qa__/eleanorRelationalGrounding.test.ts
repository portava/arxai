import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAnswer, ClaimGate } from "../grounding/runtimeVerifier.js";
import { buildEvidenceIndex, type ToolOutput } from "../grounding/evidence.js";
import { gateSpeech } from "../voice/speechGate.js";

const prices: ToolOutput[] = [{ name: "getMarketSnapshot", result: [
  { symbol: "EURUSD", lastPrice: 1.08, freshness: "REALTIME" },
  { symbol: "GBPUSD", lastPrice: 1.28, freshness: "REALTIME" },
] }];
const executions: ToolOutput[] = [{ name: "getExecution", result: [
  { symbol: "EURUSD", ticket: 111111, status: "filled", fillPrice: 1.08 },
  { symbol: "GBPUSD", ticket: 222222, status: "pending", fillPrice: null },
] }];
for (const text of [
  "1.2800 is the EURUSD price.", "The price is 1.2800 for EUR/USD.",
  "EURUSD, price 1.2800.", "AUDUSD is trading at 1.2800.", "EURUSD is 1.0800; 1.0800 is the GBPUSD price.",
]) test(`text and voice reject wrong relationship: ${text}`, () => {
  const checked = verifyAnswer(text, prices);
  assert.ok(checked.findings.some(f => f.kind === "WRONG_NUMBER"), JSON.stringify(checked));
  assert.equal(gateSpeech({ text, outputs: prices }).clean, false);
  for (let split = 1; split < text.length; split++) {
    const gate = new ClaimGate(buildEvidenceIndex(prices));
    const released = gate.push(text.slice(0, split)) + gate.push(text.slice(split)) + gate.end() + gate.footer();
    assert.equal(released, checked.text, `chunk boundary ${split}`);
  }
});
for (const text of [
  "1.0800 is the EURUSD price.", "The price is 1.0800 for EUR/USD.",
  "EURUSD is 1.0800; 1.2800 is the GBPUSD price.",
]) test(`correct relation remains usable: ${text}`, () => {
  assert.deepEqual(verifyAnswer(text, prices).findings, []);
  assert.equal(gateSpeech({ text, outputs: prices }).clean, true);
});
for (const text of [
  "Your GBPUSD order was filled.", "Your order was filled for GBPUSD.",
  "Your order was filled, ticket 222222.", "Ticket 222222 was filled.",
]) test(`execution proof must belong to the stated entity: ${text}`, () => {
  assert.ok(verifyAnswer(text, executions).findings.some(f => f.kind === "EXECUTION_UNCONFIRMED"));
  assert.equal(gateSpeech({ text, outputs: executions }).clean, false);
});
test("matching execution proof is still accepted", () => {
  assert.deepEqual(verifyAnswer("Your EURUSD order was filled, ticket 111111.", executions).findings, []);
});
