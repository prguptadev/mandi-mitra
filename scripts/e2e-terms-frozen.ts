import "./_guard.ts";
import ExcelJS from "exceljs";
import { screenLines } from "../server/lib/parchaLabels.ts";
import { repairTrucks, repairTrucksAfterPull, APPROVED_TWICE } from "../server/lib/repairTrucks.ts";
import { termsOfTruck } from "../server/lib/parcha.ts";
import { sqlite } from "../server/db/client.ts";
import { newId } from "../server/lib/ids.ts";
/* End-to-end: a change of terms never reaches back. On the test database only.
 *
 * The owner registers a mill with its terms (commission 1.2 %, kacchi adat,
 * labour on katte and on bore, sutli, gaushala, mandi tax, gate pass, extra
 * rows, bardana a bag, katauti, dara), works a month on them — slips, trucks,
 * parchas, a weight cut, money from the mill — and then changes every one of
 * them (commission 2 %...). Every past parcha, amount and balance must read
 * exactly as before, to the paisa and the gram; only what is made after takes
 * the new terms. The same for the supplier charges (commission %, gaushala a
 * quintal) and for the mill's katauti on slips — a slip's weight corrected
 * later is worked on its own katauti too. Slips from before v0.3 that carry
 * no terms keep their stored figures. A truck approved on two computers keeps
 * the terms of the parcha the mill was billed on; a mill registered with the
 * wrong terms can be re-billed on its corrected ones, by an explicit tick.
 *
 * Every expected figure is worked out here, in BigInt, from the inputs and
 * the terms in force — never with the app's own code.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let cookie = "";
async function raw(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
async function call(method: string, path: string, body?: unknown) {
  const res = await raw(method, path, body);
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};
/** What the app does in a case the owner asked about, said plainly with its numbers. */
const note = (text: string) => console.log(` NOTE  ${text}`);

