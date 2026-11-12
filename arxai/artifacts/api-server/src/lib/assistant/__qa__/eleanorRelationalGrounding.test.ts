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

const pending: ToolOutput[] = [{ name: "getExecution", result:
  { symbol: "EURUSD", ticket: 111111, status: "pending" },
}];
const coordinatedClaims = [
  "Your EURUSD order was submitted; it was filled.",
  "The order has not failed and was filled.",
  "The order has not failed AND was filled.",
  "The order has not failed and filled.",
  "Your EURUSD order was submitted, then it was filled.",
  "Your EURUSD order was submitted; it has been filled.",
];
for (const text of coordinatedClaims) test(`local execution affirmation is checked: ${text}`, () => {
  const checked = verifyAnswer(text, pending);
  assert.ok(checked.findings.some(f => f.kind === "EXECUTION_UNCONFIRMED"));
  assert.equal(gateSpeech({ text, outputs: pending }).clean, false);
  for (let split = 1; split < text.length; split++) {
    const gate = new ClaimGate(buildEvidenceIndex(pending));
    assert.equal(gate.push(text.slice(0, split)) + gate.push(text.slice(split)) + gate.end() + gate.footer(), checked.text);
  }
  assert.deepEqual(verifyAnswer(text, executions).findings, [], "a matching confirmed execution remains usable");
  assert.equal(gateSpeech({ text, outputs: executions }).clean, true);
});
for (const text of [
  "Your EURUSD order was submitted; it was not filled.",
  "The order has not failed and has not been filled.",
  "Your order will be executed and filled after confirmation.",
  "Your order will be executed and fully filled after confirmation.",
  "Your order was not executed and filled.",
  "Your order was submitted; a glass was filled with water.",
]) test(`negation and unrelated predicates remain usable: ${text}`, () => {
  assert.deepEqual(verifyAnswer(text, pending).findings, []);
  assert.equal(gateSpeech({ text, outputs: pending }).clean, true);
});
for (const text of [
  "Your GBPUSD order was submitted; it was filled.",
  "Ticket 222222 was submitted and was filled.",
]) test(`inherited execution subject preserves identity: ${text}`, () => {
  assert.ok(verifyAnswer(text, executions).findings.some(f => f.kind === "EXECUTION_UNCONFIRMED"));
  assert.equal(gateSpeech({ text, outputs: executions }).clean, false);
});
