import "./_guard.ts";
/* Rebuilds a usable dev database from nothing: owner signup, then the seed.
 * Usage: rm -f data/mandi.db* && npm run db:push && npx tsx scripts/dev-bootstrap.ts
 */
const BASE = process.env.MANDI_API!;
const PIN = process.env.MANDI_PIN ?? "482915";

const res = await fetch(`${BASE}/auth/bootstrap`).then((r) => r.json());
if (!res.needsSignup) { console.log("Already set up — nothing to do."); process.exit(0); }

const r = await fetch(`${BASE}/auth/signup`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "Test Owner", nameHi: "टेस्ट स्वामी",
    pin: PIN, businessName: "Vijay Laxmi Dal Mill",
    businessNameHi: "विजय लक्ष्मी दाल मिल", shortCode: "VLDM",
  }),
});
if (!r.ok) { console.error(await r.text()); process.exit(1); }
console.log(`Owner created — "Test Owner", PIN ${PIN}`);
