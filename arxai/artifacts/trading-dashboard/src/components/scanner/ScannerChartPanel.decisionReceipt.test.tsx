// The chart's "Save decision receipt" action toasted "Decision receipt saved —
// An immutable read of X was recorded." on any HTTP 200. The route fails open:
// when the receipt insert throws, createDecisionReceipt returns null and the
// route answers 200 {created:false, receipt:null}. Nothing was recorded, so
// the toast must not say it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionReceiptToast, saveDecisionReceipt } from "./ScannerChartPanel";

const fetchMock = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const REQ = { symbol: "EURUSD", timeframe: "M5" };

describe("decision receipt save reports what the server recorded", () => {
  it("does not say 'saved' when the server answers 200 {created:false}", async () => {
    fetchMock.mockResolvedValue(reply({ created: false, receipt: null }));
    const result = await saveDecisionReceipt(REQ);
    expect(result.kind).toBe("not_saved");
    const t = decisionReceiptToast(result, "EURUSD", "M5");
    expect(t.title).not.toBe("Decision receipt saved");
    expect(t.title).toBe("Decision receipt not saved");
    expect(t.description).not.toMatch(/immutable read .* was recorded/);
    expect(t.description).toContain("nothing was recorded");
    expect(t.variant).toBe("destructive");
  });

  it("says 'saved' only when the server reports created:true", async () => {
    fetchMock.mockResolvedValue(reply({ created: true, receipt: { receiptId: "r1" } }));
    const result = await saveDecisionReceipt(REQ);
    expect(result.kind).toBe("saved");
    const t = decisionReceiptToast(result, "EURUSD", "M5");
    expect(t.title).toBe("Decision receipt saved");
    expect(t.description).toBe("An immutable read of EURUSD (M5) was recorded.");
  });

  it("a 200 reply that does not say whether a receipt was created is not a save", async () => {
    fetchMock.mockResolvedValue(reply({}));
    const result = await saveDecisionReceipt(REQ);
    expect(result.kind).toBe("failed");
    expect(decisionReceiptToast(result, "EURUSD", "M5").title).toBe("Could not save receipt");
  });

  it("an HTTP error or network failure is 'could not save', with the reason", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: "x" }, 500));
    const http = await saveDecisionReceipt(REQ);
    expect(http).toEqual({ kind: "failed", detail: "HTTP 500" });
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const net = await saveDecisionReceipt(REQ);
    expect(net).toEqual({ kind: "failed", detail: "network down" });
    expect(decisionReceiptToast(net, "EURUSD", "M5").description).toContain("network down");
  });

  it("posts the chart's symbol and timeframe as a read-only chart_read receipt", async () => {
    fetchMock.mockResolvedValue(reply({ created: true, receipt: null }));
    await saveDecisionReceipt(REQ);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/me/chart/decision-receipt");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ symbol: "EURUSD", timeframe: "M5", intent: "analyze", source: "chart_read" });
  });
});