/* ------------------------------------------------ money, worked here in BigInt */
const B = BigInt;
function halfUp(a: bigint, b: bigint): bigint {
  const neg = (a < 0n) !== (b < 0n);
  const x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  const r = (2n * x + y) / (2n * y);
  return neg ? -r : r;
}
/** grams × paise a quintal */
const goodsOf = (g: number, rate: number) => Number(halfUp(B(g) * B(rate), 100_000n));
/** pct % of paise; the terms are kept to 4 decimals */
const pctOf = (paise: number, pct: number) => Number(halfUp(B(paise) * B(Math.round(pct * 10_000)), 1_000_000n));
/** ₹ a unit × units (units given × scale) */
const perUnit = (units: number, scale: number, rupees: number) => Number(halfUp(B(units) * B(Math.round(rupees * 10_000)), B(scale) * 100n));
/** bags × kg a bag, to the whole kg, in grams */
const bardana = (bags: number, kg: number) => Number(halfUp(B(bags) * B(Math.round(kg * 1000)), 1000n)) * 1000;
const kg = (x: number) => x * 1000;
const rs = (x: number) => Math.round(x * 100);
const qt = (g: number) => (g / 100_000).toFixed(2);
const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The first place two readings differ, for a FAIL line that says where. */
function firstDiff(a: unknown, b: unknown, at = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at || "."}: was ${JSON.stringify(a)?.slice(0, 160)} now ${JSON.stringify(b)?.slice(0, 160)}`;
}
function same(label: string, was: unknown, now: unknown) {
  const d = firstDiff(was, now);
  check(label, d === null, d ?? undefined);
}

/* ------------------------------------------------------------ sign in */
const users = await call("GET", "/auth/users");
const owner = users.find((u: any) => u.name === "Test Owner");
await call("POST", "/auth/login", { userId: owner.id, pin: process.env.MANDI_PIN ?? "482915" });
const me = await call("GET", "/auth/me");
const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
if (vldm && me.activeBusinessId !== vldm.businessId) await call("POST", "/auth/switch-business", { businessId: vldm.businessId });

const jinsAll = await call("GET", "/jins");
const J1 = jinsAll[0];
const J2 = jinsAll.find((j: any) => j.id !== J1.id);
const supplierChargesAtStart = await call("GET", "/settings/supplier-charges");

/* -------------------------------------------------------------- terms */
/** What the owner registers the mill with: every kind of charge the app has. */
const T1 = {
  katauti: { mode: "per_quintal_rounded", kgPerUnit: 1, rounding: "half_up" },
  millBardanaKgPerBag: 0.57, millBoreBardanaKgPerBag: 1,
  adat: { enabled: true, pct: 2, label: "Kacchi Adat" },
  labour1: { enabled: true, perBagRupees: 9.5, appliesTo: "katte", label: "Labour" },
  labour2: { enabled: true, perBagRupees: 15.5, appliesTo: "bore", label: "Labour" },
  sutli: { enabled: true, perBagRupees: 1, appliesTo: "all", label: "Sutli" },
  gaushala: { enabled: true, perQtlRupees: 1.25, base: "gross", label: "Gaushala" },
  mandiTax: { enabled: true, pct: 1.5, base: "amount_plus_adat", label: "Mandi Tax" },
  commission: { enabled: true, pct: 1.2, base: "amount_plus_adat", label: "Commission" },
  gatePass: { enabled: true, perTruckRupees: 100, label: "Gate Pass" },
  extraCharges: [
    { key: "bharai", label: "Bharai", kind: "per_bag", value: 2.25, sign: "add" },
    { key: "kanta", label: "Kanta", kind: "per_qtl", value: 0.35, weightBase: "net", sign: "add" },
    { key: "chowki", label: "Chowki", kind: "per_truck", value: 20, sign: "add" },
    { key: "cess", label: "Cess", kind: "pct", value: 0.2, base: "total_before_charge", sign: "add" },
    { key: "discount", label: "Discount", kind: "flat", value: 51, sign: "subtract" },
  ],
  dara: { mode: "per_qtl", value: 3, weightBase: "net", includeInGrandTotal: true, label: "Dara", labelHi: "दारा" },
  advance: { treatment: "add", label: "Advance" },
  grandTotalRounding: "nearest_rupee",
  paymentTermsDays: 15,
};
/** A month later: every term changed. */
const T2 = {
  ...T1,
  katauti: { mode: "per_quintal_rounded", kgPerUnit: 1.5, rounding: "half_up" },
  millBardanaKgPerBag: 0.6, millBoreBardanaKgPerBag: 1.1,
  adat: { enabled: true, pct: 2.5, label: "Kacchi Adat" },
  labour1: { enabled: true, perBagRupees: 10, appliesTo: "katte", label: "Labour" },
  labour2: { enabled: true, perBagRupees: 16.25, appliesTo: "bore", label: "Labour" },
  sutli: { enabled: true, perBagRupees: 1.5, appliesTo: "katte", label: "Sutli" },
  gaushala: { enabled: true, perQtlRupees: 1.5, base: "net", label: "Gaushala" },
  mandiTax: { enabled: true, pct: 1, base: "amount", label: "Mandi Tax" },
  commission: { enabled: true, pct: 2, base: "amount_plus_adat", label: "Commission" },
  gatePass: { enabled: true, perTruckRupees: 150, label: "Gate Pass" },
  extraCharges: [
    { key: "bharai", label: "Bharai", kind: "per_bag", value: 2.5, sign: "add" },
    { key: "kanta", label: "Kanta", kind: "per_qtl", value: 0.4, weightBase: "gross", sign: "add" },
    { key: "chowki", label: "Chowki", kind: "per_truck", value: 25, sign: "add" },
    { key: "cess", label: "Cess", kind: "pct", value: 0.25, base: "total_before_charge", sign: "add" },
    { key: "discount", label: "Discount", kind: "flat", value: 75, sign: "subtract" },
    { key: "tulai", label: "Tulai", kind: "per_bag", value: 0.75, sign: "add" },
  ],
  dara: { mode: "manual", value: 0, weightBase: "net", includeInGrandTotal: false, label: "Dara", labelHi: "दारा" },
  advance: { treatment: "subtract", label: "Advance" },
  grandTotalRounding: "nearest_ten",
  paymentTermsDays: 30,
};
type Terms = typeof T1;
const S1 = { commissionPct: 1.1, gaushalaPerQtl: 1.3 };
const S2 = { commissionPct: 2.25, gaushalaPerQtl: 2 };

/* The kaccha parcha of one truck, from its inputs and the mill's terms. */
interface TruckSpec {
  grossGrams: number; katte: number; bore: number; advancePaise: number; daraPaise: number;
  /** Bardana the operator typed, in grams; null = bags × the terms' kg a bag. */
  katteBardanaGrams?: number | null; boreBardanaGrams?: number | null;
  rows: { grams: number | null; rate: number }[];
}
function parchaBy(cfg: Terms, t: TruckSpec) {
  const katteBardanaGrams = t.katteBardanaGrams ?? bardana(t.katte, cfg.millBardanaKgPerBag);
  const boreBardanaGrams = t.boreBardanaGrams ?? bardana(t.bore, cfg.millBoreBardanaKgPerBag);
  const netGrams = t.grossGrams - katteBardanaGrams - boreBardanaGrams;
  const typed = t.rows.reduce((s, r) => s + (r.grams ?? 0), 0);
  const rows = t.rows.map((r) => {
    const g = r.grams ?? netGrams - typed;
    return { netGrams: g, ratePaisePerQtl: r.rate, amountPaise: goodsOf(g, r.rate) };
  });
  const goods = rows.reduce((s, r) => s + r.amountPaise, 0);
  const lines: [string, number][] = [["goods", goods]];
  const adat = cfg.adat.enabled ? pctOf(goods, cfg.adat.pct) : 0;
  if (cfg.adat.enabled) lines.push(["adat", adat]);
  const sub = goods + adat;
  lines.push(["subtotal", sub]);
  let charges = 0;
  const add = (key: string, amt: number, sign = "add") => { lines.push([key, amt]); charges += sign === "subtract" ? -amt : amt; };
  const bags = t.katte + t.bore;
  const bagsOf = (k: string) => (k === "katte" ? t.katte : k === "bore" ? t.bore : bags);
  const weightOf = (b: string) => (b === "gross" ? t.grossGrams : netGrams);
  const baseOf = (b: string) => (b === "amount" ? goods : b === "amount_plus_adat" ? sub : sub + charges);
  for (const k of ["labour1", "labour2", "sutli"] as const) {
    const c = cfg[k];
    if (c.enabled && bagsOf(c.appliesTo) > 0) add(k, perUnit(bagsOf(c.appliesTo), 1, c.perBagRupees));
  }
  if (cfg.gaushala.enabled) add("gaushala", perUnit(weightOf(cfg.gaushala.base), 100_000, cfg.gaushala.perQtlRupees));
  if (cfg.mandiTax.enabled) add("mandiTax", pctOf(baseOf(cfg.mandiTax.base), cfg.mandiTax.pct));
  if (cfg.commission.enabled) add("commission", pctOf(baseOf(cfg.commission.base), cfg.commission.pct));
  if (cfg.gatePass.enabled) add("gatePass", perUnit(1, 1, cfg.gatePass.perTruckRupees));
  for (const x of cfg.extraCharges as any[]) {
    const amt = x.kind === "per_bag" ? perUnit(bags, 1, x.value)
      : x.kind === "per_qtl" ? perUnit(weightOf(x.weightBase ?? "net"), 100_000, x.value)
      : x.kind === "per_truck" ? perUnit(1, 1, x.value)
      : x.kind === "pct" ? pctOf(baseOf(x.base ?? "amount_plus_adat"), x.value)
      : perUnit(1, 1, x.value);
    add(`extra:${x.key}`, amt, x.sign);
  }
  const total = sub + charges;
  lines.push(["total", total]);
  const d = cfg.dara as { mode: string; value: number; weightBase: string; includeInGrandTotal: boolean };
  const dara = d.mode === "per_bag" ? perUnit(bags, 1, d.value) : d.mode === "per_qtl" ? perUnit(weightOf(d.weightBase), 100_000, d.value)
    : d.mode === "pct" ? pctOf(total, d.value) : d.mode === "manual" ? t.daraPaise : 0;
  if (d.mode !== "none") lines.push(["dara", dara]);
  const adv = cfg.advance.treatment as string;
  if (adv !== "exclude" && t.advancePaise !== 0) lines.push(["advance", t.advancePaise]);
  let grand = total + (adv === "add" ? t.advancePaise : adv === "subtract" ? -t.advancePaise : 0) + (d.includeInGrandTotal ? dara : 0);
  if (cfg.grandTotalRounding === "nearest_rupee") grand = Number(halfUp(B(grand), 100n)) * 100;
  else if (cfg.grandTotalRounding === "nearest_ten") grand = Number(halfUp(B(grand), 1000n)) * 1000;
  lines.push(["grand", grand]);
  return {
    weights: { grossGrams: t.grossGrams, bardanaGrams: katteBardanaGrams + boreBardanaGrams, netGrams, katte: t.katte, bore: t.bore, katteBardanaGrams, boreBardanaGrams },
    rows, goods, lines, total, dara, grand,
  };
}
type Expected = ReturnType<typeof parchaBy>;
/** The frozen paper against the figures worked out here: weights, every row, every line, the grand total. */
function checkPaper(label: string, doc: any, e: Expected) {
  const rows = doc.lines.map((l: any) => ({ netGrams: l.netGrams, ratePaisePerQtl: l.ratePaisePerQtl, amountPaise: l.amountPaise }));
  const lines = doc.result.lines.map((l: any) => [l.key, l.amountPaise]);
  const ok = JSON.stringify(doc.weights) === JSON.stringify(e.weights) && JSON.stringify(rows) === JSON.stringify(e.rows)
    && JSON.stringify(lines) === JSON.stringify(e.lines) && doc.result.grandTotalPaise === e.grand;
  check(`${label}: net ${qt(e.weights.netGrams)} qtl, goods ${inr(e.goods)}, ${e.lines.length} lines, grand total ${inr(e.grand)} — each to the paisa`, ok,
    ok ? undefined : firstDiff({ weights: e.weights, rows: e.rows, lines: e.lines }, { weights: doc.weights, rows, lines }));
}
const lineOf = (e: Expected, key: string) => e.lines.find(([k]) => k === key)?.[1] ?? 0;

/* ------------------------------------------------------ the mill and people */
const stamp = Date.now().toString(36).slice(-4).toUpperCase();
const millBody = (code: string, name: string, cfg: unknown) => ({ code, name, nameHi: name, city: "Etah", state: "Uttar Pradesh", chargeConfig: cfg });
const TRM = (await call("POST", "/merchants", millBody(`TRM${stamp}`.slice(0, 12), `Terms Check Mill ${stamp}`, T1))).id as string;
// another mill with its own katauti, for moving slips to
const OTHER_K = { ...T1, katauti: { mode: "per_quintal_rounded", kgPerUnit: 0.5, rounding: "half_up" } };
const TRM2 = (await call("POST", "/merchants", millBody(`TRX${stamp}`.slice(0, 12), `Terms Other Mill ${stamp}`, OTHER_K))).id as string;
const sup: string[] = [];
for (const n of ["एक", "दो", "तीन"]) sup.push((await call("POST", "/adati", { nameHi: `शर्त परख ${n} ${stamp}` })).id);
await call("PUT", "/settings/supplier-charges", { ...supplierChargesAtStart, ...S1 });
check("a new mill is registered with every kind of term, commission 1.2 %", (await call("GET", `/merchants/${TRM}`)).chargeConfig.commission.pct === 1.2);

/* --------------------------------------------------------------- slips */
interface SlipRec {
  id: string; date: string; rst: string; adatiId: string; jinsId: string; merchantId: string;
  grossGrams: number; rate: number; katKg: number; sup: typeof S1;
}
const slips: SlipRec[] = [];
/** One slip, worked out here: katauti = gross rounded to whole quintals × kg a quintal. */
function slipBy(s: { grossGrams: number; rate: number; katKg: number; sup: typeof S1 }) {
  const units = Number(halfUp(B(s.grossGrams), 100_000n));
  const netGrams = s.grossGrams - Math.round(units * s.katKg * 1000);
  const amountPaise = goodsOf(netGrams, s.rate);
  const commissionPaise = s.rate > 0 ? pctOf(amountPaise, s.sup.commissionPct) : 0;
  const gaushalaPaise = s.rate > 0 ? perUnit(netGrams, 100_000, s.sup.gaushalaPerQtl) : 0;
  return { katautiUnits: units, netGrams, amountPaise, commissionPaise, gaushalaPaise, payablePaise: amountPaise + commissionPaise + gaushalaPaise };
}
const pick = (x: any) => ({ katautiUnits: x.katautiUnits, netGrams: x.netGrams, amountPaise: x.amountPaise, commissionPaise: x.commissionPaise, gaushalaPaise: x.gaushalaPaise, payablePaise: x.payablePaise });
let rstNo = 7000;
let slipOk = 0;
async function addSlip(date: string, adatiId: string, jinsId: string, grossGrams: number, rate: number, katKg: number, terms: typeof S1, merchantId = TRM) {
  const rst = String(++rstNo);
  const r = await call("POST", "/slips", { slipDate: date, rstNo: rst, adatiId, jinsId, merchantId, grossGrams, ratePaisePerQtl: rate });
  const rec = { id: r.id, date, rst, adatiId, jinsId, merchantId, grossGrams, rate, katKg, sup: terms };
  slips.push(rec);
  if (JSON.stringify(pick(r)) === JSON.stringify(slipBy(rec))) slipOk++;
  else check(`slip RST ${rst} on ${date}`, false, { app: pick(r), here: slipBy(rec) });
  return rec;
}
const day = (n: number) => `2026-07-${String(n).padStart(2, "0")}`;
for (let d = 1; d <= 30; d++) {
  for (let k = 0; k < 2; k++) {
    const gross = kg(2000 + ((d * 37 + k * 53) % 3000)) + (d % 4 === 0 ? 450 : 0); // 20–50 qtl, some to 10 g
    const rate = 330_000 + ((d * 13 + k * 29) % 400) * 100 + (d % 3) * 45;
    await addSlip(day(d), sup[(d + k) % 3], J1.id, gross, rate, 1, S1);
  }
  if (d === 10 || d === 20) for (let k = 0; k < 2; k++) await addSlip(day(d), sup[k], J2.id, kg(1800 + d * 11 + k * 7), 410_000 + k * 1_550 + d * 5, 1, S1);
}
check(`${slips.length} slips over 01–30 July: katauti, net, amount, commission ${S1.commissionPct} %, gaushala ₹${S1.gaushalaPerQtl}/qtl — each as worked here`, slipOk === slips.length, { ok: slipOk, of: slips.length });

/* Two slips as books from before v0.3 hold them: one with no mill and no
   katauti terms of its own (migration 0014 gave terms only to slips with a
   mill), one with no supplier terms. Made here and their terms taken off, as
   such a slip looks. Their own supplier, so the ledger checks below stay exact. */
const displayAtStart = await call("GET", "/settings/display");
const oldSup = (await call("POST", "/adati", { nameHi: `शर्त परख पुराना ${stamp}` })).id as string;
const L1 = { grossGrams: kg(2575) + 30, rate: 344_000, katKg: displayAtStart.katautiKgPerUnit as number, sup: S1 };
const L2 = { grossGrams: kg(2710), rate: 336_500, katKg: 1, sup: S1 };
const L1id = (await call("POST", "/slips", { slipDate: day(3), rstNo: "9001", adatiId: oldSup, jinsId: J1.id, merchantId: null, grossGrams: L1.grossGrams, ratePaisePerQtl: L1.rate })).id as string;
const L2id = (await call("POST", "/slips", { slipDate: day(3), rstNo: "9002", adatiId: oldSup, jinsId: J1.id, merchantId: TRM, grossGrams: L2.grossGrams, ratePaisePerQtl: L2.rate })).id as string;
sqlite.prepare("update purchase_slips set katauti_terms = null where id = ?").run(L1id);
sqlite.prepare("update purchase_slips set supplier_terms = null where id = ?").run(L2id);
const legacyAsMade = { L1: slipBy(L1), L2: slipBy(L2) };
check(`two slips as before v0.3: RST 9001 with no mill and no katauti terms (net ${qt(legacyAsMade.L1.netGrams)}), RST 9002 with no supplier terms (payable ${inr(legacyAsMade.L2.payablePaise)})`,
  JSON.stringify(pick((await call("GET", `/slips?date=${day(3)}`)).rows.find((r: any) => r.id === L1id))) === JSON.stringify(legacyAsMade.L1));

/** A purchase day's average rate for the mill: Σ net × rate ÷ Σ net, half up. */
function dayAvg(merchantId: string, jinsId: string, date: string) {
  let net = 0n, value = 0n;
  for (const s of slips.filter((x) => x.merchantId === merchantId && x.jinsId === jinsId && x.date === date && x.rate > 0)) {
    const n = B(slipBy(s).netGrams);
    net += n; value += n * B(s.rate);
  }
  return net ? Number(halfUp(value, net)) : 0;
}

/* -------------------------------------------------------------- trucks */
interface TruckRec { id: string; no: string | null; pid?: string; spec: TruckSpec; rowsIn: { date: string; jinsId: string; grams: number | null; rate: number | null }[] }
let truckN = 0;
async function makeTruck(loadDate: string, rows: TruckRec["rowsIn"], w: { gross: number; katte: number; bore: number; advance: number; dara: number; no: string | null; katteBardana?: number }): Promise<TruckRec> {
  const t = await call("POST", "/loads", { loadDate, merchantId: TRM, jinsId: rows[0].jinsId, stockDate: rows[0].date, truckNo: `UP80TC${String(++truckN).padStart(4, "0")}` });
  const st = await call("GET", `/loads/${t.id}`);
  if (rows[0].grams != null || rows[0].rate != null) await call("PUT", `/loads/${t.id}/lines/${st.lines[0].id}`, { netGrams: rows[0].grams, ratePaisePerQtl: rows[0].rate });
  for (const r of rows.slice(1)) await call("POST", `/loads/${t.id}/lines`, { stockDate: r.date, jinsId: r.jinsId, netGrams: r.grams, ratePaisePerQtl: r.rate });
  await call("PUT", `/loads/${t.id}`, { millGrossGrams: w.gross, katteCount: w.katte, boreCount: w.bore, advancePaise: w.advance, daraPaise: w.dara, invoiceNo: w.no, katteBardanaGrams: w.katteBardana ?? null });
  return {
    id: t.id, no: w.no, rowsIn: rows,
    spec: { grossGrams: w.gross, katte: w.katte, bore: w.bore, advancePaise: w.advance, daraPaise: w.dara, katteBardanaGrams: w.katteBardana ?? null, rows: [] },
  };
}
/** The truck's rows as the parcha prices them: a typed rate, else the purchase day's average. */
const specOf = (t: TruckRec): TruckSpec => ({ ...t.spec, rows: t.rowsIn.map((r) => ({ grams: r.grams, rate: r.rate ?? dayAvg(TRM, r.jinsId, r.date) })) });
async function approve(t: TruckRec) {
  const r = await call("POST", `/loads/${t.id}/approve`, {});
  t.pid = r.id;
  return r;
}

console.log("\nJuly, on the terms the mill was registered with");
const A1 = await makeTruck(day(4), [{ date: day(2), jinsId: J1.id, grams: null, rate: null }], { gross: kg(4037), katte: 105, bore: 0, advance: rs(5000), dara: 0, no: "7601" });
// two commodities on one truck, and both kinds of bag
const A2 = await makeTruck(day(12), [{ date: day(10), jinsId: J1.id, grams: kg(3500), rate: null }, { date: day(10), jinsId: J2.id, grams: null, rate: null }],
  { gross: kg(7215), katte: 110, bore: 15, advance: 0, dara: 0, no: "7602" });
// a typed rate on one row; only jute bags
const A3 = await makeTruck(day(18), [{ date: day(15), jinsId: J1.id, grams: kg(2550), rate: 350_000 }, { date: day(16), jinsId: J1.id, grams: null, rate: null }],
  { gross: kg(5583), katte: 0, bore: 60, advance: rs(2500), dara: 0, no: "7603" });
const A4 = await makeTruck(day(24), [{ date: day(22), jinsId: J1.id, grams: null, rate: null }], { gross: kg(4888), katte: 85, bore: 0, advance: 0, dara: 0, no: "7604" });
const A5 = await makeTruck(day(26), [{ date: day(25), jinsId: J1.id, grams: null, rate: null }], { gross: kg(4111), katte: 70, bore: 5, advance: rs(1000), dara: 0, no: "7605" });
const A6 = await makeTruck(day(27), [{ date: day(26), jinsId: J1.id, grams: null, rate: null }], { gross: kg(3999), katte: 66, bore: 0, advance: 0, dara: 0, no: "7606" });
const OLD = [A1, A2, A3, A4, A5, A6];
for (const t of OLD) await approve(t);
const expT1 = new Map(OLD.map((t) => [t.id, parchaBy(T1, specOf(t))]));
for (const t of OLD) checkPaper(`parcha ${t.no} on the July terms`, (await call("GET", `/parchas/${t.pid}`)).doc, expT1.get(t.id)!);
const e1 = expT1.get(A1.id)!;
check(`parcha 7601: commission 1.2 % of amount + adat = ${inr(lineOf(e1, "commission"))}`, lineOf(e1, "commission") === pctOf(e1.goods + lineOf(e1, "adat"), 1.2));
// the mill cut 1.25 qtl off truck 7603 on arrival
await call("PUT", `/challan/${A3.id}`, { deductionGrams: kg(125), note: "moisture" });
// money from the mill: against 7601, and on account with TDS held back
await call("POST", "/mill-receipts", { merchantId: TRM, receiptDate: day(20), amountPaise: rs(20000), mode: "rtgs", loadId: A1.id });
await call("POST", "/mill-receipts", { merchantId: TRM, receiptDate: day(25), amountPaise: rs(50000), deductionPaise: rs(100), deductionNote: "TDS", mode: "cheque" });
/* Two trucks still drafts when the terms change. Their bardana is typed (43 and
   34 kg, as the July 0.57 kg a bag gives it), so their stored net — which stock
   reads — rests on nothing the change touches; how a draft with the bardana
   left to the terms moves is shown on its own below. */
const D1 = await makeTruck(day(29), [{ date: day(28), jinsId: J1.id, grams: null, rate: null }], { gross: kg(4444), katte: 75, bore: 0, advance: 0, dara: 0, no: "7607", katteBardana: kg(43) });
const D2 = await makeTruck(day(30), [{ date: day(29), jinsId: J1.id, grams: null, rate: null }], { gross: kg(3535), katte: 60, bore: 0, advance: 0, dara: 0, no: null, katteBardana: kg(34) });
const d1Draft = await call("GET", `/loads/${D1.id}`);
check("draft 7607 shows its parcha on the July terms while the terms are July's", d1Draft.doc?.result.grandTotalPaise === parchaBy(T1, specOf(D1)).grand, d1Draft.doc?.result.grandTotalPaise);
check("the typed bardana of the drafts is what the July terms give (75 × 0.57 = 43 kg, 60 × 0.57 = 34 kg)", bardana(75, 0.57) === kg(43) && bardana(60, 0.57) === kg(34));

/* ------------------------------------------------- everything the past shows */
async function xlsxCells(path: string) {
  const res = await raw("GET", path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
  const out: [string, unknown][] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => out.push([`${ws.name}!${c.address}`, c.value]))));
  return out;
}
/** The truck screen of a billed truck: its stored figures, rows, the paper and what it says about it. */
function truckScreen(st: any) {
  return {
    load: st.load, config: st.config, weighment: st.weighment, blockers: st.blockers, doc: st.doc, approved: st.approved, stale: st.stale, history: st.history,
    rows: st.lines.map((x: any) => ({ id: x.id, jinsCode: x.jinsCode, stockDate: x.stockDate, weightGrams: x.weightGrams, rate: x.ratePaisePerQtlUsed, amountPaise: x.amountPaise, dayAvg: x.dayAvgRatePaisePerQtl })),
  };
}
const today = new Date().toLocaleDateString("en-CA");
async function millView(trucks: TruckRec[]) {
  const v: Record<string, unknown> = {};
  for (const t of trucks) {
    const p = await call("GET", `/parchas/${t.pid}`);
    v[`parcha ${t.no}`] = p;
    v[`parcha ${t.no} lines on screen`] = screenLines(p.doc.result, p.doc.config, "Round off");
    v[`parcha ${t.no} paper (Excel)`] = await xlsxCells(`/parchas/${t.pid}/parcha.xlsx`);
    v[`truck ${t.no} screen`] = truckScreen(await call("GET", `/loads/${t.id}`));
    v[`truck ${t.no} paper (Excel)`] = await xlsxCells(`/loads/${t.id}/parcha.xlsx`);
    v[`truck ${t.no} stock days`] = await call("GET", `/loads/${t.id}/stock-days`);
  }
  v["mill statement"] = await call("GET", `/mill-ledger/${TRM}`);
  v["mill statement to 31 July"] = await call("GET", `/mill-ledger/${TRM}?from=2026-07-01&to=2026-07-31`);
  v["parcha register"] = (await call("GET", "/parchas")).filter((p: any) => trucks.some((t) => t.pid === p.id));
  const ml = await call("GET", "/mill-ledger");
  v["mills list: this mill"] = ml.rows.find((r: any) => r.id === TRM);
  v["mills list: totals"] = ml.totals;
  v["follow-up"] = (await call("GET", "/mill-followup")).rows.find((r: any) => r.id === TRM);
  v["challan"] = await call("GET", `/challan?merchantId=${TRM}`);
  v["trucks list"] = (await call("GET", `/loads?merchantId=${TRM}&status=billed`));
  v["stock page"] = (await call("GET", "/stock")).find((r: any) => r.merchantId === TRM);
  v["stock page: mill days"] = await call("GET", `/stock/${TRM}`);
  v["stock page: mill card"] = await call("GET", `/dashboard/mill/${TRM}`);
  v["dashboard money"] = await call("GET", `/dashboard/money?to=${today}`);
  v["dashboard"] = await call("GET", "/dashboard");
  v["day averages"] = await call("GET", "/dashboard/day-averages");
  const books = await call("GET", "/audit/books-check");
  v["books check"] = { ...books, at: undefined };
  return v;
}
async function supplierView(from = "2026-07-01", to = "2026-07-31") {
  const v: Record<string, unknown> = {};
  v["slips"] = await call("GET", `/slips?from=${from}&to=${to}&merchantId=${TRM}`);
  for (const d of [day(5), day(10)]) v[`daily list ${d}`] = await call("GET", `/slips?date=${d}`);
  const list = await call("GET", "/ledger");
  v["supplier ledger"] = list.rows.filter((r: any) => sup.includes(r.id) || sup.includes(r.adatiId));
  v["supplier ledger totals"] = list.totals;
  for (const s of sup) v[`statement ${s}`] = await call("GET", `/ledger/${s}`);
  v["pay sheet"] = await call("GET", `/ledger/sheet?mode=range&from=${from}&to=${to}&format=json`);
  v["dashboard to pay"] = (await call("GET", `/dashboard/money?to=${today}`)).suppliers;
  return v;
}
function compare(what: string, was: Record<string, unknown>, now: Record<string, unknown>) {
  const changed = Object.keys(was).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
  check(`${what}: all ${Object.keys(was).length} readings identical, byte for byte`, changed.length === 0,
    changed.length ? changed.map((k) => `${k} — ${firstDiff(was[k], now[k])}`) : undefined);
}

const before = await millView(OLD);
const beforeSup = await supplierView();
const balanceBefore = (before["mills list: this mill"] as any).balancePaise as number;
const ownBills = OLD.reduce((s, t) => s + expT1.get(t.id)!.grand, 0);
const cutValue = goodsOf(kg(125), (await call("GET", `/parchas/${A3.pid}`)).doc.totals.ratePaisePerQtl);
check(`the mill owes: Σ six July parchas ${inr(ownBills)} − cut ${inr(cutValue)} − ₹20,000 − ₹50,000 − ₹100 TDS = ${inr(balanceBefore)}`,
  balanceBefore === ownBills - cutValue - rs(20000) - rs(50000) - rs(100), { want: ownBills - cutValue - rs(70100), got: balanceBefore });
const draftNetBefore = (await call("GET", `/loads/${D2.id}`)).load.millNetGrams;

console.log("\nA month later the owner changes every term of the mill: commission 1.2 % → 2 %, and the rest");
await call("PUT", `/merchants/${TRM}`, { chargeConfig: T2 });
// and the firm's own katauti, which slips with no mill take
await call("PUT", "/settings/display", { ...displayAtStart, katautiKgPerUnit: 1.5 });
const m2 = await call("GET", `/merchants/${TRM}`);
check("the mill now reads commission 2 %, adat 2.5 %, bardana 0.60 kg, katauti 1.5 kg a quintal", m2.chargeConfig.commission.pct === 2 && m2.chargeConfig.adat.pct === 2.5
  && m2.chargeConfig.millBardanaKgPerBag === 0.6 && m2.chargeConfig.katauti.kgPerUnit === 1.5);
compare("every July parcha, its paper, the truck screens, the statement, register, mills list, stock, dashboard and books check", before, await millView(OLD));
compare("every July slip, the daily list, supplier ledger, statements, pay sheet and to-pay", beforeSup, await supplierView());
const changedBy = repairTrucksAfterPull();
compare("…and after the repair every computer runs after a cloud pull", before, await millView(OLD));
check(`the after-pull repair changed nothing (${changedBy} truck records): billed trucks hold their parcha's figures`, changedBy === 0);

