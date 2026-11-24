// Two collector processes preserve independent issuance anchors across consecutive windows.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";

const [action, source, output] = process.argv.slice(2);
assert.ok(["register", "original", "replacement", "replay"].includes(action) && source && output && process.argv.length === 5);
const dir = resolve(output), root = resolve(source), code = path => join(root, "artifacts/api-server/src/lib", path);
const url = new URL(process.env.DATABASE_URL ?? "");
assert.ok(url.hostname === "localhost" && url.searchParams.get("host")?.startsWith("/") && url.pathname === "/ati_public_handoff_v1");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = await readFile(new URL("../../../docs/structural-evidence/ati-specialists-v1/public-handoff-plan.json", import.meta.url));
const plan = JSON.parse(bytes);
const files = ["data/providers/derivPublicDataClient.ts", "data/atiDerivQuotes.ts", "structural/atiSpecialistTape.ts", "selfTrade/atiDerivQuoteReplay.ts"];
const digests = Object.fromEntries(await Promise.all(files.map(async name => [name, hash(await readFile(code(name)))])));
assert.equal(digests[files[0]], plan.transportSha256);
const identity = { planSha256: hash(bytes), runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), sources: digests };
const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value) + "\n", {flag: "wx", mode: 0o600});
const read = async name => JSON.parse(await readFile(join(dir, name), "utf8"));
async function delayUntil(at) {
  while (Date.now() < at) await wait(at - Date.now());
}
const windows = plan.windowStarts.map(value => Date.parse(value)), step = plan.minutesPerWindow * 60_000;
const end = windows.at(-1) + step, initialOpen = Date.parse(plan.openAt.original);
if (action === "register") {
  assert.ok(Date.now() < initialOpen);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await write("registration.json", { registeredAt: Date.now(), identity, plan });
} else {
  const reg = await read("registration.json");
  assert.deepEqual(reg.identity, identity);
  assert.deepEqual(reg.plan, plan);
  assert.ok(reg.registeredAt < initialOpen);
  const { retainSpecialistQuoteStudy, flushAtiDerivQuotes } = await import(pathToFileURL(code(files[1])));
  if (action === "replay") {
    assert.ok(Date.now() >= end + 6000);
    const { loadAtiDerivReplayQuotes } = await import(pathToFileURL(code(files[3])));
    const { readSpecialistTape } = await import(pathToFileURL(code(files[2])));
    for (const role of ["original", "replacement"]) {
      const done = await read(role + ".finished");
      assert.equal(done.role, role);
      assert.ok(done.finishedAt >= end + 6000 && done.finishedAt <= Date.now());
      assert.deepEqual(done.identity, identity);
    }
    const reports = [];
    for (const [role, index] of [["original",0],["original",1],["replacement",1]]) {
      const name = role + "-" + index + ".json";
      const saved = await read(name);
      assert.equal(saved.start, windows[index]);
      assert.equal(saved.role, role);
      const publication = await read(name + ".publication");
      assert.equal(publication.sha256, hash(await readFile(join(dir, name))));
      assert.ok(publication.recordedAt >= saved.issuedAt && publication.recordedAt <= Date.now());
      const timely = saved.issuedAt >= saved.start + plan.issueDelayMs &&
        publication.recordedAt <= saved.start + plan.latestIssueDelayMs;
      const priced = !timely ? { reason: "MISSED_ISSUANCE" } : !saved.anchor ? { reason: "NO_ISSUANCE_QUOTE" }
        : readSpecialistTape(saved.anchor, plan.symbol, await loadAtiDerivReplayQuotes(saved.anchor, saved.start + step + 5000),
          saved.issuedAt, publication.recordedAt, saved.start + step);
      reports.push({ role, index, streamId: saved.anchor?.streamId ?? null, ...priced });
    }
    const distinct = reports[1].streamId && reports[2].streamId && reports[1].streamId !== reports[2].streamId;
    const sameOriginal = reports[0].streamId && reports[0].streamId === reports[1].streamId;
    console.log(JSON.stringify({ identity, reports, acceptance: distinct && sameOriginal &&
      reports[0].prices && reports[2].prices ? "HANDOFF_PRICED_BOTH_WINDOWS" : "HANDOFF_UNVERIFIED", executionAuthority:"NONE" }));
  } else {
    const role = action, open = Date.parse(plan.openAt[role]);
    assert.ok(Date.now() < open, "A missed warmup cannot be backfilled");
    const log = (event, data) => console.log(JSON.stringify({ event, at: Date.now(), role, ...data }));
    const { DerivPublicDataClient, DERIV_PUBLIC_DATA_URL } = await import(pathToFileURL(code(files[0])));
    assert.equal(DERIV_PUBLIC_DATA_URL, "wss://api.derivws.com/trading/v1/options/ws/public");
    let sockets = 0, stopping = false;
    const client = new DerivPublicDataClient([{ symbol:"V75", derivId:plan.symbol, displayName:"Volatility 75 Index" }],
      { enabled: () => true, socket: address => {
        assert.equal(address, DERIV_PUBLIC_DATA_URL);
        const socket = new WebSocket(address, {maxPayload: 2 * 1024 * 1024}), number = ++sockets;
        socket.on("open", () => log("OPEN", {number}));
        socket.on("close", (code, reason) => log("CLOSE", {number, code, reason: reason.toString("utf8").slice(0,120), stopping}));
        return socket;
      } });
    await write(role + ".started", {pid:process.pid, startedAt:Date.now(), identity});
    try {
      await delayUntil(open);
      await client.subscribeTicks(plan.symbol).catch(() => log("SUBSCRIPTION_FAILED", {}));
      for (const index of role === "original" ? [0,1] : [1]) {
        const start = windows[index], name = role + "-" + index + ".json";
        await delayUntil(start + plan.issueDelayMs);
        const issuedAt = Date.now(), anchor = retainSpecialistQuoteStudy(plan.symbol, issuedAt, start + step) ?? null;
        await write(name, {role, start, issuedAt, anchor});
        const recordedAt = Date.now();
        await write(name + ".publication", {recordedAt, sha256: hash(await readFile(join(dir,name)))});
        log("ISSUANCE", {start, anchored: !!anchor});
      }
      await delayUntil(end + 6000);
      await flushAtiDerivQuotes();
      await write(role + ".finished", {role, finishedAt:Date.now(), identity});
    } finally {
      stopping = true;
      client.stop();
      log("END", {sockets});
    }
  }
}
process.exit(0);
