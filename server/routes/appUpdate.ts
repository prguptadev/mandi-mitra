import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { can, actor, bad, requireAuth, mainComputerOnly, type Env } from "../lib/http.ts";
import { appVersion, checkForUpdate, goBack, installUpdate, isDesktop, setUpdateFolder, updateFolder } from "../lib/updater.ts";

export const appRoutes = new Hono<Env>();

/** Anyone signed in may see which version they are on. */
appRoutes.get("/", requireAuth, (c) => c.json({ version: appVersion(), desktop: isDesktop(), platform: process.platform }));

appRoutes.get("/update", can("app.update"), async (c) => c.json(await checkForUpdate()));

appRoutes.put("/update", can("app.update"), mainComputerOnly, async (c) => {
  const { folder } = z.object({ folder: z.string().trim().min(3).max(400) }).parse(await c.req.json());
  try { setUpdateFolder(folder); } catch (e) { throw bad(e instanceof Error ? e.message : "Bad folder", "bad_folder"); }
  await audit({ actor: actor(c), action: "app.update_folder", entity: "settings", entityId: "update", entityLabel: `Updates are looked for in ${updateFolder()}` });
  return c.json(await checkForUpdate());
});

appRoutes.post("/update/install", can("app.update"), mainComputerOnly, async (c) => {
  const { name } = z.object({ name: z.string().max(100) }).parse(await c.req.json());
  await audit({ actor: actor(c), action: "app.update", entity: "settings", entityId: "update", entityLabel: `Installing ${name} over ${appVersion()}` });
  try {
    return c.json(await installUpdate(name));
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "The update could not start", "update_failed");
  }
});

/** Back to the kept earlier version (offered only while it can open these books). */
appRoutes.post("/update/go-back", can("app.update"), mainComputerOnly, async (c) => {
  await audit({ actor: actor(c), action: "app.update", entity: "settings", entityId: "update", entityLabel: `Going back from ${appVersion()} to the kept earlier version` });
  try {
    return c.json(await goBack());
  } catch (e) {
    throw bad(e instanceof Error ? e.message : "The earlier version could not start", "update_failed");
  }
});
