import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { db, schema, DB_PATH } from "../db/client.ts";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, requireAuth, HttpError, mainComputerOnly, sharingChanged, type Env } from "../lib/http.ts";
import { endRemoteSessions } from "../lib/auth.ts";
import {
  FREE_BYTES, CloudError, clashList, clearClashes, cloudBusy, cloudDevices, connectCloud, disconnectCloud,
  joinCloud, readCloudConfig, restoreFromCloud, syncNow, syncStatus, measureCloudNext, setSyncLive,
} from "../lib/cloud.ts";

/* Cloud sync holds all data, so setting it up sits with backups (backup.manage).
   Everyone signed in may see whether this computer is in step. */
export const cloudRoutes = new Hono<Env>();

const view = async () => {
  const c = readCloudConfig();
  const s = syncStatus();
  return {
    configured: Boolean(c.enc), live: c.live, host: c.host, deviceName: c.deviceName,
    lastSyncAt: c.lastSyncAt, lastError: c.lastError, pausedReason: c.pausedReason,
    pushedLast: c.pushedLast, pulledLast: c.pulledLast, rowsInCloud: c.rowsInCloud, sizeBytes: c.sizeBytes, freeBytes: FREE_BYTES,
    syncing: cloudBusy(), state: s.state, pending: s.enabled ? s.pending : 0, clashes: s.enabled ? s.clashes : 0,
    devices: c.enc ? await cloudDevices() : [],
  };
};
const fail = (e: unknown, code: string) => bad(e instanceof Error ? e.message : "The cloud did not answer", code);

cloudRoutes.get("/status", requireAuth, (c) => c.json(syncStatus()));

cloudRoutes.get("/", can("backup.manage"), async (c) => c.json(await view()));

/** Connect: an empty cloud starts from this computer; one with data asks to join. */
cloudRoutes.put("/", can("backup.manage"), mainComputerOnly, async (c) => {
  const { connection } = z.object({ connection: z.string().trim().max(1000).nullable() }).parse(await c.req.json());
  if (!connection) {
    disconnectCloud();
    await audit({ actor: actor(c), action: "cloud.disconnect", entity: "settings", entityId: "cloud", entityLabel: "Cloud sync turned off on this computer" });
    return c.json(await view());
  }
  let r: Awaited<ReturnType<typeof connectCloud>>;
  try { r = await connectCloud(connection); } catch (e) { throw fail(e, "cloud_connect"); }
  if (r.needsJoin) return c.json({ ...(await view()), needsJoin: r.needsJoin });
  // the connection string holds a password: only the host reaches the audit trail
  await audit({ actor: actor(c), action: "cloud.connect", entity: "settings", entityId: "cloud",
    entityLabel: `Cloud sync ${r.started ? "started from this computer" : "resumed"}: ${readCloudConfig().host}` });
  void syncNow().catch(() => undefined);
  return c.json(await view());
});

/** Hold or resume sync on this computer, keeping the connection. */
cloudRoutes.post("/live", can("backup.manage"), mainComputerOnly, async (c) => {
  const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
  try { setSyncLive(on); } catch (e) { throw fail(e, "cloud_live"); }
  await audit({
    actor: actor(c), action: on ? "cloud.resume" : "cloud.hold", entity: "settings", entityId: "cloud",
    entityLabel: on ? "Sync switched on for this computer" : "Sync held on this computer — nothing goes up or comes down",
  });
  return c.json(await view());
});

/** Join a cloud other computers use: this computer's data is replaced by the cloud's (backed up first). */
cloudRoutes.post("/join", can("backup.manage"), mainComputerOnly, async (c) => {
  const { connection, confirm } = z.object({ connection: z.string().trim().max(1000), confirm: z.string() }).parse(await c.req.json());
  if (confirm !== "JOIN") throw bad("Type JOIN to confirm", "confirm");
  const who = actor(c);
  let r: Awaited<ReturnType<typeof joinCloud>>;
  try { r = await joinCloud(connection); } catch (e) { throw fail(e, "cloud_join"); }
  await audit({ actor: who, action: "cloud.join", entity: "settings", entityId: "cloud",
    entityLabel: `Joined cloud sync (${Object.values(r.counts).reduce((s, n) => s + n, 0)} records; backup ${r.backup} taken first)` }).catch(() => undefined);
  return c.json(r);
});

/**
 * A brand-new install joins straight from the first screen: allowed only
 * while this computer has no users at all (the same moment sign-up is open).
 */
