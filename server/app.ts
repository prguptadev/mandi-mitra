import { Hono } from "hono";
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

  app.notFound((c) => c.json({ error: "Not found", code: "not_found" }, 404));
  return app;
}
