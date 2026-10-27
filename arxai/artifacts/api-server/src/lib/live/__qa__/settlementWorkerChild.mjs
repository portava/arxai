// Fresh process recovery against the guarded disposable fixture only.
const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if (url.pathname !== "/arx_result_evidence_test" || url.username !== "arx_qa" ||
    !/\/arx-result-evidence-[^/]+\/socket$/.test(url.searchParams.get("host") ?? "")) throw new Error("Disposable database required");
globalThis.fetch = async () => { throw new Error("External I/O forbidden"); };
const { runResultSettlementPass } = await import("../resultSettlementOutbox.ts");
const { pool } = await import("@workspace/db");
try { console.log(JSON.stringify(await runResultSettlementPass())); }
finally { await pool.end(); }