console.log("\nAfter the change: a new truck, and the drafts");
// purchases after the change: katauti on the new terms (1.5 kg a quintal)
for (let k = 0; k < 3; k++) await addSlip("2026-08-01", sup[k], J1.id, kg(2500 + k * 333) + 70, 345_000 + k * 1_000, 1.5, S1);
check(`3 slips of 1 August: katauti 1.5 kg a quintal on the new mill terms, e.g. ${qt(slips[slips.length - 1].grossGrams)} gross → ${qt(slipBy(slips[slips.length - 1]).netGrams)} net`, slipOk === slips.length);
const N1 = await makeTruck("2026-08-03", [{ date: "2026-08-01", jinsId: J1.id, grams: null, rate: null }], { gross: kg(3333), katte: 55, bore: 2, advance: rs(3000), dara: rs(1500), no: "7608" });
await approve(N1);
const eN1 = parchaBy(T2, specOf(N1));
checkPaper("new truck 7608 on the new terms", (await call("GET", `/parchas/${N1.pid}`)).doc, eN1);
const eN1old = parchaBy(T1, specOf(N1));
check(`7608: commission 2 % = ${inr(lineOf(eN1, "commission"))} (on the July terms it would be ${inr(lineOf(eN1old, "commission"))})`, lineOf(eN1, "commission") === pctOf(eN1.goods + lineOf(eN1, "adat"), 2));

