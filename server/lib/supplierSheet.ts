import ExcelJS from "exceljs";
import { SUPPLIER_SHEET_COLUMNS, type SupplierSheetColumnKey } from "./prefs.ts";
import { dmy } from "./parchaLabels.ts";
import { fmtQtl } from "./money.ts";

/* The supplier pay sheet, downloaded from the ledger: what is to be paid, one
   row per adati. "Till a date" lists every adati with something to pay on
   that date; "one day" lists every adati with slips that day — what the day's
   purchases put on his account, and what is to pay at the end of it.
   Every figure is the ledger's own sum (routes/accounts.ts); this file only
   lays them out, the same way the dara does (millReport.ts). */

export interface SupplierSheetRow {
  nameHi: string;
  nameLatin: string;
  village: string;
  slips: number;
  netGrams: number;
  /** Slips with no rate yet: their weight is counted, their money is 0. */
  unpriced: number;
  goodsPaise: number;
  commissionPaise: number;
  gaushalaPaise: number;
  /** goods + commission + gaushala: what the purchases put on his account. */
  payablePaise: number;
  /** Till a date: the opening balance. One day: what was to pay before the day. */
  beforePaise: number;
  paidPaise: number;
  /** before + payable − paid. Below zero means paid ahead. */
  toPayPaise: number;
}

export type SheetNames = "hi" | "hinglish" | "both";

export interface SupplierSheetData {
  mode: "till" | "day";
  date: string;
  /** "01-10-2026 14:05", by the office's own clock. */
  madeAt: string;
  businessName: string;
  names: SheetNames;
  columns: SupplierSheetColumnKey[];
  /** What Settings calls these three columns. */
  labels: { commission: string; gaushala: string; payable: string };
  rows: SupplierSheetRow[];
}

export function sheetTotals(rows: SupplierSheetRow[]) {
  const sum = (k: Exclude<keyof SupplierSheetRow, "nameHi" | "nameLatin" | "village">) => rows.reduce((s, r) => s + r[k], 0);
  return {
    count: rows.length,
    slips: sum("slips"),
    netGrams: sum("netGrams"),
    unpriced: sum("unpriced"),
    goodsPaise: sum("goodsPaise"),
    commissionPaise: sum("commissionPaise"),
    gaushalaPaise: sum("gaushalaPaise"),
    payablePaise: sum("payablePaise"),
    beforePaise: sum("beforePaise"),
    paidPaise: sum("paidPaise"),
    toPayPaise: sum("toPayPaise"),
  };
}
type Totals = ReturnType<typeof sheetTotals>;

/** One column of the file. Weights come as grams and money as paise; each format writes them its own way. */
interface Col {
  label: string;
  kind: "text" | "count" | "qtl" | "money";
  width: number;
  cell: (r: SupplierSheetRow) => string | number;
  total?: (t: Totals) => number;
}

const en = (k: SupplierSheetColumnKey) => SUPPLIER_SHEET_COLUMNS.find((c) => c.key === k)!.en;

function sheetColumns(d: SupplierSheetData): Col[] {
  const till = d.mode === "till";
  const out: Col[] = [];
  for (const k of d.columns) {
    switch (k) {
      case "name":
        if (d.names !== "hinglish") out.push({ label: d.names === "both" ? "Adati name (Hindi)" : en(k), kind: "text", width: 30, cell: (r) => r.nameHi });
        if (d.names !== "hi") out.push({ label: d.names === "both" ? "Adati name (Hinglish)" : en(k), kind: "text", width: 30, cell: (r) => r.nameLatin });
        break;
      case "village": out.push({ label: en(k), kind: "text", width: 16, cell: (r) => r.village }); break;
      case "slips": out.push({ label: en(k), kind: "count", width: 8, cell: (r) => r.slips, total: (t) => t.slips }); break;
      case "net": out.push({ label: en(k), kind: "qtl", width: 14, cell: (r) => r.netGrams, total: (t) => t.netGrams }); break;
      case "goods": out.push({ label: en(k), kind: "money", width: 15, cell: (r) => r.goodsPaise, total: (t) => t.goodsPaise }); break;
      case "commission": out.push({ label: d.labels.commission, kind: "money", width: 13, cell: (r) => r.commissionPaise, total: (t) => t.commissionPaise }); break;
      case "gaushala": out.push({ label: d.labels.gaushala, kind: "money", width: 12, cell: (r) => r.gaushalaPaise, total: (t) => t.gaushalaPaise }); break;
      case "payable": out.push({ label: d.labels.payable, kind: "money", width: 15, cell: (r) => r.payablePaise, total: (t) => t.payablePaise }); break;
      case "before": out.push({ label: till ? "Opening balance" : "Brought forward", kind: "money", width: 16, cell: (r) => r.beforePaise, total: (t) => t.beforePaise }); break;
      case "paid": out.push({ label: till ? en(k) : "Paid that day", kind: "money", width: 14, cell: (r) => r.paidPaise, total: (t) => t.paidPaise }); break;
      case "toPay": out.push({ label: till ? en(k) : "To pay (end of day)", kind: "money", width: 17, cell: (r) => r.toPayPaise, total: (t) => t.toPayPaise }); break;
    }
  }
  return out;
}

