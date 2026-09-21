/* An independent audit of every rupee and quintal in a database, read-only.
 * It does not use the app's routes: it re-works each figure from the raw
 * rows and says where anything disagrees.
 *   npx tsx scripts/money-check.ts <path-to-a-copy-of-mandi.db>
 * Run it on a copy (sqlite3 data/mandi.db ".backup /tmp/copy.db"), never
 * while pointing a writer at the same file.
 */
import Database from "better-sqlite3";
import { amountPaise } from "../server/lib/money.ts";
import { deriveKatauti, ChargeConfigSchema, type Katauti } from "../server/lib/charges.ts";
import type { ParchaDoc } from "../server/lib/parcha.ts";

const file = process.argv[2];
if (!file) { console.error("usage: npx tsx scripts/money-check.ts <copy-of-mandi.db>"); process.exit(2); }
const db = new Database(file, { readonly: true, fileMustExist: true });
const all = <T,>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const rs = (p: number) => ((p || 0) / 100 + 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qt = (g: number) => (g / 100_000).toFixed(2);
let problems = 0;
const bad = (msg: string) => { problems++; console.log(`   ✗ ${msg}`); };
const ok = (msg: string) => console.log(`   ✓ ${msg}`);

const DEFAULT_K: Katauti = { mode: "per_quintal_rounded", kgPerUnit: 1, rounding: "half_up" } as Katauti;

for (const biz of all<{ id: string; name: string }>("select id, name from businesses")) {
  console.log(`\n══ ${biz.name}`);
  const mills = all<{ id: string; code: string; charge_config: string; opening_balance_paise: number }>("select id, code, charge_config, opening_balance_paise from merchants where business_id = ?", biz.id);
  const kOf = new Map<string, Katauti>();
  for (const m of mills) { const c = ChargeConfigSchema.safeParse(JSON.parse(m.charge_config)); kOf.set(m.id, c.success ? c.data.katauti : DEFAULT_K); }
  const code = (id: string | null) => mills.find((m) => m.id === id)?.code ?? "no mill";

  // 1. every slip re-worked: katauti, net, amount
  console.log("\n 1. Slips (daily list)");
  const slips = all<{ id: string; rst_no: string; slip_date: string; adati_id: string; merchant_id: string | null; jins_id: string; gross_grams: number; katauti_units: number; katauti_override: number; net_grams: number; rate_paise_per_qtl: number; amount_paise: number }>(
    "select * from purchase_slips where business_id = ?", biz.id);
  let slipBad = 0;
  for (const s of slips) {
    const k = deriveKatauti(s.gross_grams, s.merchant_id ? kOf.get(s.merchant_id) ?? DEFAULT_K : DEFAULT_K, s.katauti_override ? s.katauti_units : null);
    const net = s.gross_grams - k.deductionGrams;
    const amt = amountPaise(net, s.rate_paise_per_qtl);
    if (k.units !== s.katauti_units || net !== s.net_grams || amt !== s.amount_paise) {
      slipBad++;
      bad(`${s.slip_date} RST ${s.rst_no}: stored katauti ${s.katauti_units} net ${qt(s.net_grams)} amount ${rs(s.amount_paise)}; re-worked ${k.units} / ${qt(net)} / ${rs(amt)}`);
    }
  }
  if (!slipBad) ok(`${slips.length} slips: every katauti, net weight and amount re-works exactly`);
  const unpriced = slips.filter((s) => !s.rate_paise_per_qtl);
  if (unpriced.length) console.log(`   ! ${unpriced.length} slip(s) have no rate yet and count as ₹0 until priced`);

  // 2. suppliers
  console.log("\n 2. Supplier ledger (what we owe)");
  const sup = all<{ id: string; opening_balance_paise: number }>("select id, opening_balance_paise from adati where business_id = ?", biz.id);
  const pays = all<{ adati_id: string; amount_paise: number; voided_at: number | null }>("select adati_id, amount_paise, voided_at from payments where business_id = ?", biz.id);
  const opening = sup.reduce((s, a) => s + a.opening_balance_paise, 0);
  const purchases = slips.reduce((s, x) => s + x.amount_paise, 0);
  const paid = pays.filter((p) => p.voided_at == null).reduce((s, p) => s + p.amount_paise, 0);
  const cancelled = pays.filter((p) => p.voided_at != null);
  const bal = sup.map((a) => a.opening_balance_paise + slips.filter((x) => x.adati_id === a.id).reduce((s, x) => s + x.amount_paise, 0)
    - pays.filter((p) => p.adati_id === a.id && p.voided_at == null).reduce((s, p) => s + p.amount_paise, 0));
  const toPay = bal.filter((b) => b > 0).reduce((s, b) => s + b, 0);
  const ahead = bal.filter((b) => b < 0).reduce((s, b) => s - b, 0);
  ok(`opening ₹${rs(opening)} + purchases ₹${rs(purchases)} − paid ₹${rs(paid)} = ₹${rs(opening + purchases - paid)}`);
  ok(`= to pay ₹${rs(toPay)} − paid ahead ₹${rs(ahead)} (${bal.filter((b) => b < 0).length} supplier(s) paid ahead)`);
  if (opening + purchases - paid !== toPay - ahead) bad("supplier balances do not add up to the total");
  if (cancelled.length) console.log(`   · ${cancelled.length} cancelled payment(s) of ₹${rs(cancelled.reduce((s, p) => s + p.amount_paise, 0))} kept on record, counted as nothing`);

  // 3. every approved parcha re-added from its frozen copy
  console.log("\n 3. Kaccha parchas (what we billed)");
  const parchas = all<{ id: string; load_id: string; parcha_no: string; version: number; status: string; grand_total_paise: number; snapshot: string }>(
    "select id, load_id, parcha_no, version, status, grand_total_paise, snapshot from parchas where business_id = ?", biz.id);
  const approved = parchas.filter((p) => p.status === "approved");
  let pBad = 0;
  const parts = new Map<string, number>();
  let goodsBilled = 0;
  for (const p of approved) {
    const d = JSON.parse(p.snapshot) as ParchaDoc;
    const lineSum = d.lines.reduce((s, l) => s + l.amountPaise, 0);
    const linesOk = d.lines.every((l) => amountPaise(l.netGrams, l.ratePaisePerQtl) === l.amountPaise);
    const charges = d.result.lines.filter((l) => l.kind === "charge").reduce((s, l) => s + (l.sign === "subtract" ? -l.amountPaise : l.amountPaise), 0);
    const totalOk = d.result.goodsAmountPaise + charges === d.result.totalPaise;
    const r = d.result;
    let grand = r.totalPaise;
    if (d.config.advance.treatment === "add") grand += r.advancePaise;
    else if (d.config.advance.treatment === "subtract") grand -= r.advancePaise;
    if (d.config.dara.includeInGrandTotal) grand += r.daraPaise;
    const roundedOk = Math.abs(grand - r.grandTotalPaise) < (d.config.grandTotalRounding === "nearest_ten" ? 1000 : 100);
    if (lineSum !== d.totals.goodsPaise || !linesOk || d.totals.goodsPaise !== r.goodsAmountPaise || !totalOk || !roundedOk || r.grandTotalPaise !== p.grand_total_paise) {
      pBad++;
      bad(`#${p.parcha_no} v${p.version}: rows ${rs(lineSum)} vs goods ${rs(d.totals.goodsPaise)}; goods + charges ${rs(r.goodsAmountPaise + charges)} vs total ${rs(r.totalPaise)}; grand ${rs(r.grandTotalPaise)} vs stored ${rs(p.grand_total_paise)}`);
    }
    goodsBilled += r.goodsAmountPaise;
    for (const l of r.lines.filter((x) => x.kind === "charge")) parts.set(l.label, (parts.get(l.label) ?? 0) + (l.sign === "subtract" ? -l.amountPaise : l.amountPaise));
  }
  const billed = approved.reduce((s, p) => s + p.grand_total_paise, 0);
  if (!pBad) ok(`${approved.length} approved parcha(s): every row, charge, total and grand total re-adds exactly (${parchas.length - approved.length} voided kept aside)`);
  ok(`billed ₹${rs(billed)} = goods ₹${rs(goodsBilled)} + charges ₹${rs([...parts.values()].reduce((s, v) => s + v, 0))} + advance/rounding ₹${rs(billed - goodsBilled - [...parts.values()].reduce((s, v) => s + v, 0))}`);
  for (const [label, v] of parts) console.log(`     · ${label}: ₹${rs(v)}`);

  // 4. mills
  console.log("\n 4. Mill accounts (what mills owe us)");
  const loads = all<{ id: string; merchant_id: string; truck_no: string | null; mill_net_grams: number | null; mill_deduction_grams: number; status: string; load_date: string }>(
    "select id, merchant_id, truck_no, mill_net_grams, mill_deduction_grams, status, load_date from loads where business_id = ?", biz.id);
  const recs = all<{ merchant_id: string; amount_paise: number; deduction_paise: number; voided_at: number | null }>("select merchant_id, amount_paise, deduction_paise, voided_at from mill_receipts where business_id = ?", biz.id);
  let owedTotal = 0;
  for (const m of mills) {
    const mine = approved.filter((p) => loads.find((l) => l.id === p.load_id)?.merchant_id === m.id);
    const b = mine.reduce((s, p) => s + p.grand_total_paise, 0);
    const cut = mine.reduce((s, p) => {
      const l = loads.find((x) => x.id === p.load_id)!;
      return s + (l.mill_deduction_grams ? amountPaise(l.mill_deduction_grams, (JSON.parse(p.snapshot) as ParchaDoc).totals.ratePaisePerQtl) : 0);
    }, 0);
    const r = recs.filter((x) => x.merchant_id === m.id && x.voided_at == null);
    const got = r.reduce((s, x) => s + x.amount_paise + x.deduction_paise, 0);
    const owes = m.opening_balance_paise + b - cut - got;
    owedTotal += owes;
    if (b || got || m.opening_balance_paise || cut) ok(`${m.code}: opening ₹${rs(m.opening_balance_paise)} + billed ₹${rs(b)} − cut ₹${rs(cut)} − received ₹${rs(got)} = owes ₹${rs(owes)}`);
  }
  if (!recs.length) console.log("   ! no money from mills recorded yet — every approved parcha counts as still owed");

  // 5. stock: bought − loaded, per mill
  console.log("\n 5. Stock (bought − loaded)");
  const lines = all<{ load_id: string; net_grams: number | null }>("select load_id, net_grams from load_lines where business_id = ?", biz.id);
  let stockValue = 0;
  for (const m of mills) {
    const bought = slips.filter((s) => s.merchant_id === m.id).reduce((s, x) => s + x.net_grams, 0);
    const boughtValue = slips.filter((s) => s.merchant_id === m.id).reduce((s, x) => s + x.amount_paise, 0);
    let loaded = 0;
    for (const l of loads.filter((x) => x.merchant_id === m.id)) {
      const rows = lines.filter((x) => x.load_id === l.id);
      const typed = rows.filter((x) => x.net_grams != null).reduce((s, x) => s + x.net_grams!, 0);
      const blank = rows.filter((x) => x.net_grams == null).length;
      loaded += typed + (blank && l.mill_net_grams != null ? l.mill_net_grams - typed : 0);
    }
    if (!bought && !loaded) continue;
    const left = bought - loaded;
    const avg = bought ? boughtValue / (bought / 100_000) : 0;
    stockValue += Math.max(0, left) / 100_000 * avg;
    ok(`${m.code}: bought ${qt(bought)} − loaded ${qt(loaded)} = ${qt(left)} qtl left${left < 0 ? "  ← more loaded than bought" : ""}`);
  }
  const noMill = slips.filter((s) => !s.merchant_id);
  if (noMill.length) console.log(`   ! ${noMill.length} slip(s), ${qt(noMill.reduce((s, x) => s + x.net_grams, 0))} qtl, have no mill and sit in no mill's stock`);

  // 6. where the money stands
  const unbilled = loads.filter((l) => l.status !== "billed").length;
  console.log("\n 6. Money position");
  console.log(`   mills owe us            ₹${rs(owedTotal)}`);
  console.log(`   we owe suppliers        ₹${rs(opening + purchases - paid)}`);
  console.log(`   stock in hand (at cost) ≈ ₹${rs(Math.round(stockValue))}`);
  console.log(`   trucks not yet billed   ${unbilled}${unbilled ? "  (their goods are not valued here; the dashboard adds them)" : ""}`);
  const cashIn = recs.filter((r) => r.voided_at == null).reduce((s, r) => s + r.amount_paise, 0);
  console.log(`   cash from trade         ₹${rs(cashIn - paid)}  (in from mills ₹${rs(cashIn)} − out to suppliers ₹${rs(paid)})`);
  console.log(`   net (mills owe + stock + cash − we owe) ≈ ₹${rs(Math.round(owedTotal + stockValue + cashIn - paid - (opening + purchases - paid)))}`);
}
db.close();
console.log(problems ? `\n${problems} problem(s) found.` : "\nEvery figure re-works exactly.");
process.exit(problems ? 1 : 0);
