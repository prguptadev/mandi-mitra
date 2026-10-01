import type Database from "better-sqlite3";
import { amountPaise } from "./money.ts";
import { deriveKatauti, ChargeConfigSchema, type Katauti } from "./charges.ts";
import type { ParchaDoc } from "./parcha.ts";
import { fyNumberLabel } from "./parchaLabels.ts";

/* An independent audit of every rupee and quintal, read-only. It does not
   use the app's routes or its stored totals: each figure is re-worked from
   the raw rows and anything that disagrees is named. The Audit screen runs
   it on the live books; scripts/money-check.ts runs it on a copy. */

export interface CheckLine { ok: boolean | null; text: string }
export interface CheckSection { title: string; lines: CheckLine[] }
export interface BusinessCheck { businessId: string; name: string; sections: CheckSection[]; problems: number }
export interface BooksCheck { businesses: BusinessCheck[]; problems: number; at: number }

const rs = (p: number) => ((p || 0) / 100 + 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qt = (g: number) => (g / 100_000).toFixed(2);
const DEFAULT_K: Katauti = { mode: "per_quintal_rounded", kgPerUnit: 1, rounding: "half_up" } as Katauti;
const fyOf = (iso: string) => { const y = Number(iso.slice(0, 4)); return Number(iso.slice(5, 7)) >= 4 ? y : y - 1; };

export function checkBooks(db: Database.Database, onlyBusiness?: string): BooksCheck {
  const all = <T,>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const out: BooksCheck = { businesses: [], problems: 0, at: Math.floor(Date.now() / 1000) };
  const bizList = all<{ id: string; name: string }>("select id, name from businesses" + (onlyBusiness ? " where id = ?" : ""), ...(onlyBusiness ? [onlyBusiness] : []));

  for (const biz of bizList) {
    const B: BusinessCheck = { businessId: biz.id, name: biz.name, sections: [], problems: 0 };
    out.businesses.push(B);
    let cur: CheckSection = { title: "", lines: [] };
    const section = (title: string) => { cur = { title, lines: [] }; B.sections.push(cur); };
    const bad = (text: string) => { B.problems++; out.problems++; cur.lines.push({ ok: false, text }); };
    const ok = (text: string) => cur.lines.push({ ok: true, text });
    const note = (text: string) => cur.lines.push({ ok: null, text });

    const mills = all<{ id: string; code: string; charge_config: string; opening_balance_paise: number }>("select id, code, charge_config, opening_balance_paise from merchants where business_id = ?", biz.id);
    const kOf = new Map<string, Katauti>();
    for (const m of mills) { const c = ChargeConfigSchema.safeParse(JSON.parse(m.charge_config)); kOf.set(m.id, c.success ? c.data.katauti : DEFAULT_K); }

    // 1. every slip re-worked: katauti, net, amount
    section("1. Slips (daily list)");
    type Slip = { id: string; rst_no: string; slip_date: string; adati_id: string; merchant_id: string | null; jins_id: string; gross_grams: number; katauti_units: number; katauti_override: number; net_grams: number; rate_paise_per_qtl: number; amount_paise: number; katauti_terms?: string | null; commission_paise?: number; gaushala_paise?: number; payable_paise?: number; supplier_terms?: string | null };
    const slips = all<Slip>("select * from purchase_slips where business_id = ?", biz.id);
    const disp = all<{ value: string }>("select value from settings where business_id = ? and key = 'display'", biz.id)[0];
    const bizK: Katauti = (() => {
      try {
        const d = JSON.parse(disp?.value ?? "{}");
        return { mode: d.katautiMode ?? DEFAULT_K.mode, kgPerUnit: d.katautiKgPerUnit ?? DEFAULT_K.kgPerUnit, rounding: d.katautiRounding ?? DEFAULT_K.rounding } as Katauti;
      } catch { return DEFAULT_K; }
    })();
    const termsOf = (s: { merchant_id: string | null; katauti_terms?: string | null }): Katauti => {
      if (s.katauti_terms) { try { return { ...DEFAULT_K, ...JSON.parse(s.katauti_terms) } as Katauti; } catch { /* fall through */ } }
      return s.merchant_id ? kOf.get(s.merchant_id) ?? DEFAULT_K : bizK;
    };
    let slipBad = 0;
    for (const s of slips) {
      const k = deriveKatauti(s.gross_grams, termsOf(s), s.katauti_override ? s.katauti_units : null);
      const net = s.gross_grams - k.deductionGrams;
      const amt = amountPaise(net, s.rate_paise_per_qtl);
      if (k.units !== s.katauti_units || net !== s.net_grams || amt !== s.amount_paise) {
        slipBad++;
        bad(`${s.slip_date} RST ${s.rst_no}: stored katauti ${s.katauti_units} net ${qt(s.net_grams)} amount ${rs(s.amount_paise)}; re-worked ${k.units} / ${qt(net)} / ${rs(amt)}`);
      }
    }
    if (!slipBad) ok(`${slips.length} slips: every katauti, net weight and amount re-works exactly`);
    // 1b. what each supplier adds — worked out here on its own, not with the app's code
    let chBad = 0;
    for (const s of slips) {
      let t = { commissionPct: 0, gaushalaPerQtl: 0 };
      try { t = { ...t, ...JSON.parse(s.supplier_terms ?? "{}") }; } catch { /* none */ }
      const priced = s.rate_paise_per_qtl > 0;
      const commission = priced ? Number((BigInt(s.amount_paise) * BigInt(Math.round(t.commissionPct * 1000)) + 50_000n) / 100_000n) : 0;
      const gaushala = priced ? Number((BigInt(s.net_grams) * BigInt(Math.round(t.gaushalaPerQtl * 1000)) + 500_000n) / 1_000_000n) : 0;
      const payable = s.amount_paise + commission + gaushala;
      if (commission !== (s.commission_paise ?? 0) || gaushala !== (s.gaushala_paise ?? 0) || payable !== (s.payable_paise ?? 0)) {
        chBad++;
        bad(`${s.slip_date} RST ${s.rst_no}: stored commission ${rs(s.commission_paise ?? 0)} gaushala ${rs(s.gaushala_paise ?? 0)} net amount ${rs(s.payable_paise ?? 0)}; re-worked ${rs(commission)} / ${rs(gaushala)} / ${rs(payable)}`);
      }
    }
    const sum = (k: "commission_paise" | "gaushala_paise" | "payable_paise") => slips.reduce((x, s) => x + (s[k] ?? 0), 0);
    if (!chBad) ok(`commission ₹${rs(sum("commission_paise"))} + gaushala ₹${rs(sum("gaushala_paise"))} re-work exactly; net amount ₹${rs(sum("payable_paise"))} = amount ₹${rs(slips.reduce((x, s) => x + s.amount_paise, 0))} + both`);
    const owedFor = (x: { amount_paise: number; payable_paise?: number }) => x.payable_paise ?? x.amount_paise;
    const unpriced = slips.filter((s) => !s.rate_paise_per_qtl);
    if (unpriced.length) note(`${unpriced.length} slip(s) have no rate yet and count as ₹0 until priced`);

    // 2. suppliers
    section("2. Supplier ledger (what we owe)");
    const sup = all<{ id: string; opening_balance_paise: number }>("select id, opening_balance_paise from adati where business_id = ?", biz.id);
    const pays = all<{ id: string; adati_id: string; pay_date: string; amount_paise: number; voided_at: number | null; voucher_no: number | null }>("select id, adati_id, pay_date, amount_paise, voided_at, voucher_no from payments where business_id = ?", biz.id);
    const opening = sup.reduce((s, a) => s + a.opening_balance_paise, 0);
    const purchases = slips.reduce((s, x) => s + owedFor(x), 0);
    const paid = pays.filter((p) => p.voided_at == null).reduce((s, p) => s + p.amount_paise, 0);
    const cancelled = pays.filter((p) => p.voided_at != null);
    const bal = sup.map((a) => a.opening_balance_paise + slips.filter((x) => x.adati_id === a.id).reduce((s, x) => s + owedFor(x), 0)
      - pays.filter((p) => p.adati_id === a.id && p.voided_at == null).reduce((s, p) => s + p.amount_paise, 0));
    const toPay = bal.filter((b) => b > 0).reduce((s, b) => s + b, 0);
    const ahead = bal.filter((b) => b < 0).reduce((s, b) => s - b, 0);
    ok(`opening ₹${rs(opening)} + purchases ₹${rs(purchases)} − paid ₹${rs(paid)} = ₹${rs(opening + purchases - paid)}`);
    ok(`= to pay ₹${rs(toPay)} − paid ahead ₹${rs(ahead)} (${bal.filter((b) => b < 0).length} supplier(s) paid ahead)`);
    if (opening + purchases - paid !== toPay - ahead) bad("supplier balances do not add up to the total");
    /* Two computers both given the same new name make two suppliers, and a
       trader's ledger then sits in two halves. Nothing is wrong with the
       money; it is the master that needs joining (Suppliers › Join). */
    const named = all<{ name_hi: string; n: number; ids: string }>(
      "select name_hi, count(*) as n, group_concat(id) as ids from adati where business_id = ? group by lower(trim(name_hi)) having count(*) > 1", biz.id);
    if (named.length) {
      note(`${named.length} name(s) belong to more than one supplier — join them on the Suppliers screen: ${named.map((x) => `${x.name_hi} (${x.n})`).join(", ")}`);
    } else {
      ok("every supplier name belongs to one supplier");
    }
    const orphanPays = pays.filter((p) => !sup.some((a) => a.id === p.adati_id));
    if (orphanPays.length) bad(`${orphanPays.length} payment(s) point at a supplier that is not in this business`);
    if (cancelled.length) note(`${cancelled.length} cancelled payment(s) of ₹${rs(cancelled.reduce((s, p) => s + p.amount_paise, 0))} kept on record, counted as nothing`);

    // 3. every approved parcha re-added from its frozen copy
    section("3. Kaccha parchas (what we billed)");
    const parchas = all<{ id: string; load_id: string; parcha_no: string; version: number; status: string; grand_total_paise: number; snapshot: string; invoice_date: string | null }>(
      "select id, load_id, parcha_no, version, status, grand_total_paise, snapshot, invoice_date from parchas where business_id = ?", biz.id);
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
    // one live parcha per truck; a number on two live parchas of one financial year is allowed (the owner
    // was warned when approving), so it is listed to look at, not counted as a fault
    const liveByLoad = new Map<string, number>();
    for (const p of approved) liveByLoad.set(p.load_id, (liveByLoad.get(p.load_id) ?? 0) + 1);
    for (const [loadId, n] of liveByLoad) if (n > 1) bad(`truck ${loadId.slice(-6)} has ${n} approved parchas at once`);
    const loadsByNo = new Map<string, Set<string>>();
    for (const p of approved) {
      const k = p.invoice_date ? fyNumberLabel(p.invoice_date, p.parcha_no) : p.parcha_no;
      if (!loadsByNo.has(k)) loadsByNo.set(k, new Set());
      loadsByNo.get(k)!.add(p.load_id);
    }
    for (const [no, set] of loadsByNo) if (set.size > 1) note(`parcha number ${no} is on ${set.size} live parchas of different trucks — allowed, check it is meant`);
    const billed = approved.reduce((s, p) => s + p.grand_total_paise, 0);
    if (!pBad) ok(`${approved.length} approved parcha(s): every row, charge, total and grand total re-adds exactly (${parchas.length - approved.length} voided kept aside)`);
    ok(`billed ₹${rs(billed)} = goods ₹${rs(goodsBilled)} + charges ₹${rs([...parts.values()].reduce((s, v) => s + v, 0))} + advance/rounding ₹${rs(billed - goodsBilled - [...parts.values()].reduce((s, v) => s + v, 0))}`);
    for (const [label, v] of parts) note(`${label}: ₹${rs(v)}`);

    // 4. mills
    section("4. Mill accounts (what mills owe us)");
    const loads = all<{ id: string; merchant_id: string; truck_no: string | null; mill_net_grams: number | null; mill_deduction_grams: number; status: string; load_date: string }>(
      "select id, merchant_id, truck_no, mill_net_grams, mill_deduction_grams, status, load_date from loads where business_id = ?", biz.id);
    const recs = all<{ id: string; merchant_id: string; receipt_date: string; amount_paise: number; deduction_paise: number; voided_at: number | null; voucher_no: number | null }>("select id, merchant_id, receipt_date, amount_paise, deduction_paise, voided_at, voucher_no from mill_receipts where business_id = ?", biz.id);
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
    const orphanRecs = recs.filter((x) => !mills.some((m) => m.id === x.merchant_id));
    if (orphanRecs.length) bad(`${orphanRecs.length} receipt(s) point at a mill that is not in this business`);
    if (!recs.length) note("no money from mills recorded yet — every approved parcha counts as still owed");

    // 5. stock: bought − loaded, per mill
    section("5. Stock (bought − loaded)");
    const lines = all<{ load_id: string; net_grams: number | null }>("select load_id, net_grams from load_lines where business_id = ?", biz.id);
    let stockValue = 0;
    for (const m of mills) {
      const bought = slips.filter((s) => s.merchant_id === m.id).reduce((s, x) => s + x.net_grams, 0);
      const priced = slips.filter((s) => s.merchant_id === m.id && s.rate_paise_per_qtl > 0);
      const pricedNet = priced.reduce((s, x) => s + x.net_grams, 0);
      const boughtValue = priced.reduce((s, x) => s + x.amount_paise, 0);
      let loaded = 0;
      for (const l of loads.filter((x) => x.merchant_id === m.id)) {
        const rows = lines.filter((x) => x.load_id === l.id);
        const typed = rows.filter((x) => x.net_grams != null).reduce((s, x) => s + x.net_grams!, 0);
        const blank = rows.filter((x) => x.net_grams == null).length;
        loaded += typed + (blank && l.mill_net_grams != null ? l.mill_net_grams - typed : 0);
      }
      if (!bought && !loaded) continue;
      const left = bought - loaded;
      const avg = pricedNet ? boughtValue / (pricedNet / 100_000) : 0;
      stockValue += Math.max(0, left) / 100_000 * avg;
      ok(`${m.code}: bought ${qt(bought)} − loaded ${qt(loaded)} = ${qt(left)} qtl left${left < 0 ? "  ← more loaded than bought" : ""}`);
    }
    const noMill = slips.filter((s) => !s.merchant_id);
    if (noMill.length) note(`${noMill.length} slip(s), ${qt(noMill.reduce((s, x) => s + x.net_grams, 0))} qtl, have no mill and sit in no mill's stock`);

    // 5b. records pointing at something that is gone
    const dangling = all<{ table: string; parent: string }>("pragma foreign_key_check");
    if (dangling.length) {
      const by = new Map<string, number>();
      for (const d of dangling) by.set(`${d.table} → ${d.parent}`, (by.get(`${d.table} → ${d.parent}`) ?? 0) + 1);
      note(`${dangling.length} record(s) point at something that is no longer there (${[...by].map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ""}`).join(", ")}). No figure above depends on them; they are usually a user or a master deleted long ago.`);
    }

    // 6. voucher numbers: every payment and receipt numbered once, in its year
    section("6. Voucher numbers");
    const dupes = (rows: { voucher_no: number | null; d: string }[]) => {
      const seen = new Map<string, number>();
      let missing = 0;
      for (const r of rows) { if (!r.voucher_no) { missing++; continue; } const k = `${fyOf(r.d)}|${r.voucher_no}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
      return { missing, twice: [...seen].filter(([, n]) => n > 1).map(([k]) => k.split("|")[1]) };
    };
    const pv = dupes(pays.map((p) => ({ voucher_no: p.voucher_no, d: p.pay_date })));
    const rv = dupes(recs.map((r) => ({ voucher_no: r.voucher_no, d: r.receipt_date })));
    if (pv.missing) bad(`${pv.missing} payment(s) have no voucher number`);
    if (pv.twice.length) bad(`payment voucher number(s) used twice in one year: PV-${pv.twice.join(", PV-")} (two computers saved offline — renumber one in Tally)`);
    if (rv.missing) bad(`${rv.missing} receipt(s) have no voucher number`);
    if (rv.twice.length) bad(`receipt voucher number(s) used twice in one year: RV-${rv.twice.join(", RV-")} (two computers saved offline — renumber one in Tally)`);
    if (!pv.missing && !pv.twice.length && !rv.missing && !rv.twice.length) ok(`${pays.length} payments and ${recs.length} receipts each carry one number, none repeated within a year`);

    // 7. where the money stands
    section("7. Money position");
    const unbilled = loads.filter((l) => l.status !== "billed").length;
    const cashIn = recs.filter((r) => r.voided_at == null).reduce((s, r) => s + r.amount_paise, 0);
    note(`mills owe us ₹${rs(owedTotal)}`);
    note(`we owe suppliers ₹${rs(opening + purchases - paid)}`);
    note(`stock in hand (at cost) ≈ ₹${rs(Math.round(stockValue))}`);
    note(`trucks not yet billed: ${unbilled}${unbilled ? " (their goods are not valued here; the dashboard adds them)" : ""}`);
    note(`cash from trade ₹${rs(cashIn - paid)} (in from mills ₹${rs(cashIn)} − out to suppliers ₹${rs(paid)})`);
    note(`net (mills owe + stock + cash − we owe) ≈ ₹${rs(Math.round(owedTotal + stockValue + cashIn - paid - (opening + purchases - paid)))}`);
  }
  return out;
}
