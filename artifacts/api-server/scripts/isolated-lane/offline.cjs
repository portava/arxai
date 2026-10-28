// Preloaded (node --require) into the isolated API server and the test
// process: every socket connection to a non-loopback host throws before any
// DNS lookup or packet is sent. Unix sockets (the disposable PostgreSQL) and
// loopback (the API and the auth proxy) stay allowed. Each refusal prints one
// ARX_ISOLATED_BLOCKED_NETWORK line so the runner can count them.
const net = require("node:net");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function isolatedConnect(...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (o && typeof o === "object" && o.path) return connect.apply(this, args);
  const host = o && typeof o === "object"
    ? (o.host || o.hostname || "localhost")
    : (typeof args[1] === "string" ? args[1] : "localhost");
  if (!LOOPBACK.has(host)) {
    process.stderr.write(`ARX_ISOLATED_BLOCKED_NETWORK ${host}\n`);
    throw new Error(`ARX_ISOLATED_BLOCKED_NETWORK: external connection to ${host} refused`);
  }
  return connect.apply(this, args);
};
