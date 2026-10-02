import { db, schema, sqlite } from "../db/client.ts";
import { newId } from "./ids.ts";
import { ROLE_PRESETS } from "./rbac.ts";
import { hashPin } from "./auth.ts";

/* What every new business starts with: the stock roles and the local commodities.
   Callers put these in one transaction with the business itself (sqlite.transaction):
   every commit is a flush to the disk (synchronous = FULL), so hundreds of rows
   committed one by one would take seconds on a shop PC's hard disk. */

export function seedRoles(businessId: string) {
  const map: Record<string, string> = {};
  for (const preset of ROLE_PRESETS) {
    const roleId = newId();
    db.insert(schema.roles).values({
      id: roleId, businessId, key: preset.key, label: preset.label,
      labelHi: preset.labelHi, isSystem: true, rank: preset.rank,
    }).run();
    for (const p of preset.permissions) {
      db.insert(schema.rolePermissions).values({ id: newId(), roleId, permission: p }).run();
    }
    map[preset.key] = roleId;
  }
  return map;
}

/** Give a fresh business the commodities that actually move through Etah. */
export function seedJins(businessId: string) {
  const rows = [
    { code: "1509", name: "Paddy 1509", nameHi: "धान 1509", crop: "paddy" },
    { code: "1121", name: "Paddy 1121", nameHi: "धान 1121", crop: "paddy" },
    { code: "1718", name: "Paddy 1718", nameHi: "धान 1718", crop: "paddy" },
    { code: "SARBATI", name: "Paddy Sarbati", nameHi: "धान सरबती", crop: "paddy" },
    { code: "WHEAT", name: "Wheat", nameHi: "गेहूँ", crop: "wheat" },
    { code: "MAIZE", name: "Maize", nameHi: "मक्का", crop: "maize" },
  ];
  for (const r of rows) {
    db.insert(schema.jins).values({ id: newId(), businessId, ...r }).run();
  }
}

/** The office's own set-up, so a new install signs in straight away. */
const FIRST_BUSINESSES = [
  { name: "Vijay Laxmi Dal Mill", nameHi: "विजय लक्ष्मी दाल मिल", shortCode: "VLDM" },
  { name: "V C Enterprises", nameHi: "वी सी एंटरप्राइजेज", shortCode: "VCE" },
];
const FIRST_USERS = [
  { name: "Admin", nameHi: "एडमिन", isRoot: true },
  { name: "Manager 1", nameHi: "मैनेजर 1", isRoot: false },
  { name: "Manager 2", nameHi: "मैनेजर 2", isRoot: false },
];
/** Everyone's PIN on a new install, until the owner changes it (Change PIN, or Users). */
export const FIRST_PIN = "7747";

/**
 * On a brand-new install (no users at all): both firms, the Admin and two
 * Managers, everyone on PIN 7747 with full access
 * in both firms. Only the Admin can add a further business. A computer that
 * then joins the office's cloud has all of this replaced by the cloud's data.
 * All of it is one transaction: one flush to the disk, and never half a set-up.
 */
export async function seedFirstRun() {
  if (process.env.MANDI_NO_SEED === "1") return false;
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (u) return false;
  // the PINs are hashed first (deliberately slow), so the transaction holds the books only for the writes
  const users = FIRST_USERS.map((x) => {
    const { hash, salt } = hashPin(FIRST_PIN);
    return { ...x, id: newId(), pinHash: hash, pinSalt: salt };
  });
  sqlite.transaction(() => {
    for (const x of users) {
      db.insert(schema.users).values({ id: x.id, name: x.name, nameHi: x.nameHi, pinHash: x.pinHash, pinSalt: x.pinSalt, isRoot: x.isRoot }).run();
    }
    let first: string | null = null;
    for (const b of FIRST_BUSINESSES) {
      const businessId = newId();
      first ??= businessId;
      db.insert(schema.businesses).values({ id: businessId, ...b }).run();
      const roles = seedRoles(businessId);
      seedJins(businessId);
      // full access for now; the owner can narrow the Managers later from Users
      for (const x of users) db.insert(schema.memberships).values({ id: newId(), userId: x.id, businessId, roleId: roles.owner }).run();
    }
    // everyone starts in Vijay Laxmi Dal Mill; the switcher is one click away
    db.update(schema.users).set({ prefs: JSON.stringify({ lastBusinessId: first }) }).run();
  })();
  return true;
}
