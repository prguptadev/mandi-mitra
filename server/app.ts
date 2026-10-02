import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { withSession, requestGuard, bodyLimits, HttpError, type Env } from "./lib/http.ts";
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
import { syncSoon } from "./lib/cloud.ts";
import { appRoutes } from "./routes/appUpdate.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { tallyRoutes } from "./routes/tally.ts";
import { emandiRoutes } from "./routes/emandi.ts";
import { dayRoutes } from "./routes/days.ts";
import { millFollowupRoutes } from "./routes/millFollowup.ts";
import { desktopGate } from "./lib/desktopGate.ts";

/** The whole API. Electron imports this same object — no second implementation. */
export function createApp() {
  const app = new Hono<Env>();

  // the desktop app's server answers only the app's own windows (lib/desktopGate.ts); off elsewhere
  const gate = desktopGate();
  if (gate) app.use("*", gate);

  /* Only this computer's own pages may talk to the API: its own names and
     port, and changes only from its own pages (lib/http.ts requestGuard).
     MANDI_HOST=0.0.0.0 (opened to the shop's network on purpose) adds this
     computer's network addresses to those names; it never switches the check off. */
  const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const openToNetwork = Boolean(process.env.MANDI_HOST && !LOCAL.has(process.env.MANDI_HOST));
  app.use("/api/*", requestGuard(openToNetwork));
  app.use("/api/*", withSession);
  app.use("/api/*", bodyLimits);
  // with sync on, a change made here goes up within a couple of seconds
  app.use("/api/*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.status < 400) syncSoon();
  });

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
  app.route("/api/emandi", emandiRoutes);
  app.route("/api/app", appRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/tally", tallyRoutes);
  app.route("/api/days", dayRoutes);
  app.route("/api/mill-followup", millFollowupRoutes);

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