// (i) a truck loaded in July, still a draft, approved after the change
await approve(D1);
const d1Doc = (await call("GET", `/parchas/${D1.pid}`)).doc;
const eD1new = parchaBy(T2, specOf(D1)), eD1old = parchaBy(T1, specOf(D1));
checkPaper("(i) draft 7607, loaded 29 July, approved after the change: takes the terms in force when approved (the new ones)", d1Doc, eD1new);
note(`(i) 7607 was a draft when the terms changed: its parcha is made on the new terms — ${inr(eD1new.grand)} (commission ${inr(lineOf(eD1new, "commission"))}); on the July terms it would have been ${inr(eD1old.grand)} (commission ${inr(lineOf(eD1old, "commission"))}). The draft's screen showed the new figure before approval.`);

// (iii) a July draft's weight edited after the change
const d2was = await call("GET", `/loads/${D2.id}`);
check("(iii) the July draft with no parcha number yet: the change of terms left its stored net alone (typed bardana)", d2was.load.millNetGrams === draftNetBefore && draftNetBefore === kg(3535) - kg(34), d2was.load.millNetGrams);
await call("PUT", `/loads/${D2.id}`, { millGrossGrams: kg(3600) });
const d2gross = await call("GET", `/loads/${D2.id}`);
check("(iii) its gross corrected 35.35 → 36.00 after the change: net 36.00 − its typed 0.34 = 35.66", d2gross.load.millNetGrams === kg(3600) - kg(34), d2gross.load.millNetGrams);
await call("PUT", `/loads/${D2.id}`, { katteBardanaGrams: null });
const d2now = await call("GET", `/loads/${D2.id}`);
check("(iii) its typed bardana emptied: the bardana is the mill's of today, 60 × 0.60 = 36 kg, net 35.64", d2now.load.millNetGrams === kg(3600) - bardana(60, 0.6) && d2now.weighment.bardanaGrams === bardana(60, 0.6), d2now.load.millNetGrams);
note(`(iii) a draft that was never billed works on the mill's terms of the day: net ${qt(draftNetBefore)} → ${qt(d2gross.load.millNetGrams)} (gross corrected, typed bardana kept) → ${qt(d2now.load.millNetGrams)} (bardana left to the terms: 0.60 kg a bag; on the July 0.57 it would be ${qt(kg(3600) - bardana(60, 0.57))}); it will be billed on the terms in force when approved, as in (i)`);

