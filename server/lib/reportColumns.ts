/* The columns of the downloads, as plain lists. Kept apart from prefs.ts (which
   checks saved settings with zod) so the screens can use them without loading
   zod on start. prefs.ts hands these on unchanged. */

/** The daily report sent to a mill ("dara"): its own column set, since the
 *  mill wants less than the office does. */
export const MILL_REPORT_COLUMNS = [
  { key: "sr",         en: "Sr no",            hi: "क्र सं" },
  { key: "date",       en: "Date",             hi: "दिनांक" },
  { key: "rstNo",      en: "RST",              hi: "RST" },
  { key: "adati",      en: "Adati name",       hi: "आढ़ती का नाम" },
  { key: "village",    en: "Village",          hi: "गाँव" },
  { key: "jins",       en: "Commodity",        hi: "जिंस" },
  { key: "gross",      en: "Kata",             hi: "कांटा" },
  { key: "katauti",    en: "Katauti",          hi: "कटौती" },
  { key: "deduction",  en: "Deduction weight", hi: "कटौती वज़न" },
  { key: "net",        en: "Net weight",       hi: "शुद्ध वज़न" },
  { key: "rate",       en: "Rate",             hi: "दर" },
  { key: "amount",     en: "Amount",           hi: "राशि" },
  { key: "commission", en: "Commission",       hi: "कमीशन" },
  { key: "gaushala",   en: "Gaushala",         hi: "गौशाला" },
  { key: "payable",    en: "Net amount",       hi: "कुल देय" },
  { key: "bags",       en: "Bags",             hi: "बोरे" },
] as const;
export type MillReportColumnKey = (typeof MILL_REPORT_COLUMNS)[number]["key"];
export const DEFAULT_MILL_REPORT_COLUMNS: Record<MillReportColumnKey, boolean> = {
  sr: true, date: false, rstNo: false, adati: true, village: false, jins: true, gross: true, katauti: false, deduction: false, net: true, rate: true, amount: false,
  commission: false, gaushala: false, payable: false, bags: false,
};

/** The supplier pay sheet downloaded from the ledger: what is to be paid, one
 *  row per adati. Amount, commission, gaushala, net amount and paid are for the
 *  sheet's period; "to pay" is what is left to pay at its end. Commission,
 *  gaushala and net amount carry the names set in Settings; the name column is
 *  always there (Hindi, Hinglish or both). */
export const SUPPLIER_SHEET_COLUMNS = [
  { key: "name",       en: "Adati name",       hi: "आढ़ती का नाम" },
  { key: "net",        en: "Net weight (qtl)", hi: "शुद्ध वज़न (क्विं)" },
  { key: "goods",      en: "Amount",           hi: "राशि" },
  { key: "commission", en: "Commission",       hi: "कमीशन" },
  { key: "gaushala",   en: "Gaushala",         hi: "गौशाला" },
  { key: "payable",    en: "Net amount",       hi: "कुल देय" },
  { key: "paid",       en: "Paid",             hi: "दिया" },
  { key: "toPay",      en: "To pay",           hi: "देना" },
] as const;
export type SupplierSheetColumnKey = (typeof SUPPLIER_SHEET_COLUMNS)[number]["key"];
export const DEFAULT_SUPPLIER_SHEET_COLUMNS: Record<SupplierSheetColumnKey, boolean> = {
  name: true, net: false, goods: false, commission: false, gaushala: false, payable: true, paid: false, toPay: false,
};
