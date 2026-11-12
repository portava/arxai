import { defineConfig, type PreviewServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig(async ({ command }) => {
  const rawPort = command === "build" ? undefined : process.env.PORT;

  if (command !== "build" && !rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = command === "build" ? undefined : Number(rawPort);

  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = process.env.BASE_PATH ?? (command === "build" ? "/" : undefined);

  if (!basePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
  }

  const missingBuiltAsset404 = {
    name: "missing-built-asset-404",
    configurePreviewServer(server: PreviewServer) {
      const publicDir = path.resolve(import.meta.dirname, "dist/public");
      const assetDir = path.resolve(publicDir, "assets");

      server.middlewares.use((req, res, next) => {
        if ((req.method !== "GET" && req.method !== "HEAD") || !req.url) {
          return next();
        }

        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        } catch {
          return next();
        }

        if (!pathname.startsWith("/assets/") || !/\.(js|css)$/.test(pathname)) {
          return next();
        }

        const assetPath = path.resolve(publicDir, `.${pathname}`);
        if (!assetPath.startsWith(`${assetDir}${path.sep}`) || existsSync(assetPath)) {
          return next();
        }

        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(req.method === "HEAD" ? "" : "Not Found");
      });
    },
  };

  return {
    base: basePath,
    plugins: [
      react(),
      tailwindcss(),
      missingBuiltAsset404,
      runtimeErrorOverlay(),
      ...(process.env.NODE_ENV !== "production" &&
      process.env.REPL_ID !== undefined
        ? [
            await import("@replit/vite-plugin-cartographer").then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, ".."),
              }),
            ),
            await import("@replit/vite-plugin-dev-banner").then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      allowedHosts: true,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
