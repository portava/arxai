// Loopback proxy in front of the isolated API, carrying an OWNER session.
//
// Why: the legacy tests/*.test.mjs suite predates the global auth gate and
// sends no credentials, so without this every gated endpoint answers 401 and
// the lane would test the gate instead of the endpoints. The proxy signs in
// once, through the normal /api/auth/login flow, as the owner account the
// isolated server bootstrapped (ARX_OWNER_EMAIL / ARX_OWNER_INITIAL_PASSWORD,
// disposable database only), and adds that session cookie to each request.
// The server's auth code is unchanged: no dev bypass, no test-only route.
// Tests that must prove the unauthenticated path call the API directly
// (ISOLATED_API_DIRECT_URL), not through this proxy.
import http from "node:http";

const upstream = new URL(process.env.ARX_LANE_UPSTREAM);
const login = await fetch(new URL("/api/auth/login", upstream), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: process.env.ARX_OWNER_EMAIL, password: process.env.ARX_OWNER_INITIAL_PASSWORD }),
});
const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log(`AUTH_PROXY login ${login.status} cookies=${cookies ? cookies.split("; ").map((c) => c.split("=")[0]).join(",") : "none"}`);
if (login.status !== 200 || !cookies) process.exit(1);

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: upstream.host };
  headers.cookie = [req.headers.cookie, cookies].filter(Boolean).join("; ");
  const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});
server.listen(Number(process.env.ARX_LANE_PROXY_PORT ?? 0), "127.0.0.1", () => {
  console.log(`AUTH_PROXY_LISTENING ${server.address().port}`);
});