// (ii) an old approved parcha voided and approved again after the change
const a5Before = await call("GET", `/parchas/${A5.pid}`);
await call("POST", `/parchas/${A5.pid}/void`, { reason: "reprint test" });
const a5Draft = await call("GET", `/loads/${A5.id}`);
check("(ii) voided 7605 is a draft again with the stored net it was billed on (stock does not move)", a5Draft.load.status === "draft" && a5Draft.load.millNetGrams === expT1.get(A5.id)!.weights.netGrams,
  { status: a5Draft.load.status, net: a5Draft.load.millNetGrams, billed: expT1.get(A5.id)!.weights.netGrams });
check("(ii) …and its screen offers the parcha on the July terms it was billed on", a5Draft.doc?.result.grandTotalPaise === expT1.get(A5.id)!.grand, { screen: a5Draft.doc?.result.grandTotalPaise, july: expT1.get(A5.id)!.grand, now: parchaBy(T2, specOf(A5)).grand });
const a5oldPid = A5.pid;
await approve(A5);
const a5After = await call("GET", `/parchas/${A5.pid}`);
checkPaper("(ii) 7605 approved again after the change: the July terms, every line as before", a5After.doc, expT1.get(A5.id)!);
same("(ii) 7605's figures: the revised paper carries the very same weights, rows, lines and grand total",
  { w: a5Before.doc.weights, l: a5Before.doc.lines, r: a5Before.doc.result, c: a5Before.doc.config },
  { w: a5After.doc.weights, l: a5After.doc.lines, r: a5After.doc.result, c: a5After.doc.config });
check("(ii) …it is revision 2 of the same number", a5After.revision === 2 && a5After.parchaNo === "7605" && a5oldPid !== A5.pid, { rev: a5After.revision });
note(`(ii) voiding 7605 and approving it again keeps the terms it was billed on: ${inr(expT1.get(A5.id)!.grand)} both times (the new terms would have made it ${inr(parchaBy(T2, specOf(A5)).grand)})`);

// a billed truck voided, a weight corrected, approved again: the new weight, on the terms it was billed on
await call("POST", `/parchas/${A6.pid}/void`, { reason: "mill weight was typed wrong" });
const voidedNet = (await call("GET", `/loads/${A6.id}`)).load.millNetGrams;
const repaired = repairTrucks([A6.id]);
check("a voided truck: the after-pull repair leaves its stored net on the terms it was billed on", repaired === 0 && voidedNet === expT1.get(A6.id)!.weights.netGrams, { repaired, voidedNet });
await call("PUT", `/loads/${A6.id}`, { millGrossGrams: kg(4011) });
await approve(A6);
A6.spec.grossGrams = kg(4011);
const eA6 = parchaBy(T1, specOf(A6));
checkPaper("7606 voided, gross corrected 39.99 → 40.11, approved again: the July terms on the new weight", (await call("GET", `/parchas/${A6.pid}`)).doc, eA6);
note(`a correction to a billed truck keeps its terms: 7606 ${inr(expT1.get(A6.id)!.grand)} → ${inr(eA6.grand)} (on the new terms it would be ${inr(parchaBy(T2, specOf(A6)).grand)})`);

