import { z } from "zod";

/*
 * Tally Prime import files (XML, the format Tally reads through Gateway of
 * Tally › Import › Masters / Transactions).
 *
 * In a Tally voucher every line is a ledger and an amount: a debit is written
 * negative with ISDEEMEDPOSITIVE Yes, a credit positive with ISDEEMEDPOSITIVE
 * No, and the lines of one voucher add up to exactly zero. Amounts are rupees
 * with two decimals (worked out here from whole paise, so nothing drifts);
 * dates are YYYYMMDD. Ledger names must match the ones in Tally, so every
 * name is a setting.
 */

export const TallySettingsSchema = z.object({
  /** The company as named in Tally; blank = whichever company is open there. */
  companyName: z.string().trim().max(120).default(""),
  supplierGroup: z.string().trim().min(1).max(80).default("Sundry Creditors"),
  millGroup: z.string().trim().min(1).max(80).default("Sundry Debtors"),
  /** Supplier ledgers in Tally are named in Hinglish (default) or Hindi. */
  partyNames: z.enum(["hinglish", "hindi"]).default("hinglish"),
  /** One purchase entry for each slip, or one per supplier per day. */
  purchasePer: z.enum(["slip", "supplierDay"]).default("slip"),
  ledgers: z.object({
    purchase: z.string().trim().min(1).max(80).default("Purchase"),
    commissionPaid: z.string().trim().min(1).max(80).default("Commission Paid"),
    gaushalaPaid: z.string().trim().min(1).max(80).default("Gaushala Paid"),
    sales: z.string().trim().min(1).max(80).default("Sales"),
    cash: z.string().trim().min(1).max(80).default("Cash"),
    bank: z.string().trim().min(1).max(80).default("Bank"),
    millDeductions: z.string().trim().min(1).max(80).default("Deductions by Mill"),
    weightShortage: z.string().trim().min(1).max(80).default("Weight Shortage"),
    advance: z.string().trim().min(1).max(80).default("Truck Advance"),
    dara: z.string().trim().min(1).max(80).default("Dara"),
    roundOff: z.string().trim().min(1).max(80).default("Round Off"),
  }).default({}),
  /** A parcha charge (by its key: adat, mandi_tax…) → the Tally ledger it goes to; blank = the charge's own name. */
  chargeLedgers: z.record(z.string(), z.string().trim().max(80)).default({}),
  voucherTypes: z.object({
    purchase: z.string().trim().min(1).max(60).default("Purchase"),
    payment: z.string().trim().min(1).max(60).default("Payment"),
    sales: z.string().trim().min(1).max(60).default("Sales"),
    receipt: z.string().trim().min(1).max(60).default("Receipt"),
    journal: z.string().trim().min(1).max(60).default("Journal"),
  }).default({}),
});
export type TallySettings = z.infer<typeof TallySettingsSchema>;
export const defaultTallySettings = (): TallySettings => TallySettingsSchema.parse({});

/** One line of a voucher: + is a debit, − a credit (paise). */
export interface TallyLine { ledger: string; paise: number }
export interface TallyVoucher {
  type: string; date: string; number?: string; reference?: string; party?: string; narration: string; lines: TallyLine[];
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** 6801795 → "68017.95", −6801795 → "-68017.95"; exact, from whole paise. */
export const rupees = (paise: number) => {
  const neg = paise < 0, a = Math.abs(paise);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};
const tallyDate = (iso: string) => iso.replace(/-/g, "");

/** Drops zero lines and joins lines of the same ledger. Throws if the voucher does not balance. */
export function tidy(v: TallyVoucher): TallyVoucher {
  const by = new Map<string, number>();
  for (const l of v.lines) by.set(l.ledger, (by.get(l.ledger) ?? 0) + l.paise);
  const lines = [...by].filter(([, p]) => p !== 0).map(([ledger, paise]) => ({ ledger, paise }));
  const sum = lines.reduce((s, l) => s + l.paise, 0);
  if (sum !== 0) throw new Error(`Voucher ${v.number ?? v.reference ?? ""} of ${v.date} does not balance (${rupees(sum)})`);
  return { ...v, lines };
}

function voucherXml(v: TallyVoucher): string {
  const lines = v.lines.map((l) => [
    "<ALLLEDGERENTRIES.LIST>",
    `<LEDGERNAME>${esc(l.ledger)}</LEDGERNAME>`,
    // Tally: a debit is "deemed positive" and written as a negative amount
    `<ISDEEMEDPOSITIVE>${l.paise > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${rupees(-l.paise)}</AMOUNT>`,
    "</ALLLEDGERENTRIES.LIST>",
  ].join("")).join("\n");
  return [
    `<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
    `<VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${tallyDate(v.date)}</DATE>`,
    `<EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>`,
    v.number ? `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>` : "",
    v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>` : "",
    v.party ? `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>` : "",
    `<NARRATION>${esc(v.narration)}</NARRATION>`,
    "<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>",
    "<ISINVOICE>No</ISINVOICE>",
    lines,
    "</VOUCHER>",
    "</TALLYMESSAGE>",
  ].filter(Boolean).join("\n");
}

function envelope(report: "Vouchers" | "All Masters", company: string, body: string) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    "<ENVELOPE>",
    "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "<BODY><IMPORTDATA>",
    "<REQUESTDESC>",
    `<REPORTNAME>${report}</REPORTNAME>`,
    company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : "",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    body,
    "</REQUESTDATA>",
    "</IMPORTDATA></BODY>",
    "</ENVELOPE>",
    "",
  ].filter((x) => x !== "").join("\n");
}

export const vouchersFile = (company: string, vouchers: TallyVoucher[]) =>
  envelope("Vouchers", company, vouchers.map((v) => voucherXml(tidy(v))).join("\n"));

export interface TallyLedger { name: string; parent: string }
export const ledgersFile = (company: string, ledgers: TallyLedger[]) => envelope("All Masters", company, ledgers.map((l) => [
  `<TALLYMESSAGE xmlns:UDF="TallyUDF">`,
  `<LEDGER NAME="${esc(l.name)}" ACTION="Create">`,
  `<NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>`,
  `<PARENT>${esc(l.parent)}</PARENT>`,
  "</LEDGER>",
  "</TALLYMESSAGE>",
].join("\n")).join("\n"));
