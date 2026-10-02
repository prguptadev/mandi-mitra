import { api, type Merchant, type SlipRow, type SlipTotals, type Jins } from "@/lib/api.ts";
import { DAILY_COLUMNS, MILL_REPORT_COLUMNS, type DailyColumnKey, type DailyListPrefs } from "@/lib/prefs.tsx";
import { defaultSupplierCharges, type SupplierCharges } from "@server/lib/supplierTerms.ts";
import { sortSlips, type SlipSortOrder } from "@server/lib/slipOrder.ts";
import { dmy } from "@server/lib/parchaLabels.ts";
import type { MillReportColumnKey } from "@server/lib/reportColumns.ts";
import { fmtQtl } from "@/lib/utils.ts";

/* One table that leaves the app — as a CSV file, as a preview on screen, or
   as a WhatsApp message. The daily list and the dara both come out as this,
   so the three always show the same figures. */

export interface ExportTable {
  /** "Daily list" or "Dara — <mill>": the first line of a message */
  title: string;
  /** the period, the mill, the commodity */
  sub: string;
  fileBase: string;
  header: string[];
  rows: (string | number)[][];
  /** total, average rate … */
  foot: (string | number)[][];
  /** the columns that hold numbers (right-aligned, padded from the left) */
  numeric: boolean[];
}

const q2 = (g: number) => (Math.round(g / 1000) / 100).toFixed(2);
const rs = (p: number) => (Math.round(p) / 100).toFixed(2);
const period = (from: string, to: string) => (from === to ? dmy(from) : `${dmy(from)} – ${dmy(to)}`);

export interface ListOpts {
  from: string; to: string; merchantId?: string; jinsId?: string;
  names: "hi" | "latin"; sort: SlipSortOrder; prefs: DailyListPrefs; mills: Merchant[]; jinsList?: Jins[];
}

const NUMERIC_LIST = new Set<string>(["sr", "gross", "katauti", "deduction", "net", "rate", "amount", "commission", "gaushala", "payable", "bagsCount"]);

/** The daily list with the columns set in the daily-list settings, and the total at the end. */
export async function buildListTable(o: ListOpts): Promise<ExportTable> {
  const qs = new URLSearchParams({ from: o.from, to: o.to, ...(o.merchantId ? { merchantId: o.merchantId } : {}), ...(o.jinsId ? { jinsId: o.jinsId } : {}) });
  const data = await api.get<{ rows: SlipRow[]; totals: SlipTotals }>(`/slips?${qs}`);
  const nameOf = (r: SlipRow) => (o.names === "latin" ? r.adatiNameHinglish || r.adatiNameHi : r.adatiNameHi);
  const rows = sortSlips(data.rows, o.sort, nameOf);
  const tot = data.totals;
  // the supplier-charge columns carry the names set in Settings
  const sc = await api.get<SupplierCharges>("/settings/supplier-charges").catch(() => defaultSupplierCharges());
  const named: Partial<Record<DailyColumnKey, string>> = { commission: sc.labels.commission, gaushala: sc.labels.gaushala, payable: sc.labels.payable };
  const P = o.prefs;

  // one "Adati name" column where either name column was chosen; a date column when several days
  type Col = { key: DailyColumnKey | "date" | "adati"; label: string };
  const cols: Col[] = [];
  for (const c of DAILY_COLUMNS) {
    if (c.key === "adatiLatin") continue;
    if (c.key === "adatiHi") {
      if (P.exportColumns.adatiHi !== false || P.exportColumns.adatiLatin !== false) cols.push({ key: "adati", label: "Adati name" });
      continue;
    }
    if (P.exportColumns[c.key] === false) continue;
    cols.push({ key: c.key, label: named[c.key] ?? c.en });
    if (c.key === "sr" && o.from !== o.to) cols.push({ key: "date", label: "Date" });
  }
  if (o.from !== o.to && !cols.some((c) => c.key === "date")) cols.unshift({ key: "date", label: "Date" });

  const val = (k: Col["key"], r: SlipRow, i: number): string | number => {
    switch (k) {
      case "sr": return i + 1;
      case "date": return dmy(r.slipDate);
      case "rstNo": return r.rstNo;
      case "adati": return nameOf(r);
      case "village": return r.adatiVillage ?? "";
      case "mill": return r.merchantCode ?? "";
      case "jins": return r.jinsCode;
      case "gross": return fmtQtl(r.grossGrams);
      case "katauti": return r.katautiUnits;
      case "deduction": return fmtQtl(r.katautiGrams);
      case "net": return fmtQtl(r.netGrams);
      case "rate": return r.ratePending ? "" : (r.ratePaisePerQtl / 100).toFixed(2);
      case "amount": return r.ratePending ? "" : (r.amountPaise / 100).toFixed(2);
      case "commission": return r.ratePending ? "" : (r.commissionPaise / 100).toFixed(2);
      case "gaushala": return r.ratePending ? "" : (r.gaushalaPaise / 100).toFixed(2);
      case "payable": return r.ratePending ? "" : (r.payablePaise / 100).toFixed(2);
      case "bagsCount": return r.bagsCount ?? "";
      case "status": return r.status;
      default: return "";
    }
  };
  const totalVal = (k: Col["key"]): string | number => {
    switch (k) {
      case "rstNo": return "TOTAL";
      case "gross": return fmtQtl(tot.grossGrams);
      case "katauti": return tot.katautiUnits;
      case "deduction": return fmtQtl(tot.katautiGrams);
      case "net": return fmtQtl(tot.netGrams);
      case "rate": return (tot.weightedAvgRatePaise / 100).toFixed(2);
      case "amount": return (tot.amountPaise / 100).toFixed(2);
      case "commission": return (tot.commissionPaise / 100).toFixed(2);
      case "gaushala": return (tot.gaushalaPaise / 100).toFixed(2);
      case "payable": return (tot.payablePaise / 100).toFixed(2);
      case "bagsCount": return tot.bagsCount || "";
      default: return "";
    }
  };
  // the total's label goes in the first text column when RST is not shown
  const foot = cols.map((c) => totalVal(c.key));
  if (!cols.some((c) => c.key === "rstNo")) {
    const i = cols.findIndex((c) => !NUMERIC_LIST.has(c.key));
    if (i >= 0) foot[i] = "TOTAL";
  }
  const mill = o.mills.find((m) => m.id === o.merchantId);
  const jins = o.jinsList?.find((j) => j.id === o.jinsId);
  return {
    title: "Daily list",
    sub: [period(o.from, o.to), mill?.code, jins?.code].filter(Boolean).join(" · "),
    fileBase: `daily-list-${o.from}${o.from === o.to ? "" : `-to-${o.to}`}${mill ? "-" + mill.code : ""}`,
    header: cols.map((c) => c.label),
    rows: rows.map((r, i) => cols.map((c) => val(c.key, r, i))),
    foot: [foot],
    numeric: cols.map((c) => NUMERIC_LIST.has(c.key)),
  };
}

