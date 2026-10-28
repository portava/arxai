// Preloaded (node --require) into the isolated API server and the test
// process. It refuses, by throwing (or failing the callback / promise):
//   - TCP and TLS socket connections (net.Socket.prototype.connect, which
//     net.connect, tls.connect, http(s), undici fetch and pg use) to a
//     non-loopback host, before any DNS lookup or packet is sent;
//   - UDP sends and connects (dgram.Socket.prototype.send / connect) to a
//     non-loopback address;
//   - node:dns lookups and resolver queries (dns.lookup, dns.resolve*,
//     dns.Resolver, and their dns.promises forms) for any name outside the
//     loopback set.
// Unix sockets (the disposable PostgreSQL) and loopback (the API and the auth
// proxy) stay allowed. Native addons or child processes that open their own
// sockets are not covered; the server starts none. Each refusal prints one
// ARX_ISOLATED_BLOCKED_NETWORK line so the runner can count them.
const net = require("node:net");
const dgram = require("node:dgram");
const dns = require("node:dns");
const { syncBuiltinESMExports } = require("node:module");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::ffff:127.0.0.1"]);
const refusal = (kind, host) => {
  process.stderr.write(`ARX_ISOLATED_BLOCKED_NETWORK ${kind} ${host}\n`);
  const err = new Error(`ARX_ISOLATED_BLOCKED_NETWORK: external ${kind} to ${host} refused`);
  err.code = "ARX_ISOLATED_BLOCKED_NETWORK";
  return err;
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function isolatedConnect(...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (o && typeof o === "object" && o.path) return connect.apply(this, args);
  const host = o && typeof o === "object"
    ? (o.host || o.hostname || "localhost")
    : (typeof args[1] === "string" ? args[1] : "localhost");
  if (!LOOPBACK.has(host)) throw refusal("tcp", host);
  return connect.apply(this, args);
};

// send(msg[, offset, length][, port][, address][, callback]): the address is
// the last string argument; a connected socket sends to its connect target.
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function isolatedSend(...args) {
  const address = args.filter((a) => typeof a === "string").pop();
  if (address !== undefined && !LOOPBACK.has(address)) throw refusal("udp", address);
  return send.apply(this, args);
};
const udpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function isolatedUdpConnect(port, address, ...rest) {
  const host = typeof address === "string" ? address : "localhost";
  if (!LOOPBACK.has(host)) throw refusal("udp", host);
  return udpConnect.call(this, port, address, ...rest);
};

// node:dns. Callback forms report the refusal through the callback; promise
// forms reject. Loopback names still resolve normally.
const guardCallback = (name, original) => function isolatedDns(host, ...rest) {
  if (LOOPBACK.has(String(host))) return original.call(this, host, ...rest);
  const cb = [...rest].reverse().find((a) => typeof a === "function");
  const err = refusal(`dns:${name}`, host);
  if (cb) { process.nextTick(cb, err); return undefined; }
  throw err;
};
const guardPromise = (name, original) => function isolatedDnsPromise(host, ...rest) {
  if (LOOPBACK.has(String(host))) return original.call(this, host, ...rest);
  return Promise.reject(refusal(`dns:${name}`, host));
};
const RESOLVE = ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
  "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
for (const name of ["lookup", "lookupService", ...RESOLVE]) {
  if (typeof dns[name] === "function") dns[name] = guardCallback(name, dns[name]);
  if (typeof dns.promises[name] === "function") dns.promises[name] = guardPromise(name, dns.promises[name]);
  const cbProto = dns.Resolver?.prototype;
  if (cbProto && typeof cbProto[name] === "function") cbProto[name] = guardCallback(name, cbProto[name]);
  const pProto = dns.promises.Resolver?.prototype;
  if (pProto && typeof pProto[name] === "function") pProto[name] = guardPromise(name, pProto[name]);
}
syncBuiltinESMExports();
