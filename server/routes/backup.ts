import { Hono } from "hono";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DB_PATH, RESTORE_WHILE_CONNECTED, dismissStartNotice, readStartNotice } from "../db/client.ts";
import { plainError } from "../db/durable.ts";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, param, notFound, attachment, requireAuth, type Env } from "../lib/http.ts";
import { BACKUP_DIR, BACKUP_NAME, backupNow, checkFolder, listBackups, readBackupConfig, scheduleRestore, setBackupFolder } from "../lib/backup.ts";
import { sqlite } from "../db/client.ts";
import { cloudConnected } from "../lib/cloud.ts";

/* Backups are of the whole database, so only someone who may change
   settings sees, takes or downloads them. */
export const backupRoutes = new Hono<Env>();

/** Where everything is kept on this computer. */
const DATA_DIR = path.dirname(DB_PATH);
const folders = () => ({
  data: DATA_DIR, db: DB_PATH, scans: path.join(DATA_DIR, "scans"), backups: BACKUP_DIR,
});

backupRoutes.get("/", can("backup.manage"), (c) => c.json({ ...readBackupConfig(), backups: listBackups().slice(0, 40), folders: folders() }));

/** Opens one of those folders in Explorer (Finder on a Mac) on this computer. */
backupRoutes.post("/open-folder", can("backup.manage"), async (c) => {
  const { which } = z.object({ which: z.enum(["data", "scans", "backups"]) }).parse(await c.req.json());
  const dir = folders()[which];
  fs.mkdirSync(dir, { recursive: true });
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [dir], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  } catch { /* no file manager here: the path is shown on screen anyway */ }
  return c.json({ ok: true, dir });
});

backupRoutes.put("/", can("backup.manage"), async (c) => {
  const { folder } = z.object({ folder: z.string().trim().max(400).nullable() }).parse(await c.req.json());
  if (folder) {
    const problem = checkFolder(folder);
    if (problem) throw bad(problem, "bad_folder");
  }
  setBackupFolder(folder || null);
  await audit({ actor: actor(c), action: "backup.folder", entity: "settings", entityId: "backup", entityLabel: folder ? `Backups also copied to ${folder}` : "Second backup folder removed" });
  return c.json({ ok: true });
});

/*
 * One line on every screen, for everyone signed in: what start-up did to the
 * books (a backup put back, damaged books), else a backup on this computer
 * that is failing. Second-folder problems stay on the Backups card.
 */
backupRoutes.get("/notice", requireAuth, (c) => {
  const cfg = readBackupConfig();
  return c.json({ start: readStartNotice(), backupFailing: cfg.localError });
});
backupRoutes.post("/notice/dismiss", requireAuth, (c) => {
  dismissStartNotice();
  return c.json({ ok: true });
});

backupRoutes.post("/run", can("backup.manage"), async (c) => {
  let r: Awaited<ReturnType<typeof backupNow>>;
  try { r = await backupNow("manual"); } catch (e) { throw bad(plainError(e), "backup_failed"); }
  await audit({ actor: actor(c), action: "backup.run", entity: "settings", entityId: "backup", entityLabel: `Backup ${r.name} (${Math.round(r.bytes / 1024)} KB)` });
  return c.json({ ...r, ...readBackupConfig() });
});

backupRoutes.get("/file/:name", can("backup.manage"), async (c) => {
  const name = param(c, "name");
  if (!BACKUP_NAME.test(name)) throw bad("Not a backup file", "bad_name");
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw notFound("That backup is no longer there");
  await audit({ actor: actor(c), action: "backup.download", entity: "settings", entityId: "backup", entityLabel: name });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: { "Content-Type": "application/vnd.sqlite3", "Content-Disposition": attachment(`MandiMitra-${name}`) },
  });
});

/**
 * Go back to a backup. It is carried out when the app next starts, before the
 * database is opened; the database it replaces is kept as before-restore-….
 * Refused while this computer is connected to cloud sync, held or not: the
 * other computers' newer work lives in the cloud, and old records put back
 * here would be sent up over it (or never fetched again). The cloud's copy is
 * brought down instead; db/client.ts refuses the same at start-up.
 */
backupRoutes.post("/restore", can("backup.manage"), async (c) => {
  const { name, confirm } = z.object({ name: z.string(), confirm: z.string() }).parse(await c.req.json());
  if (confirm !== "RESTORE") throw bad("Type RESTORE to confirm", "confirm");
  if (cloudConnected()) throw bad(RESTORE_WHILE_CONNECTED, "sync_on");
  const here = (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n;
  try { scheduleRestore(name, here); } catch (e) { throw bad(e instanceof Error ? e.message : "That backup cannot be restored", "bad_backup"); }
  await audit({ actor: actor(c), action: "backup.restore", entity: "settings", entityId: "backup", entityLabel: `Going back to ${name} at the next start` });
  // the desktop app restarts by itself; elsewhere the person restarts it
  const relaunch = (globalThis as { __mandiRelaunch?: () => void }).__mandiRelaunch;
  if (relaunch) setTimeout(relaunch, 800);
  return c.json({ scheduled: true, restarting: Boolean(relaunch) });
});