console.log("\nThe July parchas after all of that");
const PAST = [A1, A2, A3, A4];
const after = await millView(PAST);
// stock days: August's purchases are new, 26 July gave 7606's corrected weight and 29 July the draft's; every other July day as it was
const julyDays = (x: unknown) => (x as any[]).filter((d) => d.date <= "2026-07-31" && d.date !== day(26) && d.date !== day(29));
for (const k of Object.keys(after).filter((k) => /^(parcha|truck) 760[1-4]/.test(k))) {
  if (k.endsWith("stock days")) same(`${k} (July): as it was`, julyDays(before[k]), julyDays(after[k]));
  else same(`${k}: as it was`, before[k], after[k]);
}
for (const t of PAST) checkPaper(`parcha ${t.no} still on the July terms`, (await call("GET", `/parchas/${t.pid}`)).doc, expT1.get(t.id)!);
const owesNow = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === TRM).balancePaise;
const owesWant = balanceBefore + eN1.grand + eD1new.grand + (eA6.grand - expT1.get(A6.id)!.grand);
check(`what the mill owes moves only by the new bills: + 7608 ${inr(eN1.grand)} + 7607 ${inr(eD1new.grand)} + 7606's correction ${inr(eA6.grand - expT1.get(A6.id)!.grand)} = ${inr(owesWant)}`, owesNow === owesWant, { got: owesNow, want: owesWant });

console.log("\n(iv) Money from the mill after the change, against an old parcha");
const reg0 = await call("GET", "/parchas");
const st0 = await call("GET", `/mill-ledger/${TRM}`);
await call("POST", "/mill-receipts", { merchantId: TRM, receiptDate: "2026-08-05", amountPaise: rs(10000), mode: "upi", loadId: A2.id });
const reg1 = await call("GET", "/parchas");
const st1 = await call("GET", `/mill-ledger/${TRM}`);
const mine = (reg: any[]) => reg.filter((p: any) => [...OLD, N1, D1].some((t) => t.id === p.loadId) && p.status === "approved");
check("(iv) no parcha's grand total moves", JSON.stringify(mine(reg0).map((p: any) => [p.id, p.grandTotalPaise])) === JSON.stringify(mine(reg1).map((p: any) => [p.id, p.grandTotalPaise])));
const due = (reg: any[], t: TruckRec) => reg.find((p: any) => p.loadId === t.id && p.status === "approved").duePaise;
check(`(iv) 7602's due drops by exactly ₹10,000: ${inr(due(reg0, A2))} → ${inr(due(reg1, A2))}`, due(reg0, A2) - due(reg1, A2) === rs(10000));
check("(iv) every other parcha's due is as it was", [...OLD, N1, D1].filter((t) => t !== A2).every((t) => due(reg0, t) === due(reg1, t)));
check("(iv) the statement closes ₹10,000 lower, the past entries untouched", st0.totals.closingPaise - st1.totals.closingPaise === rs(10000)
  && JSON.stringify(st0.entries) === JSON.stringify(st1.entries.filter((e: any) => !(e.kind === "receipt" && e.date === "2026-08-05"))));

console.log("\n(v) The repair after a cloud pull, once more");
const pre = await millView([...OLD, N1, D1]);
const n = repairTrucksAfterPull();
compare(`(v) after the repair (${n} record(s) changed) every parcha, truck, statement and stock reading`, pre, await millView([...OLD, N1, D1]));

console.log("\n(vi) One truck approved on two computers, on different terms, then voided");
/* Computer A approved 7609 on the mill's terms; computer B, still on terms it
   was given by mistake (commission 3 %, bardana 0.66 kg), approved it a moment
   later. Sync keeps A's (the earlier) and voids B's as approved twice — B's
   has the larger id. Then the owner voids A's to put something right. */
const N2 = await makeTruck("2026-08-04", [{ date: "2026-08-01", jinsId: J1.id, grams: null, rate: null }], { gross: kg(3100), katte: 52, bore: 0, advance: 0, dara: 0, no: "7609" });
await approve(N2);
const pA = sqlite.prepare("select * from parchas where id = ?").get(N2.pid) as any;
const wrong = { ...T2, commission: { ...T2.commission, pct: 3 }, millBardanaKgPerBag: 0.66 };
const docB = JSON.parse(pA.snapshot);
docB.config = { ...docB.config, commission: { ...docB.config.commission, pct: 3 }, millBardanaKgPerBag: 0.66 };
const pBid = newId();
sqlite.prepare(`insert into parchas (id, business_id, load_id, parcha_no, version, invoice_date, snapshot, grand_total_paise, status, approved_by, approved_at, voided_by, voided_at, void_reason, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, 'void', ?, ?, null, ?, ?, ?)`).run(pBid, pA.business_id, pA.load_id, pA.parcha_no, pA.version + 1, pA.invoice_date, JSON.stringify(docB),
  parchaBy(wrong as Terms, specOf(N2)).grand, pA.approved_by, pA.approved_at + 1, pA.approved_at + 2, APPROVED_TWICE, pA.created_at + 1);
check("the loser has the larger id (B approved later)", pBid > pA.id);
await call("POST", `/parchas/${N2.pid}/void`, { reason: "advance typed wrong" });
const n2v = await call("GET", `/loads/${N2.id}`);
const eN2 = parchaBy(T2, specOf(N2));
check("(vi) voided: the truck keeps the terms of the parcha the mill was billed on (commission 2 %), never the approved-twice loser's (3 %)",
  n2v.config.commission.pct === 2 && n2v.config.millBardanaKgPerBag === 0.6, { commission: n2v.config.commission.pct, bardana: n2v.config.millBardanaKgPerBag });
check(`(vi) …its stored net stays the billed ${qt(eN2.weights.netGrams)} (bardana 52 × 0.60), not 52 × 0.66`, n2v.load.millNetGrams === eN2.weights.netGrams, { stored: n2v.load.millNetGrams, billed: eN2.weights.netGrams, loser: parchaBy(wrong as Terms, specOf(N2)).weights.netGrams });
check("(vi) …the after-pull repair, which every computer runs, agrees", repairTrucks([N2.id]) === 0 && termsOfTruck(N2.id, wrong as any).commission.pct === 2);
await approve(N2);
checkPaper("(vi) 7609 approved again: on the terms it was billed on", (await call("GET", `/parchas/${N2.pid}`)).doc, eN2);

console.log("\n(vii) A mill registered with the wrong terms: re-billing a truck on the corrected ones");
/* 7606 was billed on the July terms; the owner says the mill's terms are now
   right (commission 2 %, ...) and wants that truck billed on them. Only an
   explicit tick at the approve step does it. */
const owesBefore7 = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === TRM).balancePaise;
const a6Billed = (await call("GET", `/parchas/${A6.pid}`)).doc;
await call("POST", `/parchas/${A6.pid}/void`, { reason: "mill's commission was registered wrong" });
const a6Own = await call("GET", `/loads/${A6.id}`);
const a6Mill = await call("GET", `/loads/${A6.id}?terms=mill`);
const eA6new = parchaBy(T2, specOf(A6));
check("(vii) voided 7606 says its mill's terms changed since it was billed, and by default still offers the July terms",
  a6Own.millTermsChanged === true && a6Own.onMillTerms === false && a6Own.doc?.result.grandTotalPaise === eA6.grand, { changed: a6Own.millTermsChanged, own: a6Own.onMillTerms, total: a6Own.doc?.result.grandTotalPaise });
check(`(vii) with the tick its parcha is worked on the mill's current terms: ${inr(eA6new.grand)} (commission 2 %)`,
  a6Mill.onMillTerms === true && a6Mill.config.commission.pct === 2 && a6Mill.doc?.result.grandTotalPaise === eA6new.grand, { total: a6Mill.doc?.result.grandTotalPaise, want: eA6new.grand });
check("(vii) looking does not move anything: its stored net is still the July one", a6Mill.load.millNetGrams === eA6.weights.netGrams);
const seenOld = await raw("POST", `/loads/${A6.id}/approve`, { millTerms: true, expectedGrandTotalPaise: eA6.grand });
const seenOldBody = await seenOld.json();
check("(vii) approving with the tick but the July total on screen is refused: the approver must see what is billed", seenOld.status === 409 && seenOldBody.code === "changed", seenOld.ok ? seenOldBody : undefined);
// (a wrong approval here is put back, so the checks after it still say something)
if (seenOld.ok) await call("POST", `/parchas/${seenOldBody.id}/void`, { reason: "approved on a total not seen" });
const a6res = await raw("POST", `/loads/${A6.id}/approve`, { millTerms: true, expectedGrandTotalPaise: eA6new.grand });
const a6r = await a6res.json();
check(`(vii) ticked, with ${inr(eA6new.grand)} on screen: approved`, a6res.ok, a6res.ok ? undefined : a6r);
A6.pid = a6res.ok ? a6r.id : (await call("POST", `/loads/${A6.id}/approve`, { millTerms: true })).id;
const a6Doc = (await call("GET", `/parchas/${A6.pid}`)).doc;
checkPaper("(vii) 7606 revision 3, ticked: every line on the mill's current terms", a6Doc, eA6new);
check(`(vii) commission ${inr(lineOf(eA6new, "commission"))} at 2 % (was ${inr(lineOf(eA6, "commission"))} at 1.2 %)`, a6Doc.config.commission.pct === 2 && a6Doc.revision === 3);
const trail = (await call("GET", "/audit?action=parcha.approve&limit=200")).rows;
const said = (pid: string | undefined) => trail.find((r: any) => r.entityId === pid)?.after?.billedOn;
check(`(vii) the audit trail says which: 7606 "${said(A6.pid)}", 7605 "${said(A5.pid)}"`,
  said(A6.pid) === "the mill's current terms" && said(A5.pid) === "the terms it was first billed on" && said(N1.pid) === undefined);
