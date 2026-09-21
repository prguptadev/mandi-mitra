import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { withSession, HttpError, type Env } from "./lib/http.ts";
import { authRoutes } from "./routes/auth.ts";
import { adatiRoutes } from "./routes/adati.ts";
import { merchantRoutes } from "./routes/merchants.ts";
import { jinsRoutes } from "./routes/jins.ts";
import { userRoutes, roleRoutes } from "./routes/users.ts";
import { businessRoutes, auditRoutes } from "./routes/system.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { slipRoutes } from "./routes/slips.ts";
import { scanRoutes } from "./routes/scans.ts";
import { orderRoutes } from "./routes/orders.ts";
import { loadRoutes, parchaRoutes } from "./routes/loads.ts";
import { reportRoutes, stockRoutes } from "./routes/reports.ts";
import { ledgerRoutes, paymentRoutes } from "./routes/accounts.ts";
import { millLedgerRoutes, millReceiptRoutes } from "./routes/millAccounts.ts";
import { challanRoutes } from "./routes/challan.ts";
import { backupRoutes } from "./routes/backup.ts";
import { scannerRoutes } from "./routes/scanner.ts";
import { cloudRoutes } from "./routes/cloud.ts";
import { appRoutes } from "./routes/appUpdate.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";

/** The whole API. Electron imports this same object — no second implementation. */
export function createApp() {
  const app = new Hono<Env>();

  app.use("/api/*", withSession);

  app.get("/api/health", (c) => c.json({ ok: true, at: Date.now() }));

  app.route("/api/auth", authRoutes);
  app.route("/api/adati", adatiRoutes);
  app.route("/api/merchants", merchantRoutes);
  app.route("/api/jins", jinsRoutes);
  app.route("/api/users", userRoutes);
  app.route("/api/roles", roleRoutes);
  app.route("/api/business", businessRoutes);
  app.route("/api/audit", auditRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/slips", slipRoutes);
  app.route("/api/scans", scanRoutes);
  app.route("/api/orders", orderRoutes);
  app.route("/api/loads", loadRoutes);
  app.route("/api/parchas", parchaRoutes);
  app.route("/api/reports", reportRoutes);
  app.route("/api/stock", stockRoutes);
  app.route("/api/ledger", ledgerRoutes);
  app.route("/api/payments", paymentRoutes);
  app.route("/api/mill-ledger", millLedgerRoutes);
  app.route("/api/mill-receipts", millReceiptRoutes);
  app.route("/api/challan", challanRoutes);
  app.route("/api/backup", backupRoutes);
  app.route("/api/scanner", scannerRoutes);
  app.route("/api/cloud", cloudRoutes);
  app.route("/api/app", appRoutes);
  app.route("/api/dashboard", dashboardRoutes);

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code ?? "error" }, err.status as 400);
    }
    if (err instanceof ZodError) {
      const first = err.errors[0];
      return c.json({
        error: first?.message ?? "Invalid input",
        code: "validation",
        field: first?.path.join("."),
        issues: err.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
      }, 400);
    }
    console.error("[api]", err);
    return c.json({ error: "Something went wrong on the server", code: "internal" }, 500);
  });

  /* The desktop app serves its own screens from the built files, from the
     same address as the API, so no separate web server is needed. */
  const STATIC = process.env.MANDI_STATIC_DIR ? path.resolve(process.env.MANDI_STATIC_DIR) : null;
  if (STATIC) {
    const TYPES: Record<string, string> = {
      ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
      ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".webmanifest": "application/manifest+json",
    };
    app.get("*", (c) => {
      const url = new URL(c.req.url).pathname;
      if (url.startsWith("/api/")) return c.json({ error: "Not found", code: "not_found" }, 404);
      let file = path.resolve(STATIC, "." + decodeURIComponent(url));
      // never outside the built folder; unknown paths are app routes, so the app itself
      if (!file.startsWith(STATIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC, "index.html");
      const immutable = file.includes(`${path.sep}assets${path.sep}`);
      return new Response(new Uint8Array(fs.readFileSync(file)), {
        headers: { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
      });
    });
  }

  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));
  return app;
}