const title = (d: SupplierSheetData) => `Supplier pay sheet — ${d.mode === "till" ? `till ${dmy(d.date)}` : dmy(d.date)}`;
const made = (d: SupplierSheetData) => `Made on ${d.madeAt}`;

/** The lines under the total: why a weight has no money, and what a minus means. */
function notes(d: SupplierSheetData, t: Totals): string[] {
  const out: string[] = [];
  if (t.unpriced) out.push(`${t.unpriced} slip(s) have no rate yet: their weight is counted, their money is 0 until a rate is set.`);
  const minus = (d.columns.includes("toPay") && d.rows.some((r) => r.toPayPaise < 0))
    || (d.columns.includes("before") && d.rows.some((r) => r.beforePaise < 0));
  if (minus) out.push("A minus balance means paid ahead (to recover).");
  return out;
}

const q2 = (g: number) => Math.round(g / 1000) / 100;
const rs = (p: number) => Math.round(p) / 100;
/** Paise as "1234.50", worked in integers so the CSV is exact. */
const rupees = (p: number) => {
  const a = Math.abs(Math.round(p));
  return `${p < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

export async function supplierSheetXlsx(d: SupplierSheetData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mandi Mitra";
  const ws = wb.addWorksheet("Pay sheet", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols = sheetColumns(d);
  ws.columns = cols.map((c) => ({ width: c.width }));
  const last = String.fromCharCode(64 + cols.length);
  const thin = { style: "thin" as const, color: { argb: "FF999999" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const INR = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
  const fmt = (c: Col) => (c.kind === "money" ? INR : c.kind === "qtl" ? "0.00" : undefined);
  const num = (c: Col, v: string | number) => (typeof v !== "number" ? v : c.kind === "money" ? rs(v) : c.kind === "qtl" ? q2(v) : v);

  const head = [d.businessName.toUpperCase(), title(d), made(d)];
  head.forEach((text, i) => {
    if (cols.length > 1) ws.mergeCells(`A${i + 1}:${last}${i + 1}`);
    const c = ws.getCell(`A${i + 1}`);
    c.value = text;
    c.alignment = { horizontal: "center" };
    c.font = i === 0 ? { bold: true, size: 14 } : i === 1 ? { bold: true, size: 12 } : { size: 10, color: { argb: "FF666666" } };
  });

  const headerRow = ws.getRow(5);
  cols.forEach((col, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = col.label;
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    c.border = border;
    c.alignment = { horizontal: col.kind === "text" ? "left" : "right", wrapText: true };
  });

  d.rows.forEach((r, i) => {
    const row = ws.getRow(6 + i);
    cols.forEach((col, j) => {
      const c = row.getCell(j + 1);
      c.value = num(col, col.cell(r));
      c.border = border;
      const f = fmt(col);
      if (f) c.numFmt = f;
    });
  });

  const t = sheetTotals(d.rows);
  const totalRow = ws.getRow(6 + d.rows.length);
  cols.forEach((col, j) => {
    const c = totalRow.getCell(j + 1);
    c.border = border;
    c.font = { bold: true };
    if (j === 0) c.value = `Total (${t.count})`;
    else if (col.total) c.value = num(col, col.total(t));
    const f = fmt(col);
    if (f) c.numFmt = f;
  });
  notes(d, t).forEach((text, i) => { ws.getCell(`A${8 + d.rows.length + i}`).value = text; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function supplierSheetCsv(d: SupplierSheetData): string {
  const cols = sheetColumns(d);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const str = (c: Col, v: string | number) => (typeof v !== "number" ? v : c.kind === "money" ? rupees(v) : c.kind === "qtl" ? fmtQtl(v) : v);
  const t = sheetTotals(d.rows);
  const lines: (string | number)[][] = [
    [d.businessName.toUpperCase()],
    [title(d)],
    [made(d)],
    [],
    cols.map((c) => c.label),
    ...d.rows.map((r) => cols.map((c) => str(c, c.cell(r)))),
    cols.map((c, j) => (j === 0 ? `Total (${t.count})` : c.total ? str(c, c.total(t)) : "")),
  ];
  const n = notes(d, t);
  if (n.length) lines.push([], ...n.map((x) => [x]));
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}
