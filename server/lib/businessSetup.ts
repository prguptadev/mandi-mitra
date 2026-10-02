import { db, schema } from "../db/client.ts";
import { newId } from "./ids.ts";
import { ROLE_PRESETS } from "./rbac.ts";
import { hashPin } from "./auth.ts";

/* What every new business starts with: the stock roles and the local commodities. */

export async function seedRoles(businessId: string) {
  const map: Record<string, string> = {};
  for (const preset of ROLE_PRESETS) {
    const roleId = newId();
    await db.insert(schema.roles).values({
      id: roleId, businessId, key: preset.key, label: preset.label,
      labelHi: preset.labelHi, isSystem: true, rank: preset.rank,
    });
    for (const p of preset.permissions) {
      await db.insert(schema.rolePermissions).values({ id: newId(), roleId, permission: p });
    }
    map[preset.key] = roleId;
  }
  return map;
}

/** Give a fresh business the commodities that actually move through Etah. */
export async function seedJins(businessId: string) {
  const rows = [
    { code: "1509", name: "Paddy 1509", nameHi: "धान 1509", crop: "paddy" },
    { code: "1121", name: "Paddy 1121", nameHi: "धान 1121", crop: "paddy" },
    { code: "1718", name: "Paddy 1718", nameHi: "धान 1718", crop: "paddy" },
    { code: "SARBATI", name: "Paddy Sarbati", nameHi: "धान सरबती", crop: "paddy" },
    { code: "WHEAT", name: "Wheat", nameHi: "गेहूँ", crop: "wheat" },
    { code: "MAIZE", name: "Maize", nameHi: "मक्का", crop: "maize" },
  ];
  for (const r of rows) {
    await db.insert(schema.jins).values({ id: newId(), businessId, ...r });
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
/**
 * Only for the very first sign-in: it is published, so the sign-in screen
 * then asks each person to choose their own (routes/auth.ts /first-pin), and
 * it is never accepted again as anyone's PIN (lib/auth.ts weakPin). From
 * another device on the network it is refused outright.
 */
export const FIRST_PIN = "7747";

/**
 * On a brand-new install (no users at all): both firms, the Admin and two
 * Managers, everyone on PIN 7747 until their first sign-in, with full access
 * in both firms. Only the Admin can add a further business. A computer that
 * then joins the office's cloud has all of this replaced by the cloud's data.
 */
export async function seedFirstRun() {
  if (process.env.MANDI_NO_SEED === "1") return false;
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
  if (u) return false;
  const users = FIRST_USERS.map((x) => ({ ...x, id: newId() }));
  for (const x of users) {
    const { hash, salt } = hashPin(FIRST_PIN);
    await db.insert(schema.users).values({ id: x.id, name: x.name, nameHi: x.nameHi, pinHash: hash, pinSalt: salt, isRoot: x.isRoot });
  }
  let first: string | null = null;
  for (const b of FIRST_BUSINESSES) {
    const businessId = newId();
    first ??= businessId;
    await db.insert(schema.businesses).values({ id: businessId, ...b });
    const roles = await seedRoles(businessId);
    await seedJins(businessId);
    // full access for now; the owner can narrow the Managers later from Users
    for (const x of users) await db.insert(schema.memberships).values({ id: newId(), userId: x.id, businessId, roleId: roles.owner });
  }
  // everyone starts in Vijay Laxmi Dal Mill; the switcher is one click away
  await db.update(schema.users).set({ prefs: JSON.stringify({ lastBusinessId: first }) });
  return true;
}