export interface DaraOpts {
  merchantId: string; from: string; to: string; names: "hi" | "latin"; sort: SlipSortOrder; columns: string[]; jinsId?: string;
}
interface DaraJson {
  from: string; to: string; businessName: string; millName: string; jinsLabel: string | null; columns: MillReportColumnKey[];
  rows: { slipDate: string; rstNo: string; adati: string; village: string; jinsCode: string; grossGrams: number; katautiUnits: number; netGrams: number;
    ratePaisePerQtl: number; amountPaise: number; commissionPaise: number; gaushalaPaise: number; payablePaise: number; bagsCount: number | null }[];
  totals: { count: number; grossGrams: number; katautiUnits: number; netGrams: number; amountPaise: number; commissionPaise: number; gaushalaPaise: number;
    payablePaise: number; bagsCount: number; avgRatePaisePerQtl: number; unpriced: number };
}
const NUMERIC_DARA = new Set<string>(["sr", "gross", "katauti", "deduction", "net", "rate", "amount", "commission", "gaushala", "payable", "bags"]);

/** The dara for one mill, the same rows and totals the Excel/CSV file carries. */
export async function buildDaraTable(o: DaraOpts): Promise<ExportTable> {
  const qs = new URLSearchParams({
    merchantId: o.merchantId, from: o.from, to: o.to, names: o.names, sort: o.sort, format: "json",
    ...(o.jinsId ? { jinsId: o.jinsId } : {}), ...(o.columns.length ? { cols: o.columns.join(",") } : {}),
  });
  const d = await api.get<DaraJson>(`/reports/mill?${qs}`);
  const cols = d.columns;
  const label = (k: MillReportColumnKey) => MILL_REPORT_COLUMNS.find((c) => c.key === k)?.en ?? k;
  const cell = (k: MillReportColumnKey, r: DaraJson["rows"][number], i: number): string | number => {
    switch (k) {
      case "sr": return i + 1;
      case "date": return dmy(r.slipDate);
      case "rstNo": return r.rstNo;
      case "adati": return r.adati;
      case "village": return r.village;
      case "jins": return r.jinsCode;
      case "gross": return q2(r.grossGrams);
      case "katauti": return r.katautiUnits;
      case "deduction": return q2(r.grossGrams - r.netGrams);
      case "net": return q2(r.netGrams);
      case "rate": return r.ratePaisePerQtl ? rs(r.ratePaisePerQtl) : "";
      case "amount": return r.ratePaisePerQtl ? rs(r.amountPaise) : "";
      case "commission": return r.ratePaisePerQtl ? rs(r.commissionPaise) : "";
      case "gaushala": return r.ratePaisePerQtl ? rs(r.gaushalaPaise) : "";
      case "payable": return r.ratePaisePerQtl ? rs(r.payablePaise) : "";
      case "bags": return r.bagsCount ?? "";
      default: return "";
    }
  };
  const t = d.totals;
  const lab = cols.find((k) => k === "adati" || k === "rstNo" || k === "date" || k === "sr") ?? cols[0];
  const total = cols.map((k) => k === lab ? `Total (${t.count})` : k === "gross" ? fmtQtl(t.grossGrams)
    : k === "katauti" ? t.katautiUnits : k === "deduction" ? fmtQtl(t.grossGrams - t.netGrams) : k === "net" ? fmtQtl(t.netGrams)
    : k === "amount" ? rs(t.amountPaise) : k === "commission" ? rs(t.commissionPaise)
    : k === "gaushala" ? rs(t.gaushalaPaise) : k === "payable" ? rs(t.payablePaise) : k === "bags" ? t.bagsCount : "");
  const avg = cols.map((k) => k === lab ? "Average rate" : k === "rate" ? rs(t.avgRatePaisePerQtl) : "");
  if (!cols.includes("rate")) avg[cols.indexOf(lab)] = `Average rate ${rs(t.avgRatePaisePerQtl)}`;
  const millCode = /^[A-Z0-9]+$/.test(d.millName) ? d.millName : d.millName;
  return {
    title: `Dara — ${d.millName.toUpperCase()}`,
    sub: [d.businessName.toUpperCase(), period(d.from, d.to), d.jinsLabel].filter(Boolean).join(" · "),
    fileBase: `dara-${millCode.replace(/\s+/g, "-")}-${d.from}${d.from === d.to ? "" : `-to-${d.to}`}`,
    header: cols.map(label),
    rows: d.rows.map((r, i) => cols.map((k) => cell(k, r, i))),
    foot: [total, avg],
    numeric: cols.map((k) => NUMERIC_DARA.has(k)),
  };
}

