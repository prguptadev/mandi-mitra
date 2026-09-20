/* Regression check against the real Vijay Laxmi -> Shri Laxmi Badri parcha
   dated 20-09-2026 (invoice 196, truck UP25CT5038). Run: npx tsx server/lib/charges.check.ts */
import { defaultChargeConfig, computeParcha, deriveKatauti } from "./charges.ts";
import { weightedAvgRate, qtlToGrams, rupeesToPaise, fmtINR, fmtQtl } from "./money.ts";

// The L.B daily list, exactly as written on the sheet.
const lbSheet = [
  ["630", 28.60, 29, 3450], ["634", 41.25, 41, 3550], ["635", 35.85, 36, 3400],
  ["633", 26.40, 26, 3521], ["636", 18.75, 19, 3400], ["639", 5.70, 6, 3611],
  ["643", 18.20, 18, 3300], ["648", 9.60, 10, 3200], ["651", 24.95, 25, 3400],
  ["652", 42.60, 43, 3450], ["653", 14.40, 14, 3100], ["662", 18.20, 18, 3450],
  ["666", 49.90, 50, 3350],
] as const;

/* KATAUTI is the gross weight rounded to the nearest quintal, with 1 kg
   deducted per unit — i.e. 1 kg per quintal. Confirmed on all 45 rows of the
   two sheets; it is NOT the bag count (the parcha's 800 katte is separate). */
const cfg0 = defaultChargeConfig();
const rows = lbSheet.map(([rst, gross, katautiOnSheet, rate]) => {
  const grossGrams = qtlToGrams(gross);
  const k = deriveKatauti(grossGrams, cfg0.katauti);
  if (k.units !== katautiOnSheet) {
    console.log(`  !! RST ${rst}: derived katauti ${k.units}, sheet says ${katautiOnSheet}`);
  }
  return { rst, grossGrams, katautiUnits: k.units, netGrams: grossGrams - k.deductionGrams, ratePaisePerQtl: rupeesToPaise(rate) };
});

const totalNet = rows.reduce((s, r) => s + r.netGrams, 0);
const avg = weightedAvgRate(rows);
console.log("STEP 1  daily list rolls up");
console.log("  total net weight :", fmtQtl(totalNet), "qtl      (sheet says 331.05)");
console.log("  weighted avg rate:", (avg / 100).toFixed(2), "        (parcha says 3413.45)");

const cfg = defaultChargeConfig();
const r = computeParcha(cfg, {
  grossGrams: qtlToGrams(315.30),
  bags: 800,
  bardanaGrams: qtlToGrams(4.56),
  netGrams: qtlToGrams(310.74),
  ratePaisePerQtl: rupeesToPaise(3413.45),
  trucks: 1,
  advancePaise: rupeesToPaise(10000),
  manualDaraPaise: rupeesToPaise(3597.38),
});

console.log("\nSTEP 2  parcha lines");
for (const l of r.lines) {
  const tag = l.kind === "total" ? "==" : l.kind === "subtotal" ? "--" : l.kind === "info" ? "  " : "  ";
  console.log(` ${tag} ${l.label.padEnd(22)} ${fmtINR(l.amountPaise).padStart(15)}  ${l.detail ?? ""}`);
}

const expect: [string, number, number][] = [
  ["goods value",  r.goodsAmountPaise, 106069545],
  ["kacchi adat",  r.adatPaise,          2121391],
  ["subtotal",     r.subtotalPaise,    108190936],
  ["total",        r.totalPaise,       111785122],
  ["grand total",  r.grandTotalPaise,  112785122],
  ["total net wt", totalNet,            33105000],
  ["avg rate",     avg,                   341345],
];
console.log("\nSTEP 3  against the paper");
let bad = 0;
for (const [name, got, want] of expect) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${name.padEnd(14)} got ${String(got).padStart(10)}  want ${String(want).padStart(10)}`);
}
console.log(bad === 0 ? "\nAll 7 figures match the paper parcha exactly." : `\n${bad} MISMATCH`);
process.exit(bad === 0 ? 0 : 1);
