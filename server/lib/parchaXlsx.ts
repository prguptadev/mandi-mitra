import ExcelJS from "exceljs";
import type { ParchaDoc } from "./parcha.ts";
import { printedLabel, partyHeading, dmy, roundOffPaise, paperShowsDara } from "./parchaLabels.ts";

/* The kaccha parcha as an Excel sheet, laid out like invoice 196: the same
   boxes in the same order, eight columns wide, Indian number grouping. Values
   are real numbers (not text), so the sheet can still be added up. */

const INR = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';
const QTL = "0.00";
const thin = { style: "thin" as const, color: { argb: "FF000000" } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

export async function parchaXlsx(doc: ParchaDoc, opts: { draft?: boolean; voided?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mandi Mitra";
  // Excel forbids / \\ ? * : [ ] in sheet names and caps them at 31 characters
  const sheetName = `Parcha ${doc.invoiceNo ?? "draft"}`.replace(/[\\/?*:[\]]/g, "-").slice(0, 31);
  const ws = wb.addWorksheet(sheetName, {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
  });
  ws.columns = [10, 11, 13, 12, 12, 16, 12, 13].map((width) => ({ width }));

  let row = 1;
  const cell = (ref: string) => ws.getCell(ref);
  /** Merge a range, write a value, border every cell in it. */
  const put = (range: string, value: ExcelJS.CellValue, style: {
    bold?: boolean; size?: number; align?: "left" | "center" | "right"; fmt?: string; valign?: "middle" | "top" | "bottom";
  } = {}) => {
    const [a, b] = range.split(":");
    if (b && a !== b) ws.mergeCells(range);
    const c = cell(a);
    c.value = value;
    c.font = { name: "Calibri", size: style.size ?? 11, bold: style.bold ?? false };
    c.alignment = { horizontal: style.align ?? "left", vertical: style.valign ?? "middle", wrapText: true };
    if (style.fmt) c.numFmt = style.fmt;
    const [c1, r1] = [a.replace(/\d+/g, ""), Number(a.replace(/\D+/g, ""))];
    const [c2, r2] = b ? [b.replace(/\d+/g, ""), Number(b.replace(/\D+/g, ""))] : [c1, r1];
    for (let r = r1; r <= r2; r++) {
      for (let k = c1.charCodeAt(0); k <= c2.charCodeAt(0); k++) ws.getCell(`${String.fromCharCode(k)}${r}`).border = box;
    }
  };
  const q = (g: number) => Math.round(g / 1000) / 100; // grams -> quintals, 2 dp
  const rs = (p: number) => Math.round(p) / 100;

  // a truck approved again after a void: this paper replaces the one given before (older parchas carry only the version)
  const revision = doc.revision ?? doc.version;
  const revised = revision > 1 ? `REVISED (${revision})${doc.revisedOn ? ` ${dmy(doc.revisedOn)}` : ""}` : "";
  const mark = opts.voided ? `  (VOID — ${opts.voided})` : opts.draft ? "  (DRAFT — not approved)" : revised ? `  (${revised})` : "";
  put(`A${row}:H${row}`, `${doc.title}${mark}`, { bold: true, size: 16, align: "center" });
  ws.getRow(row).height = 26;
  row++;

  put(`A${row}:D${row + 2}`, partyHeading(doc.business), { bold: true, size: 13, align: "center" });
  put(`E${row}:H${row + 2}`, partyHeading(doc.mill), { bold: true, size: 13, align: "center" });
  row += 3;

  const w = doc.weights;
  put(`A${row}:B${row}`, "TRUCK NO:-", { bold: true });
  put(`C${row}:E${row}`, doc.truckNo ?? "", { align: "center" });
  put(`F${row}:H${row + 1}`, "INVOICE NO:-", { bold: true, size: 13, align: "center" });
  row++;
  put(`A${row}:B${row}`, "DHARAM KANTA", { bold: true });
  put(`C${row}:E${row}`, q(w.grossGrams), { align: "right", fmt: QTL });
  row++;
  put(`A${row}:B${row}`, "BARDANA WEIGHT", { bold: true });
  put(`C${row}:E${row}`, q(w.bardanaGrams), { align: "right", fmt: QTL });
  put(`F${row}:H${row + 1}`, revised ? `${doc.invoiceNo ?? ""}\n${revised}` : doc.invoiceNo ?? "", { size: 14, align: "center" });
  row++;
  put(`A${row}:B${row}`, "NET WEIGHT", { bold: true });
  put(`C${row}:E${row}`, q(w.netGrams), { align: "right", fmt: QTL });
  row++;

  put(`A${row}:A${row + 1}`, "BAGS", { bold: true, align: "center" });
  put(`B${row}`, "KATTE", { bold: true, align: "center" });
  put(`C${row}:D${row}`, "BORE", { bold: true, align: "center" });
  put(`E${row}:F${row}`, "KATTE BARDANA", { bold: true, align: "center" });
  put(`G${row}:H${row}`, "BORE BARDANA", { bold: true, align: "center" });
  row++;
  put(`B${row}`, w.katte || "", { align: "center" });
  put(`C${row}:D${row}`, w.bore || "", { align: "center" });
  put(`E${row}:F${row}`, q(w.katteBardanaGrams), { align: "right", fmt: QTL });
  put(`G${row}:H${row}`, q(w.boreBardanaGrams), { align: "right", fmt: QTL });
  row++;

  put(`A${row}:F${row}`, "WEIGHT DETAILS", { bold: true, align: "center" });
  put(`G${row}:H${row + 1}`, "INVOICE DATE", { bold: true, align: "center" });
  row++;
  ["PO", "JEANS", "DATE", "WEIGHT", "RATE", "AMOUNT"].forEach((h, i) =>
    put(`${"ABCDEF"[i]}${row}`, h, { bold: true, align: "center" }));
  row++;
  const lines = [...doc.lines];
  while (lines.length < 2) lines.push(null as never);
  lines.forEach((l, i) => {
    put(`A${row}`, l ? l.po : String(i + 1), { align: "center" });
    put(`B${row}`, l ? l.jinsCode : "", { align: "center" });
    put(`C${row}`, l ? dmy(l.date) : "", { align: "center" });
    put(`D${row}`, l ? q(l.netGrams) : "-", { align: "right", fmt: QTL });
    put(`E${row}`, l ? rs(l.ratePaisePerQtl) : "", { align: "right", fmt: INR });
    put(`F${row}`, l ? rs(l.amountPaise) : "-", { align: "right", fmt: INR });
    if (i === 0) put(`G${row}:H${row + 1}`, dmy(doc.invoiceDate), { bold: true, size: 13, align: "center" });
    row++;
  });
  const codes = [...new Set(doc.lines.map((l) => l.jinsCode))];
  if (codes.length > 1) {
    for (const code of codes) {
      const mine = doc.lines.filter((l) => l.jinsCode === code);
      const net = mine.reduce((s, l) => s + l.netGrams, 0), amt = mine.reduce((s, l) => s + l.amountPaise, 0);
      put(`A${row}:C${row}`, `TOTAL ${code}`, { bold: true, align: "center" });
      put(`D${row}`, q(net), { align: "right", fmt: QTL });
      put(`E${row}`, rs(net ? Math.round((amt * 100_000) / net) : 0), { align: "right", fmt: INR });
      put(`F${row}`, rs(amt), { align: "right", fmt: INR });
      put(`G${row}:H${row}`, "", {});
      row++;
    }
  }
  put(`A${row}:C${row}`, "TOTAL AMOUNT", { bold: true, align: "center" });
  put(`D${row}`, q(doc.totals.netGrams), { align: "right", fmt: QTL });
  put(`E${row}`, rs(doc.totals.ratePaisePerQtl), { align: "right", fmt: INR });
  put(`F${row}`, rs(doc.totals.goodsPaise), { align: "right", fmt: INR });
  put(`G${row}:H${row}`, "", {});
  row++;

  // charges, one per row, amount on the right
  for (const l of doc.result.lines) {
    if (l.kind === "goods" || l.kind === "total" || l.key === "dara" || l.key === "advance") continue;
    const isTotal = l.kind === "subtotal";
    put(`A${row}:E${row}`, isTotal ? "TOTAL AMOUNT" : printedLabel(l), { bold: isTotal, align: isTotal ? "center" : "left" });
    const zero = l.kind === "charge" && l.amountPaise === 0;
    put(`F${row}:H${row}`, zero ? "-" : rs(l.amountPaise) * (l.sign === "subtract" ? -1 : 1),
      { bold: isTotal, align: "right", fmt: INR });
    row++;
  }

  const r = doc.result;
  const advSubtract = doc.config.advance.treatment === "subtract";
  const roundOff = roundOffPaise(r, doc.config);
  if (roundOff !== 0) {
    put(`A${row}:E${row}`, "ROUND OFF", { align: "left" });
    put(`F${row}:H${row}`, rs(roundOff), { align: "right", fmt: INR });
    row++;
  }
  put(`A${row}:E${row}`, doc.config.dara.includeInGrandTotal ? "TOTAL DARA (IN GRAND TOTAL)" : "TOTAL DARA", { bold: true, align: "center" });
  put(`F${row}`, advSubtract ? "LESS ADVANCE" : "ADVANCE", { bold: true });
  put(`G${row}:H${row}`, r.advancePaise && doc.config.advance.treatment !== "exclude" ? rs(r.advancePaise) * (advSubtract ? -1 : 1) : "-", { align: "right", fmt: INR });
  row++;
  // every amount inside the grand total is printed: a dara added to it shows even where the mill's layout hides the row
  const daraShown = paperShowsDara(r, doc.config);
  put(`A${row}:E${row}`, daraShown ? rs(r.daraPaise) : "-", { align: "right", fmt: INR });
  put(`F${row}`, "GRAND TOTAL", { bold: true });
  put(`G${row}:H${row}`, rs(r.grandTotalPaise), { bold: true, align: "right", fmt: INR });
  row++;

  if (doc.ewayBillNo) {
    row++;
    ws.getCell(`A${row}`).value = `E-way bill: ${doc.ewayBillNo}`;
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