/** The table as CSV text (with a BOM so Excel reads Hindi). */
export function csvOf(t: ExportTable, heading = false): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines: (string | number)[][] = [
    ...(heading ? [[t.title], [t.sub], []] : []),
    t.header, ...t.rows, ...t.foot,
  ];
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}

/* A WhatsApp message: bold title, the period, then the table in a fixed-width
   block so the columns line up on a phone. Long names are cut, and only as
   many rows as one message can carry are sent; the CSV has all of them. */
export function whatsappText(t: ExportTable, maxChars = 3_500): { text: string; cut: number } {
  // a column nobody filled (village on a day when no village was written) only
  // takes width on a phone: the CSV keeps every column, the message drops it
  const keep = t.header.map((_, i) => [...t.rows, ...t.foot].some((r) => String(r[i] ?? "").trim() !== ""));
  const at = <T,>(r: T[]) => r.filter((_, i) => keep[i]);
  const numeric = at(t.numeric);
  const cell = (v: string | number, i: number) => {
    const s = String(v ?? "");
    return !numeric[i] && s.length > 16 ? s.slice(0, 15) + "…" : s;
  };
  const body = [at(t.header), ...t.rows.map(at), ...t.foot.map(at)].map((r) => r.map(cell));
  const widths = body[0].map((_, i) => Math.max(...body.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((s, i) => (numeric[i] ? s.padStart(widths[i]) : s.padEnd(widths[i]))).join("  ").trimEnd();
  const rule = "-".repeat(Math.min(widths.reduce((a, w) => a + w + 2, -2), 60));
  const head = `*${t.title}*\n${t.sub}\n`;
  const make = (n: number) => {
    const rows = body.slice(1, 1 + n).map(line);
    const foot = body.slice(1 + t.rows.length).map(line);
    const more = n < t.rows.length ? `\n_+${t.rows.length - n} more rows in the CSV_` : "";
    return `${head}\`\`\`\n${[line(body[0]), ...rows, rule, ...foot].join("\n")}\n\`\`\`${more}`;
  };
  let n = t.rows.length;
  let text = make(n);
  while (text.length > maxChars && n > 1) { n = Math.max(1, Math.floor(n * 0.8)); text = make(n); }
  return { text, cut: t.rows.length - n };
}

/** "9876543210" -> "919876543210"; anything else is kept as its digits. */
export function whatsappNumber(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return "91" + d;
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
  return d;
}

export function whatsappLink(phone: string, text: string): string {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
