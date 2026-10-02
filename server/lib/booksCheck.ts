import type Database from "better-sqlite3";
import { amountPaise, divHalfUp } from "./money.ts";
import { deriveKatauti, type Katauti } from "./charges.ts";
import type { ParchaDoc } from "./parcha.ts";
import { rstKey, dayGap, RST_WINDOW_DAYS } from "./slipChecks.ts";
import { fyNumberLabel } from "./parchaLabels.ts";

/* An independent audit of every rupee and quintal, read-only. It does not
   use the app's routes or its stored totals: each figure is re-worked from
   the raw rows and anything that disagrees is named. The Audit screen runs
   it on the live books; scripts/money-check.ts runs it on a copy. */

/** ok: true = re-works, false = a figure that does not (a problem), null = a note.
 *  A note with `warn` is something a person should look at: it is not an
 *  arithmetic error, so it does not count as a problem, but it is never a tick. */
export interface CheckLine { ok: boolean | null; text: string; warn?: boolean }
export interface CheckSection { title: string; lines: CheckLine[] }
export interface BusinessCheck { businessId: string; name: string; sections: CheckSection[]; problems: number; warnings: number }
export interface BooksCheck { businesses: BusinessCheck[]; problems: number; warnings: number; at: number }

const rs = (p: number) => ((p || 0) / 100 + 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qt = (g: number) => (g / 100_000).toFixed(2);
const DEFAULT_K: Katauti = { mode: "per_quintal_rounded", kgPerUnit: 1, rounding: "half_up" } as Katauti;
const fyOf = (iso: string) => { const y = Number(iso.slice(0, 4)); return Number(iso.slice(5, 7)) >= 4 ? y : y - 1; };
const dm = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** A long list is named in part: the screen has the rest. */
const some = (items: string[], n = 15) => items.slice(0, n).join("; ") + (items.length > n ? `; and ${items.length - n} more` : "");

export function checkBooks(db: Database.Database, onlyBusiness?: string): BooksCheck {
  const all = <T,>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const out: BooksCheck = { businesses: [], problems: 0, warnings: 0, at: Math.floor(Date.now() / 1000) };
  const bizList = all<{ id: string; name: string }>("select id, name from businesses" + (onlyBusiness ? " where id = ?" : ""), ...(onlyBusiness ? [onlyBusiness] : []));

  for (const biz of bizList) {
    const B: BusinessCheck = { businessId: biz.id, name: biz.name, sections: [], problems: 0, warnings: 0 };
    out.businesses.push(B);
    let cur: CheckSection = { title: "", lines: [] };
    const section = (title: string) => { cur = { title, lines: [] }; B.sections.push(cur); };
    const bad = (text: string) => { B.problems++; out.problems++; cur.lines.push({ ok: false, text }); };
    const ok = (text: string) => cur.lines.push({ ok: true, text });
    const note = (text: string) => cur.lines.push({ ok: null, text });
    const look = (text: string) => { B.warnings++; out.warnings++; cur.lines.push({ ok: null, warn: true, text }); };

    const mills = all<{ id: string; code: string; charge_config: string; opening_balance_paise: number }>("select id, code, charge_config, opening_balance_paise from merchants where business_id = ?", biz.id);

    // 1. every slip re-worked: katauti, net, amount
    section("1. Slips (daily list)");
    type Slip = { id: string; rst_no: string; slip_date: string; adati_id: string; merchant_id: string | null; jins_id: string; gross_grams: number; katauti_units: number; katauti_override: number; net_grams: number; rate_paise_per_qtl: number; amount_paise: number; katauti_terms?: string | null; commission_paise?: number; gaushala_paise?: number; payable_paise?: number; supplier_terms?: string | null };
    const slips = all<Slip>("select * from purchase_slips where business_id = ?", biz.id);
    /* A slip is worked out on the terms it carries. One that carries none (a
       no-mill slip from before v0.3) was never on today's settings: its
       katauti and net are taken as stored, and only its amount is re-worked. */
    const termsOf = (s: { katauti_terms?: string | null }): Katauti | null => {
      if (s.katauti_terms) { try { return { ...DEFAULT_K, ...JSON.parse(s.katauti_terms) } as Katauti; } catch { /* none readable */ } }
      return null;
    };
    let slipBad = 0;
    for (const s of slips) {
      const terms = termsOf(s);
      const k = terms ? deriveKatauti(s.gross_grams, terms, s.katauti_override ? s.katauti_units : null) : { units: s.katauti_units, deductionGrams: s.gross_grams - s.net_grams };
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
      let carried = Boolean(s.supplier_terms);
      try { t = { ...t, ...JSON.parse(s.supplier_terms ?? "{}") }; } catch { carried = false; }
      const priced = s.rate_paise_per_qtl > 0;
      // the terms to 4 decimals, as Settings keeps them (0.6667 %, ₹0.0625 a quintal); a slip carrying none keeps its stored charges, and its sum is checked
      const commission = !carried ? s.commission_paise ?? 0 : priced ? Number((BigInt(s.amount_paise) * BigInt(Math.round(t.commissionPct * 10_000)) + 500_000n) / 1_000_000n) : 0;
      const gaushala = !carried ? s.gaushala_paise ?? 0 : priced ? Number((BigInt(s.net_grams) * BigInt(Math.round(t.gaushalaPerQtl * 10_000)) + 5_000_000n) / 10_000_000n) : 0;
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
    /* 1c. the same weighbridge slip on the books twice. RST numbers repeat, so
       across dates only the same RST with the same gross weight counts — the
       same sheet entered again. Each is for a person to open, not an error. */
    {
      const supplierOf = new Map(all<{ id: string; name_hi: string }>("select id, name_hi from adati where business_id = ?", biz.id).map((a) => [a.id, a.name_hi]));
      const byDay = new Map<string, Slip[]>();
      const byWeight = new Map<string, Slip[]>();
      for (const s of slips) {
        const k = rstKey(s.rst_no);
        const dk = `${s.slip_date}|${k}`;
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk)!.push(s);
        const wk = `${k}|${s.gross_grams}`;
        if (!byWeight.has(wk)) byWeight.set(wk, []);
        byWeight.get(wk)!.push(s);
      }
      const sameDay = [...byDay.values()].filter((g) => g.length > 1)
        .sort((a, b) => b[0].slip_date.localeCompare(a[0].slip_date))
        .map((g) => `${dm(g[0].slip_date)} RST ${g[0].rst_no} ×${g.length}`);
      if (sameDay.length) look(`${sameDay.length} RST number(s) appear more than once on one day — open the daily list and check none is entered twice: ${some(sameDay)}`);
      // dates within 30 days of each other, one group per run of dates
      const twice: string[] = [];
      for (const g of byWeight.values()) {
        const dates = [...new Set(g.map((s) => s.slip_date))].sort();
        if (dates.length < 2) continue;
        const near = dates.filter((d, i) => (i > 0 && dayGap(dates[i - 1], d) <= RST_WINDOW_DAYS) || (i < dates.length - 1 && dayGap(d, dates[i + 1]) <= RST_WINDOW_DAYS));
        if (near.length < 2) continue;
        const names = new Set(g.filter((s) => near.includes(s.slip_date)).map((s) => supplierOf.get(s.adati_id) ?? s.adati_id));
        twice.push(`RST ${g[0].rst_no} ${qt(g[0].gross_grams)} qtl on ${near.map(dm).join(", ")}${names.size > 1 ? ` (${names.size} different suppliers)` : ""}`);
      }
      if (twice.length) look(`${twice.length} slip(s) have the same RST and the same weight on two or more dates — likely one sheet entered twice; check before paying: ${some(twice.sort())}`);
      else ok("no RST is on the books twice with the same weight on another date");
    }

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
    /* 3b. each truck in step with its parcha. A truck and its parcha are
       separate records, and two computers can settle them apart: a draft
       truck beside a live parcha is counted both unbilled and owed, a billed
       one with none is locked and owed nothing, and a stored net other than
       the billed one puts stock off by the difference. */
    {
      const trucks = all<{ id: string; truck_no: string | null; load_date: string; status: string; mill_net_grams: number | null }>(
        "select id, truck_no, load_date, status, mill_net_grams from loads where business_id = ?", biz.id);
      const liveOf = new Map(approved.map((p) => [p.load_id, p]));
      const named = (l: { id: string; truck_no: string | null; load_date: string }) => `${l.truck_no ?? `truck ${l.id.slice(-6)}`} of ${dm(l.load_date)}`;
      const draftLive = trucks.filter((l) => l.status !== "billed" && liveOf.has(l.id));
      const billedNone = trucks.filter((l) => l.status === "billed" && !liveOf.has(l.id));
      const netOff: string[] = [];
      for (const l of trucks) {
        const p = liveOf.get(l.id);
        const billedNet = p ? (JSON.parse(p.snapshot) as ParchaDoc).weights?.netGrams : undefined;
        if (typeof billedNet === "number" && l.mill_net_grams !== billedNet) {
          netOff.push(`${named(l)}: stored ${l.mill_net_grams == null ? "none" : qt(l.mill_net_grams)}, parcha #${p!.parcha_no} billed ${qt(billedNet)} qtl`);
        }
      }
      if (draftLive.length) bad(`${draftLive.length} draft truck(s) have a live parcha, so they count both as unbilled and as owed by the mill: ${some(draftLive.map((l) => `${named(l)} (#${liveOf.get(l.id)!.parcha_no})`))}`);
      if (billedNone.length) bad(`${billedNone.length} truck(s) are marked billed but have no live parcha, so they are locked and the mill owes nothing for them: ${some(billedNone.map(named))}`);
      if (netOff.length) bad(`${netOff.length} truck(s) store a net weight other than what their parcha billed, so stock is off by the difference: ${some(netOff)}`);
      if (!draftLive.length && !billedNone.length && !netOff.length) ok(`${trucks.length} truck(s): each is billed exactly when it has a live parcha, and stores the net that parcha billed`);
    }

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

    // 5. stock: bought − loaded, per mill, then per mill, commodity and purchase day
    section("5. Stock (bought − loaded)");
    const lines = all<{ id: string; load_id: string; jins_id: string; stock_date: string; net_grams: number | null; rate_paise_per_qtl: number | null }>(
      "select id, load_id, jins_id, stock_date, net_grams, rate_paise_per_qtl from load_lines where business_id = ? order by sort, created_at", biz.id);
    /* Each truck row's weight: typed, or for the one blank row whatever the
       mill's net leaves after the typed rows (the rest get nothing). */
    const weightOf = new Map<string, number>();
    const linesOf = new Map<string, typeof lines>();
    for (const x of lines) { if (!linesOf.has(x.load_id)) linesOf.set(x.load_id, []); linesOf.get(x.load_id)!.push(x); }
    for (const l of loads) {
      const rows = linesOf.get(l.id) ?? [];
      const typed = rows.reduce((s, x) => s + (x.net_grams ?? 0), 0);
      let restGiven = false;
      for (const x of rows) {
        if (x.net_grams != null) weightOf.set(x.id, x.net_grams);
        else if (!restGiven && l.mill_net_grams != null) { restGiven = true; weightOf.set(x.id, l.mill_net_grams - typed); }
        else weightOf.set(x.id, 0);
      }
    }
    const loadOf = new Map(loads.map((l) => [l.id, l]));
    for (const m of mills) {
      const bought = slips.filter((s) => s.merchant_id === m.id).reduce((s, x) => s + x.net_grams, 0);
      const loaded = lines.filter((x) => loadOf.get(x.load_id)?.merchant_id === m.id).reduce((s, x) => s + (weightOf.get(x.id) ?? 0), 0);
      if (!bought && !loaded) continue;
      const left = bought - loaded;
      if (left < 0) look(`${m.code}: bought ${qt(bought)} − loaded ${qt(loaded)} = ${qt(left)} qtl — more loaded than bought: a slip is missing from the daily list, or a truck took another mill's goods`);
      else ok(`${m.code}: bought ${qt(bought)} − loaded ${qt(loaded)} = ${qt(left)} qtl left`);
    }
    const noMill = slips.filter((s) => !s.merchant_id);
    if (noMill.length) note(`${noMill.length} slip(s), ${qt(noMill.reduce((s, x) => s + x.net_grams, 0))} qtl, have no mill: the firm's own stock, counted in the stock value below`);
    /* Valued the way the dashboard's money card values it, so both screens tell
       one story: every purchase day (mill, commodity, date — no-mill slips
       included) keeps what no truck has taken, at that day's own weighted
       average, in whole paise. A day trucks took more from counts below zero. */
    const dayKey = (m: string | null, j: string, d: string) => `${m ?? "-"}|${j}|${d}`;
    const days = new Map<string, { m: string | null; j: string; d: string; net: number; pricedNet: number; value: bigint }>();
    for (const s of slips) {
      const k = dayKey(s.merchant_id, s.jins_id, s.slip_date);
      const g = days.get(k) ?? { m: s.merchant_id, j: s.jins_id, d: s.slip_date, net: 0, pricedNet: 0, value: 0n };
      g.net += s.net_grams;
      if (s.rate_paise_per_qtl > 0) { g.pricedNet += s.net_grams; g.value += BigInt(s.net_grams) * BigInt(s.rate_paise_per_qtl); }
      days.set(k, g);
    }
    const dayAvg = (k: string) => { const g = days.get(k); return g && g.pricedNet ? Number(divHalfUp(g.value, BigInt(g.pricedNet))) : 0; };
    const taken = new Map<string, number>();
    for (const x of lines) {
      const l = loadOf.get(x.load_id);
      if (!l) continue;
      const k = dayKey(l.merchant_id, x.jins_id, x.stock_date);
      taken.set(k, (taken.get(k) ?? 0) + (weightOf.get(x.id) ?? 0));
    }
    const millCode = (id: string | null) => mills.find((m) => m.id === id)?.code ?? "no mill";
    const jinsCode = new Map(all<{ id: string; code: string }>("select id, code from jins where business_id = ?", biz.id).map((j) => [j.id, j.code]));
    let stockValue = 0, stockLeft = 0, unpricedLeft = 0;
    const over: string[] = [];
    for (const k of new Set([...days.keys(), ...taken.keys()])) {
      const g = days.get(k);
      const bought = g?.net ?? 0;
      const left = bought - (taken.get(k) ?? 0);
      if (left < 0) {
        const [m, j, d] = k.split("|");
        over.push(`${millCode(m === "-" ? null : m)} ${jinsCode.get(j) ?? ""} ${dm(d)}: bought ${qt(bought)}, taken ${qt(bought - left)} (${qt(-left)} over)`);
      }
      if (!g || left === 0) continue;
      stockLeft += left;
      if (!g.pricedNet) { unpricedLeft += left; continue; }
      stockValue += amountPaise(left, dayAvg(k));
    }
    /* A truck row taken from a day with no slips under that mill (it is named
       above) is stock gone out that was never counted in: take each row off,
       at its own typed rate, else as unpriced — as the dashboard does — or the
       same goods would count again among the unbilled trucks or the bills. */
    for (const x of lines) {
      const l = loadOf.get(x.load_id);
      const w = weightOf.get(x.id) ?? 0;
      if (!l || !w || days.has(dayKey(l.merchant_id, x.jins_id, x.stock_date))) continue;
      stockLeft -= w;
      if (x.rate_paise_per_qtl) stockValue -= amountPaise(w, x.rate_paise_per_qtl);
      else unpricedLeft -= w;
    }
    if (over.length) look(`${over.length} purchase day(s) trucks took more from than was bought — check the trucks' purchase days: ${some(over.sort().reverse())}`);
    ok(`stock in hand ${qt(stockLeft)} qtl, valued ₹${rs(stockValue)} at each purchase day's own average rate${unpricedLeft ? ` (${qt(unpricedLeft)} qtl of it has no rate yet and is valued at ₹0)` : ""}`);
    // trucks loaded but not billed yet: their goods, at the row's own rate or the purchase day's average
    const drafts = loads.filter((l) => l.status !== "billed");
    const unbilledGoods = drafts.reduce((s, l) => s + (linesOf.get(l.id) ?? [])
      .reduce((t, x) => t + amountPaise(weightOf.get(x.id) ?? 0, x.rate_paise_per_qtl ?? dayAvg(dayKey(l.merchant_id, x.jins_id, x.stock_date))), 0), 0);
    if (drafts.length) note(`${drafts.length} truck(s) loaded but not billed yet carry goods of ₹${rs(unbilledGoods)}`);

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

    // 7. where the money stands — the same parts, worked the same way, as the dashboard's money card
    section("7. Money position");
    const cashIn = recs.filter((r) => r.voided_at == null).reduce((s, r) => s + r.amount_paise, 0);
    const weOwe = opening + purchases - paid;
    note(`mills owe us ₹${rs(owedTotal)}`);
    note(`we owe suppliers ₹${rs(weOwe)}`);
    note(`stock in hand ₹${rs(stockValue)} (${qt(stockLeft)} qtl, each purchase day at its own average)`);
    note(`trucks not yet billed: ${drafts.length}, goods ₹${rs(unbilledGoods)}`);
    note(`cash from trade ₹${rs(cashIn - paid)} (in from mills ₹${rs(cashIn)} − out to suppliers ₹${rs(paid)})`);
    note(`net (mills owe + stock + unbilled trucks + cash − we owe) = ₹${rs(owedTotal + stockValue + unbilledGoods + cashIn - paid - weOwe)} — the dashboard's net position`);
  }
  return out;
}
