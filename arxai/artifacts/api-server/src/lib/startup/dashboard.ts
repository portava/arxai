import express, { type Express } from "express";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/** Built public assets only. API routes and their auth middleware mount first. */
export function mountProductionDashboard(app: Express, directory: string): void {
  const root = realpathSync(directory), index = path.join(root, "index.html");
  if (!existsSync(index)) throw new Error("Build the ARX dashboard before starting production.");
  app.use((req, res, next) => {
    let decoded: string;
    try { decoded = decodeURIComponent(req.path); } catch { res.status(400).json({ error: "BAD_REQUEST" }); return; }
    // Never turn an unknown API endpoint into a successful HTML response.
    if (decoded === "/api" || decoded.startsWith("/api/") || decoded.includes("\\") || decoded.includes("\0")
      || decoded.split("/").some(p => p.startsWith("."))) {
      res.status(404).json({ error: "NOT_FOUND" }); return;
    }
    next();
  });
  app.use(express.static(root, { index: false, dotfiles: "deny", redirect: false,
    setHeaders: res => { res.setHeader("Cache-Control", "no-cache"); res.setHeader("X-Content-Type-Options", "nosniff"); } }));
  app.use((req, res, next) => {
    const decoded = decodeURIComponent(req.path);
    const parts = decoded.split("/");
    if (!["GET", "HEAD"].includes(req.method) || !req.accepts("html")
      || parts.some(p => p.startsWith(".")) || path.extname(decoded) || decoded.startsWith("/assets/")) { next(); return; }
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(index);
  });
}
