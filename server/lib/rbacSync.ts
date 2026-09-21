import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { newId, nowSec } from "./ids.ts";
import { ALL_PERMISSIONS, presetPermissions } from "./rbac.ts";

/* Roles are rows, seeded when a business is created. A permission added to
   the app later would otherwise reach no one — not even the stock roles
   that should have it. At start-up, every permission the app did not know
   about last time is granted to the stock roles whose preset includes it.
   A permission the owner removed on purpose earlier is never put back: only
   permissions new since the last start are granted. */

/** The permissions that existed before this sync was introduced (21-09-2026). */
const INTRODUCED_WITH_SYNC = ["challan.write", "millledger.read", "millreceipt.write", "backup.manage", "app.update"];

export function syncNewPermissions() {
  const businesses = db.select({ id: schema.businesses.id }).from(schema.businesses).all();
  let granted = 0;
  for (const b of businesses) {
    const [row] = db.select().from(schema.settings)
      .where(and(eq(schema.settings.businessId, b.id), eq(schema.settings.key, "rbac.known"))).limit(1).all();
    const known = new Set<string>(row?.value ? JSON.parse(row.value) : ALL_PERMISSIONS.filter((p) => !INTRODUCED_WITH_SYNC.includes(p)));
    const fresh = ALL_PERMISSIONS.filter((p) => !known.has(p));
    if (fresh.length) {
      const roles = db.select().from(schema.roles).where(and(eq(schema.roles.businessId, b.id), eq(schema.roles.isSystem, true))).all();
      for (const r of roles) {
        const has = new Set(db.select({ p: schema.rolePermissions.permission }).from(schema.rolePermissions)
          .where(eq(schema.rolePermissions.roleId, r.id)).all().map((x) => x.p));
        for (const p of fresh) {
          if (presetPermissions(r.key).includes(p) && !has.has(p)) {
            db.insert(schema.rolePermissions).values({ id: newId(), roleId: r.id, permission: p }).run();
            granted++;
          }
        }
      }
    }
    const value = JSON.stringify(ALL_PERMISSIONS);
    if (row) db.update(schema.settings).set({ value, updatedAt: nowSec() }).where(eq(schema.settings.id, row.id)).run();
    else db.insert(schema.settings).values({ id: newId(), businessId: b.id, key: "rbac.known", value }).run();
  }
  return granted;
}
