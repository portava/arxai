/** Read JSON normally or the actual first SSE data event, then cancel the stream. */
export async function readProbeBody(response: Response, maxBytes = 1_000_000): Promise<string> {
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response.text();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (!/^data:[^\n]*\r?\n\r?\n/m.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("SSE snapshot exceeded probe limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (!/^data:/m.test(text)) throw new Error("SSE endpoint ended without an initial data snapshot");
    return text;
  } finally { await reader.cancel(); }
}