cloudRoutes.post("/join-fresh", mainComputerOnly, async (c) => {
  const users = db.select({ id: schema.users.id }).from(schema.users).limit(1).all();
  if (users.length) throw new HttpError(409, "This computer is already set up. Use Settings › Cloud sync.", "already_setup");
  const { connection } = z.object({ connection: z.string().trim().max(1000) }).parse(await c.req.json());
  try {
    const r = await joinCloud(connection);
    return c.json({ ok: true, records: Object.values(r.counts).reduce((s, n) => s + n, 0) });
  } catch (e) { throw fail(e, "cloud_join"); }
});

cloudRoutes.post("/sync", can("backup.manage"), async (c) => {
  try {
    measureCloudNext();
    const r = await syncNow();
    return c.json({ ...(await view()), ...r });
  } catch (e) { throw fail(e, e instanceof CloudError && e.offline ? "offline" : "cloud_sync"); }
});

cloudRoutes.post("/restore", can("backup.manage"), mainComputerOnly, async (c) => {
  const { confirm } = z.object({ confirm: z.string() }).parse(await c.req.json());
  if (confirm !== "RESTORE") throw bad("Type RESTORE to confirm", "confirm");
  const who = actor(c);
  try {
    const r = await restoreFromCloud();
    // on a new computer the person restoring may not exist in the restored data
    await audit({ actor: who, action: "cloud.restore", entity: "settings", entityId: "cloud",
      entityLabel: `Brought all data down from the cloud (${Object.values(r.counts).reduce((s, n) => s + n, 0)} records; backup ${r.backup} taken first)` }).catch(() => undefined);
    return c.json(r);
  } catch (e) { throw fail(e, "cloud_restore"); }
});

cloudRoutes.get("/clashes", can("backup.manage"), (c) => c.json(clashList(200)));
cloudRoutes.delete("/clashes", can("backup.manage"), async (c) => {
  clearClashes();
  await audit({ actor: actor(c), action: "cloud.clashes_cleared", entity: "settings", entityId: "cloud", entityLabel: "Sync clashes list cleared" });
  return c.json({ ok: true });
});

cloudRoutes.put("/device", can("backup.manage"), mainComputerOnly, async (c) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(await c.req.json());
  const { patchDeviceName } = await import("../lib/cloud.ts");
  patchDeviceName(name);
  return c.json(await view());
});

/* ------------------------------------------------ this computer on the network

   A second laptop on the same shop network can use THIS computer's books
   directly: one database, nothing to sync, whatever one types the other sees
   on its next refresh. It is off until switched on here, because it opens the
   API to every machine on that network (a PIN is still needed to get in).
   The desktop app reads this file when it starts, so it takes a restart. */

const NETWORK_FILE = () => path.join(path.dirname(DB_PATH), "network.json");

function readShare(): boolean {
  try { return JSON.parse(fs.readFileSync(NETWORK_FILE(), "utf8")).share === true; } catch { return false; }
}

/** The addresses the other laptop can type, this computer's own on each network. */
function addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

const networkView = () => {
  const share = readShare();
  const live = Boolean(process.env.MANDI_HOST && !["127.0.0.1", "localhost", "::1"].includes(process.env.MANDI_HOST));
  return {
    share, live, needsRestart: share !== live,
    port: Number(process.env.PORT ?? 8787),
    addresses: addresses(),
  };
};

cloudRoutes.get("/network", can("backup.manage"), (c) => c.json(networkView()));

/** Which computer's books these are — everyone signed in may ask. */
cloudRoutes.get("/host", requireAuth, (c) => c.json({
  deviceName: readCloudConfig().deviceName,
  /** True when this app is serving the shop's network, not only itself. */
  shared: readShare(),
}));

cloudRoutes.put("/network", can("backup.manage"), mainComputerOnly, async (c) => {
  const { share } = z.object({ share: z.boolean() }).parse(await c.req.json());
  fs.writeFileSync(NETWORK_FILE(), JSON.stringify({ share }, null, 2));
  sharingChanged();
  // switched off: whoever signed in from another device is signed out now, not at the end of their day
  if (!share) await endRemoteSessions();
  await audit({
    actor: actor(c), action: share ? "network.share.on" : "network.share.off", entity: "settings", entityId: "network",
    entityLabel: share
      ? `This computer's books opened to the local network (${addresses().join(", ") || "no network address"})`
      : "This computer's books closed to the local network",
  });
  return c.json(networkView());
});
