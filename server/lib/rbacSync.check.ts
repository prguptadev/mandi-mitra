/* Run: npx tsx server/lib/rbacSync.check.ts — a throwaway database only.
   A permission added after a business was set up reaches the stock roles
   that should have it, never a custom role, and never comes back once the
   owner removed it. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
process.env.MANDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-rbac-"));
const { runMigrations } = await import("../db/migrate.ts");
const { db, schema } = await import("../db/client.ts");
const { syncNewPermissions } = await import("./rbacSync.ts");
const { eq } = await import("drizzle-orm");
runMigrations();

let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`); };
const perms = (roleId: string) => new Set(db.select({ p: schema.rolePermissions.permission }).from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId)).all().map((x) => x.p));

db.insert(schema.businesses).values({ id: "b1", name: "Test", shortCode: "T" }).run();
// a business set up before the new permissions existed
db.insert(schema.roles).values({ id: "mgr", businessId: "b1", key: "manager", label: "Manager", isSystem: true, rank: 20 }).run();
db.insert(schema.roles).values({ id: "op", businessId: "b1", key: "operator", label: "Operator", isSystem: true, rank: 40 }).run();
db.insert(schema.roles).values({ id: "cust", businessId: "b1", key: "custom", label: "Weighman", isSystem: false, rank: 60 }).run();
db.insert(schema.rolePermissions).values({ id: "p1", roleId: "mgr", permission: "slip.read" }).run();

const n = syncNewPermissions();
check("the manager gets the new mill-account and challan permissions", ["millledger.read", "millreceipt.write", "challan.write"].every((p) => perms("mgr").has(p)), [...perms("mgr")]);
check("…but not backups or updates (owner only)", !perms("mgr").has("backup.manage") && !perms("mgr").has("app.update"));
check("the operator gets none of them", !perms("op").has("millledger.read") && !perms("op").has("challan.write"), [...perms("op")]);
check("a custom role is never touched", perms("cust").size === 0);
check("older permissions are not handed out again", !perms("mgr").has("slip.write"));
check(`${n} grant(s) made`, n === 3, n);

db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.permission, "challan.write")).run();
check("a second start grants nothing new", syncNewPermissions() === 0);
check("…and a permission the owner took away stays away", !perms("mgr").has("challan.write"));

fs.rmSync(process.env.MANDI_DATA_DIR!, { recursive: true, force: true });
console.log(bad === 0 ? "\nPermission sync behaves." : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