const owesAfter7 = (await call("GET", "/mill-ledger")).rows.find((r: any) => r.id === TRM).balancePaise;
check(`(vii) the mill owes exactly the difference more: ${inr(eA6new.grand - a6Billed.result.grandTotalPaise)}`, owesAfter7 - owesBefore7 === eA6new.grand - a6Billed.result.grandTotalPaise, { moved: owesAfter7 - owesBefore7 });
await call("POST", `/parchas/${A6.pid}/void`, { reason: "check the terms it keeps" });
const a6Again = await call("GET", `/loads/${A6.id}`);
check("(vii) voided once more, it keeps the terms it was last billed on (the corrected ones): nothing to tick", a6Again.millTermsChanged === false && a6Again.doc?.result.grandTotalPaise === eA6new.grand);
A6.pid = (await call("POST", `/loads/${A6.id}/approve`, {})).id;
note(`(vii) a truck billed before keeps its terms unless the approver ticks "Bill on the mill's current terms": 7606 ${inr(eA6.grand)} → ${inr(eA6new.grand)}; the trail records the choice`);

/* ------------------------------------------------------------- suppliers */
console.log("\nB. The supplier charges change: commission 1.1 % → 2.25 %, gaushala ₹1.30 → ₹2.00 a quintal");
const supBefore = await supplierView("2026-07-01", "2026-08-01");
await call("PUT", "/settings/supplier-charges", { ...supplierChargesAtStart, ...S2 });
compare("every slip, the daily list, ledger, statements, pay sheet and to-pay", supBefore, await supplierView("2026-07-01", "2026-08-01"));
const fresh = await addSlip("2026-08-02", sup[0], J1.id, kg(2777) + 30, 352_500, 1.5, S2);
check(`a slip of 2 August takes the new charges: commission ${inr(slipBy(fresh).commissionPaise)}, gaushala ${inr(slipBy(fresh).gaushalaPaise)}`, slipOk === slips.length);

const slipNow = async (id: string) => (await call("GET", `/slips?from=2026-07-01&to=2026-08-31`)).rows.find((r: any) => r.id === id);
// an old slip's rate corrected
const sR = slips.find((s) => s.date === day(5))!;
const sRwas = pick(await slipNow(sR.id));
await call("PUT", `/slips/${sR.id}`, { ratePaisePerQtl: sR.rate + 2_500 });
sR.rate += 2_500;
const sRnow = pick(await slipNow(sR.id));
check(`an old slip's rate changed after the change: commission and gaushala stay on the July charges (${S1.commissionPct} %, ₹${S1.gaushalaPerQtl})`, JSON.stringify(sRnow) === JSON.stringify(slipBy(sR)), { app: sRnow, here: slipBy(sR) });
note(`editing the rate of RST ${sR.rst} (5 July) keeps the slip's own charges: payable ${inr(sRwas.payablePaise)} → ${inr(sRnow.payablePaise)}; on the new charges it would be ${inr(slipBy({ ...sR, sup: S2 }).payablePaise)}`);
// an old slip's gross corrected
const sG = slips.find((s) => s.date === day(6))!;
const sGwas = pick(await slipNow(sG.id));
await call("PUT", `/slips/${sG.id}`, { grossGrams: sG.grossGrams + kg(50) });
sG.grossGrams += kg(50);
const sGnow = pick(await slipNow(sG.id));
const sGtoday = slipBy({ ...sG, katKg: 1.5 }), sGjuly = slipBy({ ...sG, katKg: 1 });
check("an old slip's gross corrected after the change: its katauti and supplier charges both stay the slip's own (1 kg a quintal, 1.1 %)", JSON.stringify(sGnow) === JSON.stringify(sGjuly), { app: sGnow, july: sGjuly, today: sGtoday });
check("…and the daily list hands the edit box the slip's own katauti (1 kg a quintal), so the preview shows what is saved", (await slipNow(sG.id)).katautiCfg.kgPerUnit === 1);
note(`correcting the gross of RST ${sG.rst} (6 July) by +0.50 qtl: net ${qt(sGwas.netGrams)} → ${qt(sGnow.netGrams)}, payable ${inr(sGwas.payablePaise)} → ${inr(sGnow.payablePaise)} — on its own July katauti (1 kg/qtl); the mill's katauti of today (1.5 kg/qtl) would have made it net ${qt(sGtoday.netGrams)}, payable ${inr(sGtoday.payablePaise)}`);
// the Recompute button on a day before the change
const day7 = await call("GET", `/slips?date=${day(7)}`);
const rc = await call("POST", "/slips/recompute", { slipDate: day(7) });
const day7after = await call("GET", `/slips?date=${day(7)}`);
check(`"Recompute the day" on 7 July: ${rc.scanned} rows checked, ${rc.changed} changed — it repairs a row to its own terms, it never applies new ones`, rc.changed === 0 && JSON.stringify(day7) === JSON.stringify(day7after), rc);
const rc6 = await call("POST", "/slips/recompute", { slipDate: day(6) });
check("…and on 6 July, where a gross was just corrected, nothing to repair either", rc6.changed === 0, rc6);
check("every July slip still reconciles on its own terms (no row asks for Recompute)", (await call("GET", "/slips?from=2026-07-01&to=2026-07-31")).rows.filter((r: any) => r.merchantId === TRM).every((r: any) => r.reconciles));
// old slips moved to another mill
const moving = slips.filter((s) => s.date === day(8));
const movWas = await Promise.all(moving.map(async (s) => pick(await slipNow(s.id))));
const mv = await call("POST", "/slips/reassign", { slipIds: moving.map((s) => s.id), merchantId: TRM2 });
for (const s of moving) { s.merchantId = TRM2; s.katKg = 0.5; }
const movNow = await Promise.all(moving.map(async (s) => pick(await slipNow(s.id))));
check(`2 slips of 8 July moved to another mill: katauti on that mill's terms (0.5 kg/qtl), supplier charges stay their own July ones`, mv.updated === 2 && JSON.stringify(movNow) === JSON.stringify(moving.map((s) => slipBy(s))), { app: movNow, here: moving.map((s) => slipBy(s)) });
note(`moving slips to another mill (by design) re-works their katauti on the new mill's terms: net ${movWas.map((x) => qt(x.netGrams)).join(" + ")} → ${movNow.map((x) => qt(x.netGrams)).join(" + ")}, payable ${inr(movWas.reduce((s, x) => s + x.payablePaise, 0))} → ${inr(movNow.reduce((s, x) => s + x.payablePaise, 0))}; the commission % and gaushala rate stay the slip's own (screen asks first and shows before → after)`);
// an old slip given to another supplier
const sS = slips.find((s) => s.date === day(9))!;
const toSup = sup.find((x) => x !== sS.adatiId)!;
const ledgerWas = await call("GET", "/ledger");
const sSwas = pick(await slipNow(sS.id));
await call("PUT", `/slips/${sS.id}`, { adatiId: toSup });
const fromSup = sS.adatiId;
sS.adatiId = toSup;
const sSnow = pick(await slipNow(sS.id));
const ledgerNow = await call("GET", "/ledger");
const balOf = (l: any, id: string) => l.rows.find((r: any) => (r.id ?? r.adatiId) === id).balancePaise;
check(`an old slip given to another supplier keeps its figures (${inr(sSnow.payablePaise)}): its own charges go with it`, JSON.stringify(sSwas) === JSON.stringify(sSnow));
check("…and moves exactly that payable from one supplier's balance to the other's", balOf(ledgerWas, fromSup) - balOf(ledgerNow, fromSup) === sSwas.payablePaise && balOf(ledgerNow, toSup) - balOf(ledgerWas, toSup) === sSwas.payablePaise);
note("supplier charges are one setting for the whole firm (Settings › Supplier charges); there are no per-supplier charges in this version, so a change of supplier on a slip changes nothing in its figures");
// every slip, as it stands now, against the figures worked here
const allNow = (await call("GET", "/slips?from=2026-07-01&to=2026-08-31")).rows.filter((r: any) => slips.some((s) => s.id === r.id));
check(`all ${slips.length} slips, after the edits, as worked here to the paisa`, allNow.length === slips.length && allNow.every((r: any) => JSON.stringify(pick(r)) === JSON.stringify(slipBy(slips.find((s) => s.id === r.id)!))));
const ledger = await call("GET", "/ledger");
for (const s of sup) {
  const want = slips.filter((x) => x.adatiId === s).reduce((t, x) => t + slipBy(x).payablePaise, 0);
  check(`supplier ${sup.indexOf(s) + 1} is owed Σ its slips' payable ${inr(want)}`, balOf(ledger, s) === want, { got: balOf(ledger, s), want });
}

