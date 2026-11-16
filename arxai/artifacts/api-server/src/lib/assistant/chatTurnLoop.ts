// Eleanor chat: the model/tool loop, extracted from routes/meAssistant.ts so
// the production route and the deterministic eval harness run the SAME code.
//
// The loop does four things on each turn:
//   1. Stream the model.
//   2. Pass every content delta through a ClaimGate (grounding/runtimeVerifier.ts)
//      built from the tool outputs gathered so far this request. Text reaches the
//      client only one checked sentence at a time.
//   3. If the turn called tools, clear the preamble that was sent, dispatch each
//      tool, and add its output to the evidence.
//   4. On the final text turn, append the verifier footer when anything was
//      marked or removed.
//
// The route still owns the HTTP side: persistence, memory, the done event and
// closing the stream. Nothing here can place an order. Tools go through the
// caller's `dispatch`, which in production is dispatchTool with the per-request
// SafetyEnvelope.

import type { ToolChatStreamChunk } from "../ai/llmGateway.js";
import { resolveAssistantToolChoice } from "./chartReadRouting.js";
import { toolResultText } from "./toolResultText.js";
import { buildEvidenceIndex, type ToolOutput } from "./grounding/evidence.js";
import { ClaimGate } from "./grounding/runtimeVerifier.js";
import type { Finding } from "./grounding/claimsChecker.js";

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; content: string; tool_call_id: string };

export type StreamChat = (input: {
  model: string; maxTokens: number; messages: unknown[]; tools: unknown[]; toolChoice: unknown;
}) => Promise<AsyncIterable<ToolChatStreamChunk>>;

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  status: "ok" | "error";
  durationMs: number;
}

export interface ChatTurnLoopInput {
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  maxTurns: number;
  forceStructuralRead: boolean;
  userText: string;
  toolResultChars: number;
  streamChat: StreamChat;
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  send: (event: Record<string, unknown>) => void;
  isAborted: () => boolean;
  onToolResult?: (r: ToolCallRecord) => Promise<void> | void;
  logError?: (msg: string, err: unknown) => void;
}

export type ChatTurnLoopStatus = "answered" | "provider_error" | "stream_error" | "aborted";

export interface ChatTurnLoopResult {
  status: ChatTurnLoopStatus;
  /** The verified text the user saw (what the route persists). */
  assistantText: string;
  /** The model's raw final text before verification (for audit/evals only). */
  rawAnswer: string;
  toolCalls: ToolCallRecord[];
  findings: Finding[];
  verifierFailedClosed: boolean;
}

export const PROVIDER_UNAVAILABLE_MESSAGE = "AI provider unavailable. Please try again in a moment.";
export const STREAM_INTERRUPTED_MESSAGE = "AI stream interrupted. Please try again.";

