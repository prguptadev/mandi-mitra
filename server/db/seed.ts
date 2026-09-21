/* Demo data for the TEST databases only (the end-to-end tests load it).
   It adds staff logins whose PINs are in this public repository, so it
   refuses to run against the real data folder. */
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db, schema } from "./client.ts";
import { newId } from "../lib/ids.ts";
import { toHinglish, normKey } from "../lib/translit.ts";
import { defaultChargeConfig } from "../lib/charges.ts";
import { hashPin } from "../lib/auth.ts";

const dir = path.resolve(process.env.MANDI_DATA_DIR ?? "data");
if (dir === path.resolve("data") || !/test/i.test(dir)) {
  console.error("\n  REFUSING: the demo seed adds logins with published PINs. It only runs on a test data folder (npm run test:e2e).\n");
  process.exit(2);
}

const [biz] = await db.select().from(schema.businesses).limit(1);
if (!biz) {
  console.error("No business yet — complete signup in the app first, then re-run.");
  process.exit(1);
}
const [owner] = await db.select().from(schema.users).where(eq(schema.users.isRoot, true)).limit(1);

/* ------------------------------------------------------------------- mills */

const MILLS = [
  {
    code: "GRM", name: "G.R.M.", nameHi: "जी.आर.एम.", city: "Etah", state: "Uttar Pradesh",
    cfg: defaultChargeConfig(),
  },
  {
    code: "LB", name: "Shri Laxmi Badri Agro Foods Pvt Ltd", nameHi: "श्री लक्ष्मी बद्री एग्रो फूड्स",
    city: "Kiccha", state: "Uttarakhand",
    // the terms verified against invoice 196 dated 20-09-2026
    cfg: defaultChargeConfig(),
  },
];

for (const m of MILLS) {
  const [exists] = await db.select().from(schema.merchants)
    .where(and(eq(schema.merchants.businessId, biz.id), eq(schema.merchants.code, m.code))).limit(1);
  if (exists) continue;
  await db.insert(schema.merchants).values({
    id: newId(), businessId: biz.id, code: m.code, name: m.name, nameHi: m.nameHi,
    nameHinglish: toHinglish(m.nameHi), city: m.city, state: m.state,
    chargeConfig: JSON.stringify(m.cfg),
  });
}

/* --------------------------------------------------------------- suppliers */

/** Unique adati names read off the two sheets dated 20-09-2026. */
const ADATI = [
  "फूलसिंह वर्मा", "राकेश वर्मा", "पुष्पेन्द्र यादव", "वीरेन्द्र जोशी", "रामवीर नठमाची",
  "अरुण कुमार यादव", "अरविन्द ट्रेडिंग", "सहदेव सिंह ट्रेडिंग", "संत कुमार चतुर्भुज",
  "राधा राधा ट्रेडिंग", "दिनेश यादव", "कृष्णपाल जोशी", "शान्ति स्वरूप जोशी",
  "गौरव ट्रेडिंग", "श्री गणेश ट्रेडिंग", "शिवम इंटरप्राइजेज", "शिवम ट्रेडिंग",
  "राधे श्याम बघेल", "ज्योति ट्रेडर्स", "केशी राठोर", "मोहनी ट्रेडिंग",
  "रामलखन ट्रेडिंग", "ज्योति स्वरूप जोशी", "सामरा इंटरप्राइजेज", "अमित ट्रेडिंग",
  "राजू संजीव कुमार", "धर्मपाल सिंह", "रामपाल सिंह यादव", "सूर्य प्रकाश वर्मा",
  "राधा चरन ट्रेडिंग", "राधे श्याम एण्ड संस",
];

let added = 0;
for (const nameHi of ADATI) {
  const [exists] = await db.select().from(schema.adati)
    .where(and(eq(schema.adati.businessId, biz.id), eq(schema.adati.nameHi, nameHi))).limit(1);
  if (exists) continue;
  const id = newId();
  await db.insert(schema.adati).values({
    id, businessId: biz.id, nameHi, nameHinglish: toHinglish(nameHi), village: "Etah",
  });
  await db.insert(schema.adatiAliases).values({
    id: newId(), businessId: biz.id, adatiId: id, rawText: nameHi,
    normKey: normKey(nameHi), source: "canonical", createdBy: owner?.id ?? null,
  }).onConflictDoNothing();
  added++;
}

/* ------------------------------------------------- staff, for testing roles */

const STAFF = [
  { name: "Munshi Ji", nameHi: "मुन्शी जी", roleKey: "operator", pin: "271830" },
  { name: "Accounts", nameHi: "लेखा", roleKey: "accountant", pin: "394726" },
];

const created: string[] = [];
for (const s of STAFF) {
  const [exists] = await db.select().from(schema.users).where(eq(schema.users.name, s.name)).limit(1);
  if (exists) continue;
  const [role] = await db.select().from(schema.roles)
    .where(and(eq(schema.roles.businessId, biz.id), eq(schema.roles.key, s.roleKey))).limit(1);
  if (!role) continue;
  const { hash, salt } = hashPin(s.pin);
  const userId = newId();
  await db.insert(schema.users).values({
    id: userId, name: s.name, nameHi: s.nameHi, pinHash: hash, pinSalt: salt,
  });
  await db.insert(schema.memberships).values({
    id: newId(), userId, businessId: biz.id, roleId: role.id,
  });
  created.push(`${s.name.padEnd(12)} PIN ${s.pin}   ${role.label}`);
}

console.log(`\nSeeded into "${biz.name}"`);
console.log(`  mills      ${MILLS.length}`);
console.log(`  suppliers  ${added} added`);
if (created.length) {
  console.log(`  staff logins (dev only — change or delete before real use):`);
  for (const c of created) console.log(`    ${c}`);
}
console.log();
process.exit(0);