console.log("\nD. Slips from before v0.3, carrying no terms of their own, after the firm's katauti (1 → 1.5 kg) and charges (1.1 % → 2.25 %) changed");
const legacyNow = async () => {
  const rows = (await call("GET", `/slips?date=${day(3)}`)).rows;
  return { L1: rows.find((r: any) => r.id === L1id), L2: rows.find((r: any) => r.id === L2id), all: rows };
};
const lg = await legacyNow();
check(`(D) RST 9001 (no mill, no katauti terms): the daily list finds it adds up on its stored net ${qt(legacyAsMade.L1.netGrams)}`,
  lg.L1.reconciles === true && lg.L1.expectedNetGrams === legacyAsMade.L1.netGrams && JSON.stringify(pick(lg.L1)) === JSON.stringify(legacyAsMade.L1),
  { reconciles: lg.L1.reconciles, expectedNet: lg.L1.expectedNetGrams, stored: pick(lg.L1) });
check(`(D) RST 9002 (no supplier terms): adds up on its stored charges, payable ${inr(legacyAsMade.L2.payablePaise)}`,
  lg.L2.reconciles === true && lg.L2.expectedPayablePaise === legacyAsMade.L2.payablePaise, { reconciles: lg.L2.reconciles, expectedPayable: lg.L2.expectedPayablePaise });
check("(D) no row of 3 July asks for Recompute", lg.all.every((r: any) => r.reconciles));
const rc3 = await call("POST", "/slips/recompute", { slipDate: day(3) });
const lgR = await legacyNow();
check(`(D) "Recompute the day" on 3 July: ${rc3.changed} of ${rc3.scanned} changed; both old slips exactly as made`,
  rc3.changed === 0 && JSON.stringify(pick(lgR.L1)) === JSON.stringify(legacyAsMade.L1) && JSON.stringify(pick(lgR.L2)) === JSON.stringify(legacyAsMade.L2),
  { rc: rc3, L1: pick(lgR.L1), L2: pick(lgR.L2) });
const booksD = await call("GET", "/audit/books-check");
check("(D) the books check takes their stored figures as they are", booksD.problems === 0,
  booksD.businesses.flatMap((b: any) => b.sections.flatMap((x: any) => x.lines.filter((l: any) => l.ok === false).map((l: any) => l.text))).slice(0, 4));
// an edit that does not touch the weight keeps the stored net and charges
await call("PUT", `/slips/${L2id}`, { rstNo: "9012" });
check("(D) RST 9002's number corrected: its payable stays as made (not re-priced at 2.25 %)", JSON.stringify(pick((await legacyNow()).L2)) === JSON.stringify(legacyAsMade.L2), pick((await legacyNow()).L2));
await call("PUT", `/slips/${L1id}`, { ratePaisePerQtl: L1.rate + 1_000 });
const l1rate = slipBy({ ...L1, rate: L1.rate + 1_000 });
check(`(D) RST 9001's rate corrected: net stays ${qt(l1rate.netGrams)}, amount ${inr(l1rate.amountPaise)} on it, charges on its own ${S1.commissionPct} %`,
  JSON.stringify(pick((await legacyNow()).L1)) === JSON.stringify(l1rate), { app: pick((await legacyNow()).L1), here: l1rate });
await call("PUT", `/slips/${L1id}`, { grossGrams: L1.grossGrams + kg(20) });
const l1gross = slipBy({ ...L1, rate: L1.rate + 1_000, grossGrams: L1.grossGrams + kg(20), katKg: 1.5 });
check("(D) RST 9001's gross corrected: with no katauti terms of its own, the firm's katauti of today (1.5 kg) is all there is", JSON.stringify(pick((await legacyNow()).L1)) === JSON.stringify(l1gross), { app: pick((await legacyNow()).L1), here: l1gross });
note(`(D) a slip from before v0.3 with no katauti or supplier terms keeps its stored figures through a change of settings, Recompute and any edit that leaves its weight alone; a corrected weight is worked on today's katauti (net ${qt(legacyAsMade.L1.netGrams)} → ${qt(l1gross.netGrams)} for +0.20 qtl) — there is nothing else to work it on`);
for (const id of [L1id, L2id]) await call("DELETE", `/slips/${id}`);

console.log("\nC. The mill's katauti changed (1 → 1.5 kg a quintal): July slips' net never moved");
const julyNet = (await call("GET", `/slips?from=2026-07-01&to=2026-07-31&merchantId=${TRM}`)).rows;
check(`${julyNet.length} July slips of the mill: net = gross − whole quintals × 1 kg, the one with a corrected gross too`,
  julyNet.every((r: any) => r.netGrams === r.grossGrams - r.katautiUnits * 1000 && r.katautiCfg.kgPerUnit === 1));
const books = await call("GET", "/audit/books-check");
check("the books check finds no problem", books.problems === 0, books.businesses.flatMap((b: any) => b.sections.flatMap((s: any) => s.lines.filter((l: any) => l.ok === false).map((l: any) => l.text))));
const millCode = (await call("GET", `/merchants/${TRM}`)).code;
check("…and marks nothing of this mill to look at", !JSON.stringify(books.businesses.flatMap((b: any) => b.sections.flatMap((s: any) => s.lines.filter((l: any) => l.warn)))).includes(millCode));

console.log("\nA second change (bardana 0.60 → 0.62 kg): the drafts and the bills");
const billedNow = await millView([...OLD, N1, D1]);
const d2Before = (await call("GET", `/loads/${D2.id}`)).load.millNetGrams;
await call("PUT", `/merchants/${TRM}`, { chargeConfig: { ...T2, millBardanaKgPerBag: 0.62 } });
const d2After = (await call("GET", `/loads/${D2.id}`)).load.millNetGrams;
check("a draft never billed, bardana left to the terms: its stored net follows (60 × 0.62 = 37 kg: 35.64 → 35.63)", d2Before === kg(3600) - bardana(60, 0.6) && d2After === kg(3600) - bardana(60, 0.62), { d2Before, d2After });
const billedAfter = await millView([...OLD, N1, D1]);
const notStock = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([k]) => !/stock|dashboard|challan|books|day averages/.test(k)));
compare("every parcha (July and August), truck screen, statement, register and mills list", notStock(billedNow), notStock(billedAfter));
note(`a draft truck with its bardana left to the terms is the one thing a change of terms moves: its stored net (and so the stock it takes) ${qt(d2Before)} → ${qt(d2After)} qtl. Nothing billed moves.`);
compare("…and after the after-pull repair", notStock(billedAfter), notStock(await millView([...OLD, N1, D1])));

// leave the books as the scripts after this one expect them
await call("PUT", "/settings/supplier-charges", supplierChargesAtStart);
await call("PUT", "/settings/display", displayAtStart);
for (const m of [TRM, TRM2]) await call("DELETE", `/merchants/${m}`);
check("supplier charges and the firm's katauti back to what they were", JSON.stringify(await call("GET", "/settings/supplier-charges")) === JSON.stringify(supplierChargesAtStart)
  && JSON.stringify(await call("GET", "/settings/display")) === JSON.stringify(displayAtStart));

console.log(bad === 0 ? "\nPast figures never move when terms change." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
