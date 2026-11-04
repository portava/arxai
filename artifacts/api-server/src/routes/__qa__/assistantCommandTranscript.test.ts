// AC7 (2026-11-04): POST /me/assistant/instant-trade-command takes an optional
// `conversationId`; when the user owns it, the command text and the reply are
// saved as messages in that conversation. AC1: the push-to-talk route forwards
// the provider's {type:"audio"} as audio_chunk and emits user_transcript.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeDb } from "./_fakeRouteDb.js";

let owned: unknown[] = [{ id: 5 }];
const realDb = await import("@workspace/db");
const fake = createFakeDb({});
const inserts: Array<Record<string, unknown>> = [];
const fakeDb = {
  ...fake.db,
  select: () => ({ from: () => ({ where: () => ({ limit: async () => owned }) }) }),
  insert: () => ({ values: async (v: Record<string, unknown>) => { inserts.push(v); return []; } }),
  update: () => ({ set: () => ({ where: async () => [] }) }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

const { attachCommandTranscript, commandReplyText } = await import("../meAssistant.js");
const flush = () => new Promise((r) => setTimeout(r, 20));

test("AC7: an owned conversationId persists the command and the reply, response unchanged", async () => {
  owned = [{ id: 5 }]; inserts.length = 0;
  const sent: unknown[] = [];
  const res = { json: (b: unknown) => { sent.push(b); return res; } };
  const id = await attachCommandTranscript(res, 7, "5", "buy EURUSD 0.01 sl 1.0850");
  assert.equal(id, 5);
  const body = { ok: false, classification: "MISSING_VOLUME", message: "How much EURUSD?" };
  res.json(body);
  await flush();
  assert.deepEqual(sent, [body]);
  assert.equal(inserts.length, 2);
  assert.deepEqual([inserts[0]!.role, inserts[0]!.content, inserts[0]!.conversationId], ["user", "buy EURUSD 0.01 sl 1.0850", 5]);
  assert.deepEqual([inserts[1]!.role, inserts[1]!.content], ["assistant", "How much EURUSD?"]);
});

test("AC7: a foreign / missing / invalid conversationId persists nothing", async () => {
  inserts.length = 0;
  owned = [];
  const res = { json: (b: unknown) => b };
  assert.equal(await attachCommandTranscript(res, 7, 99, "close all"), null);
  assert.equal(await attachCommandTranscript(res, 7, undefined, "close all"), null);
  assert.equal(await attachCommandTranscript(res, 7, "abc", "close all"), null);
  res.json({ message: "x" });
  await flush();
  assert.equal(inserts.length, 0);
  assert.equal(commandReplyText({ error: "MISSING_TEXT" }), "MISSING_TEXT");
  assert.equal(commandReplyText(null), null);
});

test("AC1: voice route transcribes the clip, maps provider audio to audio_chunk and ends with done", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = readFileSync(`${here}../meAssistant.ts`, "utf8");
  const voice = src.slice(src.indexOf('"/me/assistant/conversations/:id/voice"'), src.indexOf("POST /me/assistant/instant-trade-command"));
  assert.match(voice, /audio\.speechToText\(buffer, format\)/);
  assert.match(voice, /sendVoice\(\{ type: "user_transcript", data: heard \}\)/);
  assert.match(voice, /evType === "audio" \|\| evType === "audio_chunk"/);
  assert.match(voice, /sendVoice\(\{ type: "done" \}\)/);
});
