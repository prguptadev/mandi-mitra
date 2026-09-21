import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, type Env } from "../lib/http.ts";
import { FREE_BYTES, cloudBusy, connectCloud, disconnectCloud, readCloudConfig, restoreFromCloud, syncNow } from "../lib/cloud.ts";

/* The cloud copy holds all data, so it sits with backups (backup.manage). */
export const cloudRoutes = new Hono<Env>();

const view = () => {
  const c = readCloudConfig();
  return {
    configured: Boolean(c.enc), host: c.host, lastSyncAt: c.lastSyncAt, lastError: c.lastError,
    pushedLast: c.pushedLast, rowsInCloud: c.rowsInCloud, sizeBytes: c.sizeBytes, freeBytes: FREE_BYTES, syncing: cloudBusy(),
  };
};

cloudRoutes.get("/", can("backup.manage"), (c) => c.json(view()));

cloudRoutes.put("/", can("backup.manage"), async (c) => {
  const { connection } = z.object({ connection: z.string().trim().max(1000).nullable() }).parse(await c.req.json());
  if (!connection) {
    disconnectCloud();
    await audit({ actor: actor(c), action: "cloud.disconnect", entity: "settings", entityId: "cloud", entityLabel: "Cloud copy turned off" });
    return c.json(view());
  }
  try {
    await connectCloud(connection);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "Could not connect", "cloud_connect");
  }
  // the connection string holds a password: only the host reaches the audit trail
  await audit({ actor: actor(c), action: "cloud.connect", entity: "settings", entityId: "cloud", entityLabel: `Cloud copy set up: ${readCloudConfig().host}` });
  return c.json(view());
});

cloudRoutes.post("/sync", can("backup.manage"), async (c) => {
  try {
    const r = await syncNow();
    return c.json({ ...view(), ...r });
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "The cloud copy failed", "cloud_sync");
  }
});

cloudRoutes.post("/restore", can("backup.manage"), async (c) => {
  const { confirm } = z.object({ confirm: z.string() }).parse(await c.req.json());
  if (confirm !== "RESTORE") throw bad('Type RESTORE to confirm', "confirm");
  const who = actor(c);
  try {
    const r = await restoreFromCloud();
    // on a new computer the person restoring may not exist in the restored data
    await audit({ actor: who, action: "cloud.restore", entity: "settings", entityId: "cloud",
      entityLabel: `Restored from the cloud copy (${Object.values(r.counts).reduce((s, n) => s + n, 0)} rows; backup ${r.backup} taken first)` }).catch(() => undefined);
    return c.json(r);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "Restore failed", "cloud_restore");
  }
});