export async function runChatTurnLoop(input: ChatTurnLoopInput): Promise<ChatTurnLoopResult> {
  const { messages, send } = input;
  const toolCalls: ToolCallRecord[] = [];
  const outputs: ToolOutput[] = [];
  let assistantText = "";
  let rawAnswer = "";
  let findings: Finding[] = [];
  let failedClosed = false;
  const done = (status: ChatTurnLoopStatus): ChatTurnLoopResult =>
    ({ status, assistantText, rawAnswer, toolCalls, findings, verifierFailedClosed: failedClosed });

  for (let turn = 0; turn < input.maxTurns; turn++) {
    if (input.isAborted()) return done("aborted");
    let stream: AsyncIterable<ToolChatStreamChunk>;
    try {
      stream = await input.streamChat({
        model: input.model,
        maxTokens: 8192,
        messages,
        tools: input.tools,
        toolChoice: resolveAssistantToolChoice(turn, input.forceStructuralRead, input.maxTurns),
      });
    } catch (e) {
      input.logError?.("assistant_openai_failed", e);
      send({ type: "error", message: PROVIDER_UNAVAILABLE_MESSAGE });
      return done("provider_error");
    }

    // Every visible character passes the claim gate, which is built from the
    // evidence gathered so far (all tool outputs before this turn + the user's text).
    const gate = new ClaimGate(buildEvidenceIndex(outputs, input.userText));
    let turnContent = "";
    const toolCallsAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | null = null;
    const emit = (text: string) => { if (text) send({ type: "content", content: text }); };

    try {
      for await (const chunk of stream) {
        if (input.isAborted()) break;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.content) {
          turnContent += delta.content;
          emit(gate.push(delta.content));
        }
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCallsAcc[i]) toolCallsAcc[i] = { id: tc.id ?? `call_${i}`, name: "", args: "" };
            if (tc.id) toolCallsAcc[i].id = tc.id;
            if (tc.function?.name) toolCallsAcc[i].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[i].args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (e) {
      input.logError?.("assistant_stream_consume_failed", e);
      // Nothing half-finished may stay on screen or reach TTS.
      if (gate.released > 0) send({ type: "content_clear", chars: gate.released });
      send({ type: "error", message: STREAM_INTERRUPTED_MESSAGE });
      return done("stream_error");
    }
    if (input.isAborted()) return done("aborted");

    const calls = Object.values(toolCallsAcc).filter((c) => c.name);
    if (calls.length === 0) {
      // Final turn: flush the last segment, then the footer if anything was flagged.
      const tail = gate.end();
      emit(tail);
      const footer = gate.footer();
      emit(footer);
      const visible = gate.segments.map((s) => s.text).join("") + footer;
      if (turnContent) { assistantText += visible; rawAnswer += turnContent; }
      findings = gate.findings;
      failedClosed = gate.failedClosed;
      break;
    }

    // The turn called tools: any text it streamed was preamble. Clear exactly
    // what was released (the gate may still hold an unreleased tail, never sent).
    if (gate.released > 0) send({ type: "content_clear", chars: gate.released });
    messages.push({
      role: "assistant",
      content: turnContent || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    });

    for (const c of calls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {}; } catch { parsedArgs = {}; }
      send({ type: "tool_call", name: c.name });
      const t0 = Date.now();
      let result: unknown;
      let status: "ok" | "error" = "ok";
      try {
        result = await input.dispatch(c.name, parsedArgs);
      } catch (e) {
        status = "error";
        result = { error: "tool_failed", name: c.name, message: (e as Error)?.message ?? "unknown" };
      }
      const ms = Date.now() - t0;
      send({ type: "tool_result", name: c.name, status, durationMs: ms });
      // Forward ONLY the structured read the tool produced (display tier
      // readLayer + chartRead) so the chat renders the same honesty-gated
      // reasoning block as the Scanner. Never prose, never an execution signal.
      if (c.name === "readChartStructure" && status === "ok" && result && typeof result === "object") {
        const r = result as { chartRead?: Record<string, unknown>; readLayer?: string; feedUnconfirmed?: boolean };
        const read = r.chartRead;
        if (read && typeof read === "object") {
          send({
            type: "reasoning",
            read,
            symbol: typeof read.symbol === "string" ? read.symbol : "",
            timeframe: typeof read.timeframe === "string" ? read.timeframe : "",
            readLayer: typeof r.readLayer === "string" ? r.readLayer : "INSUFFICIENT",
            feedUnconfirmed: r.feedUnconfirmed === true,
          });
        }
      }
      const record: ToolCallRecord = { name: c.name, args: parsedArgs, result, status, durationMs: ms };
      toolCalls.push(record);
      outputs.push({ name: c.name, result });
      try { await input.onToolResult?.(record); } catch { /* tool log non-fatal */ }
      messages.push({ role: "tool", tool_call_id: c.id, content: toolResultText(result, input.toolResultChars) });
    }

    if (finishReason && finishReason !== "tool_calls") break;
  }
  return done(input.isAborted() ? "aborted" : "answered");
}
