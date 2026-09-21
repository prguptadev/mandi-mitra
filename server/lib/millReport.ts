import ExcelJS from "exceljs";
import { MILL_REPORT_COLUMNS, type MillReportColumnKey } from "./prefs.ts";
import { dmy } from "./parchaLabels.ts";

/* The daily report sent to a mill ("dara"): what was bought for it, one row
   per slip, with the total and the weighted average rate at the foot.
   Heading reads "VIJAY LAXMI DAL MILL → <MILL>", like the office writes it. */

export interface MillReportRow {
  slipDate: string;
  rstNo: string;
  adati: string;
  jinsCode: string;
  grossGrams: number;
  katautiUnits: number;
  netGrams: number;
  ratePaisePerQtl: number;
  amountPaise: number;
}

export interface MillReportData {
  from: string;
  to: string;
  businessName: string;
  millName: string;
  jinsLabel: string | null;
  columns: MillReportColumnKey[];
  rows: MillReportRow[];
}

export function reportTotals(rows: MillReportRow[]) {
  const priced = rows.filter((r) => r.ratePaisePerQtl > 0);
  const pricedNet = priced.reduce((s, r) => s + r.netGrams, 0);
  const pricedValue = priced.reduce((s, r) => s + r.netGrams * r.ratePaisePerQtl, 0);
  return {
    count: rows.length,
    grossGrams: rows.reduce((s, r) => s + r.grossGrams, 0),
    katautiUnits: rows.reduce((s, r) => s + r.katautiUnits, 0),
    netGrams: rows.reduce((s, r) => s + r.netGrams, 0),
    amountPaise: rows.reduce((s, r) => s + r.amountPaise, 0),
    /** Σ(net × rate) / Σ net over priced slips, to the paisa. */
    avgRatePaisePerQtl: pricedNet ? Math.floor(pricedValue / pricedNet + 0.5) : 0,
    unpriced: rows.length - priced.length,
  };
}

const heading = (d: MillReportData) => `${d.businessName.toUpperCase()}  →  ${d.millName.toUpperCase()}`;
const period = (d: MillReportData) => (d.from === d.to ? dmy(d.from) : `${dmy(d.from)} to ${dmy(d.to)}`);
const label = (k: MillReportColumnKey) => MILL_REPORT_COLUMNS.find((c) => c.key === k)!.en;
const q2 = (g: number) => Math.round(g / 1000) / 100;
const rs = (p: number) => Math.round(p) / 100;

function cellValue(k: MillReportColumnKey, r: MillReportRow, i: number): string | number {
  switch (k) {
    case "sr": return i + 1;
    case "date": return dmy(r.slipDate);
    case "rstNo": return r.rstNo;
    case "adati": return r.adati;
    case "jins": return r.jinsCode;
    case "gross": return q2(r.grossGrams);
    case "katauti": return r.katautiUnits;
    case "net": return q2(r.netGrams);
    case "rate": return r.ratePaisePerQtl ? rs(r.ratePaisePerQtl) : "";
    case "amount": return r.ratePaisePerQtl ? rs(r.amountPaise) : "";
  }
}

/** The label column for the Total / Average rows: the first text column. */
function labelColumn(cols: MillReportColumnKey[]) {
  return cols.find((k) => k === "adati" || k === "rstNo" || k === "date" || k === "sr") ?? cols[0];
}

