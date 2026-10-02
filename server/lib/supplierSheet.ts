import ExcelJS from "exceljs";
import { SUPPLIER_SHEET_COLUMNS, type SupplierSheetColumnKey } from "./prefs.ts";
import { dmy } from "./parchaLabels.ts";
import { fmtQtl } from "./money.ts";

/* The supplier pay sheet, downloaded from the ledger: one row per adati, what
   his purchases in the period came to and what is left to pay him at its end.
     line 1  the business name
     line 2  the period: "01-04-2026 to 02-10-2026", or "02-10-2026" for one day
     then    the table, its total, and a note or two
   Every figure is the ledger list's own sum (routes/accounts.ts, ledgerList,
   asked for the same period); this file only lays them out. */

export interface SupplierSheetRow {
  nameHi: string;
  nameLatin: string;
  slips: number;
  netGrams: number;
  /** Slips with no rate yet: their weight is counted, their money is 0. */
  unpriced: number;
  goodsPaise: number;
  commissionPaise: number;
  gaushalaPaise: number;
  /** Net amount: goods + commission + gaushala, for the period — the ledger's "purchases". */
  payablePaise: number;
  /** Paid in the period. */
  paidPaise: number;
  /** Left to pay at the period's end: the ledger balance, never below zero. */
  toPayPaise: number;
}

export type SheetNames = "hi" | "hinglish" | "both";

export interface SupplierSheetData {
  mode: "till" | "day" | "range";
  /** The period, both ends counted. Till date: 1 April of that financial year to the date. */
  from: string;
  to: string;
  businessName: string;
  names: SheetNames;
  columns: SupplierSheetColumnKey[];
  /** What Settings calls these three columns. */
  labels: { commission: string; gaushala: string; payable: string };
  rows: SupplierSheetRow[];
  /** Lines under the total, worked out by the route: slips with no rate, who is paid ahead. */
  notes: string[];
}

export function sheetTotals(rows: SupplierSheetRow[]) {
  const sum = (k: Exclude<keyof SupplierSheetRow, "nameHi" | "nameLatin">) => rows.reduce((s, r) => s + r[k], 0);
  return {
    count: rows.length,
    slips: sum("slips"),
    netGrams: sum("netGrams"),
    unpriced: sum("unpriced"),
    goodsPaise: sum("goodsPaise"),
    commissionPaise: sum("commissionPaise"),
    gaushalaPaise: sum("gaushalaPaise"),
    payablePaise: sum("payablePaise"),
    paidPaise: sum("paidPaise"),
    toPayPaise: sum("toPayPaise"),
  };
}
type Totals = ReturnType<typeof sheetTotals>;

/** "01-04-2026 to 02-10-2026", or the one date. */
export const sheetPeriod = (d: Pick<SupplierSheetData, "from" | "to">) => (d.from === d.to ? dmy(d.to) : `${dmy(d.from)} to ${dmy(d.to)}`);

/** One column of the file. Weights come as grams and money as paise; each format writes them its own way. */
interface Col {
  label: string;
  kind: "text" | "qtl" | "money";
  width: number;
  cell: (r: SupplierSheetRow) => string | number;
  total?: (t: Totals) => number;
}

const en = (k: SupplierSheetColumnKey) => SUPPLIER_SHEET_COLUMNS.find((c) => c.key === k)!.en;

function sheetColumns(d: SupplierSheetData): Col[] {
  const out: Col[] = [];
  for (const k of d.columns) {
    switch (k) {
      case "name":
        if (d.names !== "hinglish") out.push({ label: d.names === "both" ? "Adati name (Hindi)" : en(k), kind: "text", width: 30, cell: (r) => r.nameHi });
        if (d.names !== "hi") out.push({ label: d.names === "both" ? "Adati name (Hinglish)" : en(k), kind: "text", width: 30, cell: (r) => r.nameLatin });
        break;
      case "net": out.push({ label: en(k), kind: "qtl", width: 14, cell: (r) => r.netGrams, total: (t) => t.netGrams }); break;
      case "goods": out.push({ label: en(k), kind: "money", width: 15, cell: (r) => r.goodsPaise, total: (t) => t.goodsPaise }); break;
      case "commission": out.push({ label: d.labels.commission, kind: "money", width: 13, cell: (r) => r.commissionPaise, total: (t) => t.commissionPaise }); break;
      case "gaushala": out.push({ label: d.labels.gaushala, kind: "money", width: 12, cell: (r) => r.gaushalaPaise, total: (t) => t.gaushalaPaise }); break;
      case "payable": out.push({ label: d.labels.payable, kind: "money", width: 16, cell: (r) => r.payablePaise, total: (t) => t.payablePaise }); break;
      case "paid": out.push({ label: en(k), kind: "money", width: 14, cell: (r) => r.paidPaise, total: (t) => t.paidPaise }); break;
      // what remains to be paid as at the sheet's last day — said with its date, so a past day's sheet is not read as today's
      case "toPay": out.push({ label: `${en(k)} on ${dmy(d.to)}`, kind: "money", width: 18, cell: (r) => r.toPayPaise, total: (t) => t.toPayPaise }); break;
    }
  }
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

  // the business name and the period, each centred across the whole table
  [d.businessName.toUpperCase(), sheetPeriod(d)].forEach((text, i) => {
    if (cols.length > 1) ws.mergeCells(`A${i + 1}:${last}${i + 1}`);
    const c = ws.getCell(`A${i + 1}`);
    c.value = text;
    c.alignment = { horizontal: "center" };
    c.font = i === 0 ? { bold: true, size: 14 } : { bold: true, size: 11 };
  });

  const headerRow = ws.getRow(3);
  cols.forEach((col, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = col.label;
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    c.border = border;
    c.alignment = { horizontal: col.kind === "text" ? "left" : "right", wrapText: true };
  });

  d.rows.forEach((r, i) => {
    const row = ws.getRow(4 + i);
    cols.forEach((col, j) => {
      const c = row.getCell(j + 1);
      c.value = num(col, col.cell(r));
      c.border = border;
      const f = fmt(col);
      if (f) c.numFmt = f;
    });
  });

  const t = sheetTotals(d.rows);
  const totalRow = ws.getRow(4 + d.rows.length);
  cols.forEach((col, j) => {
    const c = totalRow.getCell(j + 1);
    c.border = border;
    c.font = { bold: true };
    if (j === 0) c.value = `Total (${t.count})`;
    else if (col.total) c.value = num(col, col.total(t));
    const f = fmt(col);
    if (f) c.numFmt = f;
  });
  d.notes.forEach((text, i) => { ws.getCell(`A${6 + d.rows.length + i}`).value = text; });
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
    [sheetPeriod(d)],
    cols.map((c) => c.label),
    ...d.rows.map((r) => cols.map((c) => str(c, c.cell(r)))),
    cols.map((c, j) => (j === 0 ? `Total (${t.count})` : c.total ? str(c, c.total(t)) : "")),
  ];
  if (d.notes.length) lines.push([], ...d.notes.map((x) => [x]));
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}
