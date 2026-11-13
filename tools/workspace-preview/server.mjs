// Local visual QA only. No upstream network, credentials, database or execution.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve("artifacts/trading-dashboard/dist/public");
const now = new Date().toISOString();
const mode = {
  ok: true,
  userId: 1,
  currentAccountMode: "DEMO",
  cleanModeLabel: "Demo preview",
  cleanUserMessage: "Visual fixture preview",
  role: "USER",
  isAdmin: false,
  liveExecutionArmed: false,
  userSharedMasterAssignment: { attached: false },
  accountShellStatus: {
    accountMode: "DEMO",
    tradingMode: "DISABLED",
    approvalStatus: "APPROVED",
  },
  userAllocation: { hasAllocation: false, currentBalance: 0, equity: 0 },
  userRiskCaps: { maxLotSize: 0.1, requireStopLoss: true },
  userFrozenStatus: { isFrozen: false },
  userApprovalStatus: "APPROVED",
  userCanManualTrade: false,
  userCanAutoTrade: false,
  aiSleeveStatus: { enabled: false },
  modeSwitchOptions: [],
};
const candles = Array.from({ length: 180 }, (_, i) => {
  const open =
      12400 + i * 0.48 + Math.sin(i * 0.14) * 25 + Math.sin(i * 0.7) * 6,
    close = open + Math.sin(i * 1.9) * 8;
  return {
    openTime: new Date(
      Math.floor(Date.now() / 900000) * 900000 - (180 - i) * 900000,
    ).toISOString(),
    time: Math.floor(Date.now() / 900000) * 900000 - (180 - i) * 900000,
    open,
    high: Math.max(open, close) + 4,
    low: Math.min(open, close) - 5,
    close,
    volume: 0,
  };
});
const seen = new Set();
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p.startsWith("/api/")) {
        if (!seen.has(p)) {
          seen.add(p);
          console.log(req.method, p);
        }
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "GET") {
          res.writeHead(403);
          res.end(
            JSON.stringify({
              ok: false,
              message:
                "Read-only preview. Execution and scans require the connected ARX backend.",
            }),
          );
          return;
        }
        let data;
        if (p === "/api/me")
          data = {
            user: {
              id: 1,
              name: "Design preview",
              email: "preview@example.test",
              role: "USER",
              createdAt: now,
              updatedAt: now,
            },
          };
        else if (p === "/api/me/account-mode") data = mode;
        else if (p === "/api/me/master-live/access")
          data = {
            canTrade: false,
            status: "APPROVED",
            blockReason: "LIVE_BRIDGE_UNAVAILABLE",
            message: "Read-only design preview",
            limits: { requireStopLoss: true },
          };
        else if (p === "/api/chart/candles")
          data = {
            symbol: url.searchParams.get("symbol") || "V75",
            displaySymbol: "V75",
            timeframe: url.searchParams.get("timeframe") || "M15",
            assetClass: "synthetic",
            source: "Design fixture",
            quality: "stale",
            aiUsable: false,
            warning: "Sample candles for layout review. No market connection.",
            requestedLimit: 180,
            candleCount: 180,
            candles,
            chartTruthScore: null,
            feedStatus: {
              source: "Design fixture",
              quality: "stale",
              isLive: false,
              isStale: true,
              aiUsable: false,
              lastUpdateTime: now,
              lastCandleTime: now,
              missingCandles: 0,
              warning: "Sample candles — visual preview only",
            },
          };
        else if (p === "/api/market-scanner/universes")
          data = {
            universes: [
              {
                id: "all",
                label: "All markets",
                available: true,
                note: null,
                symbols: ["V75", "EURUSD", "XAUUSD"],
              },
              {
                id: "forex",
                label: "Forex",
                available: true,
                note: null,
                symbols: ["EURUSD"],
              },
            ],
          };
        else if (p === "/api/market-scanner/status")
          data = {
            running: false,
            opportunityCount: 0,
            lastScanAt: null,
            universe: "all",
            universeSymbols: [],
          };
        else if (p === "/api/market-scanner/opportunities")
          data = { opportunities: [] };
        else if (p === "/api/market-scanner/selected-market")
          data = { ok: false };
        else if (p === "/api/journal" || p === "/api/economic-events") data = [];
      else if (p === "/api/economic-calendar/events") data = {connected:false,provider:"Design preview",events:[],message:"Calendar provider is not connected in this preview."};
      else if (p === "/api/me/trades/open") data = {ok:true,cards:[],routingMode:"USER_OWNED_MT5",accountType:"demo",tradingMode:"DISABLED",bannerLabel:"Design preview"};
      else if (p.includes("notifications"))
          data = { notifications: [], unreadCount: 0 };
        else if (p.includes("onboarding"))
          data = { completed: true, dismissed: true, steps: [] };
        else if (p.includes("positions") || p.includes("trades"))
          data = { positions: [], trades: [], items: [], ok: true };
        else {
          res.writeHead(503);
          data = { ok: false, message: "Not connected in design preview" };
        }
        res.end(JSON.stringify(data));
        return;
      }
      let filename = path.resolve(root, "." + decodeURIComponent(p));
      if (!filename.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        if (!(await fs.stat(filename)).isFile())
          filename = path.join(root, "index.html");
      } catch {
        filename = path.join(root, "index.html");
      }
      let body = await fs.readFile(filename);
      const ext = path.extname(filename);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        }[ext] || "application/octet-stream",
      );
      if (ext === ".html")
        body = Buffer.from(
          body
            .toString()
            .replace(
              "<body>",
              '<body><div style="position:relative;z-index:100;background:#183449;color:#bfeaff;text-align:center;padding:7px;font:12px system-ui">DESIGN PREVIEW · Sample data · Scans and orders disabled</div>',
            ),
        );
      res.end(body);
    } catch (e) {
      res.writeHead(500);
      res.end("Preview error");
      console.error(e.message);
    }
  })
  .listen(4190, "127.0.0.1", () =>
    console.log("ARX preview: http://127.0.0.1:4190/live-chart"),
  );