export async function millReportXlsx(d: MillReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mandi Mitra";
  const ws = wb.addWorksheet("Report", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const cols = d.columns;
  const widths: Record<MillReportColumnKey, number> = {
    sr: 6, date: 12, rstNo: 8, adati: 30, jins: 11, gross: 11, katauti: 9, net: 12, rate: 11, amount: 15,
  };
  ws.columns = cols.map((k) => ({ width: widths[k] }));
  const last = String.fromCharCode(64 + cols.length);
  const thin = { style: "thin" as const, color: { argb: "FF999999" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const INR = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
  const fmt: Partial<Record<MillReportColumnKey, string>> = { gross: "0.00", net: "0.00", rate: INR, amount: INR };

  ws.mergeCells(`A1:${last}1`);
  ws.getCell("A1").value = heading(d);
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A1").alignment = { horizontal: "center" };
  ws.mergeCells(`A2:${last}2`);
  ws.getCell("A2").value = `Date: ${period(d)}${d.jinsLabel ? `    Commodity: ${d.jinsLabel}` : ""}`;
  ws.getCell("A2").alignment = { horizontal: "center" };

  const headerRow = ws.getRow(4);
  cols.forEach((k, i) => {
    const c = headerRow.getCell(i + 1);
    c.value = label(k);
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    c.border = border;
    c.alignment = { horizontal: ["gross", "katauti", "net", "rate", "amount", "sr"].includes(k) ? "right" : "left" };
  });

  d.rows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    cols.forEach((k, j) => {
      const c = row.getCell(j + 1);
      c.value = cellValue(k, r, i);
      c.border = border;
      if (fmt[k]) c.numFmt = fmt[k]!;
    });
  });

  const t = reportTotals(d.rows);
  const lab = labelColumn(cols);
  const totalRow = ws.getRow(5 + d.rows.length);
  const avgRow = ws.getRow(6 + d.rows.length);
  cols.forEach((k, j) => {
    const tc = totalRow.getCell(j + 1);
    const ac = avgRow.getCell(j + 1);
    tc.border = border; ac.border = border;
    tc.font = { bold: true }; ac.font = { bold: true };
    if (k === lab) { tc.value = `Total (${t.count})`; ac.value = "Average rate"; }
    if (k === "gross") tc.value = q2(t.grossGrams);
    if (k === "katauti") tc.value = t.katautiUnits;
    if (k === "net") tc.value = q2(t.netGrams);
    if (k === "amount") tc.value = rs(t.amountPaise);
    if (k === "rate") ac.value = t.avgRatePaisePerQtl ? rs(t.avgRatePaisePerQtl) : "";
    if (fmt[k]) { tc.numFmt = fmt[k]!; ac.numFmt = fmt[k]!; }
  });
  if (!cols.includes("rate")) {
    // the average is the point of the report; keep it even with the rate column off
    avgRow.getCell(cols.indexOf(lab) + 1).value = `Average rate ${t.avgRatePaisePerQtl ? rs(t.avgRatePaisePerQtl).toFixed(2) : "-"}`;
  }
  if (t.unpriced) {
    ws.getCell(`A${8 + d.rows.length}`).value = `${t.unpriced} slip(s) without a rate are left out of the average.`;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function millReportCsv(d: MillReportData): string {
  const cols = d.columns;
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const fix2 = (k: MillReportColumnKey, v: string | number) =>
    typeof v === "number" && ["gross", "net", "rate", "amount"].includes(k) ? v.toFixed(2) : v;
  const t = reportTotals(d.rows);
  const lab = labelColumn(cols);
  const lines: (string | number)[][] = [
    [heading(d)],
    [`Date: ${period(d)}${d.jinsLabel ? ` · Commodity: ${d.jinsLabel}` : ""}`],
    [],
    cols.map(label),
    ...d.rows.map((r, i) => cols.map((k) => fix2(k, cellValue(k, r, i)))),
    cols.map((k) => k === lab ? `Total (${t.count})` : k === "gross" ? (t.grossGrams / 100_000).toFixed(2)
      : k === "katauti" ? t.katautiUnits : k === "net" ? (t.netGrams / 100_000).toFixed(2)
      : k === "amount" ? (t.amountPaise / 100).toFixed(2) : ""),
    cols.map((k) => k === lab ? "Average rate" : k === "rate" ? (t.avgRatePaisePerQtl / 100).toFixed(2) : ""),
  ];
  if (!cols.includes("rate")) lines[lines.length - 1][cols.indexOf(lab)] = `Average rate ${(t.avgRatePaisePerQtl / 100).toFixed(2)}`;
  return "﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n");
}
