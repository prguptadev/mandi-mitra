import { z } from "zod";

/** Which columns the daily list can show, in the order they appear. */
export const DAILY_COLUMNS = [
  { key: "sr",          en: "Sr no",            hi: "क्र सं",          always: false },
  { key: "rstNo",       en: "Kanta slip (RST)",           hi: "कांटा पर्ची (RST)",          always: true  },
  { key: "adatiHi",     en: "Adati (Hindi)",    hi: "आढ़ती (हिन्दी)",   always: false },
  { key: "adatiLatin",  en: "Adati (Hinglish)", hi: "आढ़ती (हिंग्लिश)", always: false },
  { key: "village",     en: "Village",          hi: "गाँव",            always: false },
  { key: "mill",        en: "Mill",             hi: "मिल",             always: false },
  { key: "jins",        en: "Commodity",        hi: "जिंस",            always: false },
  { key: "gross",       en: "Dharam kanta",     hi: "धर्म कांटा",       always: true  },
  { key: "katauti",     en: "Katauti",          hi: "कटौती",           always: false },
  { key: "deduction",   en: "Deduction weight", hi: "कटौती वज़न",       always: false },
  { key: "net",         en: "Net weight",       hi: "शुद्ध वज़न",       always: true  },
  { key: "rate",        en: "Rate",             hi: "दर",              always: true  },
  { key: "amount",      en: "Amount",           hi: "राशि",            always: true  },
  { key: "commission",  en: "Commission",       hi: "कमीशन",          always: false },
  { key: "gaushala",    en: "Gaushala",         hi: "गौशाला",          always: false },
  { key: "payable",     en: "Net amount",       hi: "कुल देय",         always: false },
  { key: "bagsCount",   en: "Bags",             hi: "बोरे",            always: false },
  { key: "status",      en: "Status",           hi: "स्थिति",          always: false },
] as const;

export type DailyColumnKey = (typeof DAILY_COLUMNS)[number]["key"];

const columnMap = (defaults: Partial<Record<DailyColumnKey, boolean>>) =>
  Object.fromEntries(DAILY_COLUMNS.map((c) => [c.key, defaults[c.key] ?? true])) as Record<DailyColumnKey, boolean>;

/** Matches the paper sheet: no village, no bag count, no status column. */
export const DEFAULT_UI_COLUMNS = columnMap({ village: false, bagsCount: false, status: false, jins: false });
/** The download carries everything worth keeping. */
export const DEFAULT_EXPORT_COLUMNS = columnMap({ status: false });

const ColumnsSchema = z.record(z.string(), z.boolean());

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
 *  row per adati. Commission, gaushala and net amount carry the names set in
 *  Settings; the name column is always there (Hindi, Hinglish or both). */
export const SUPPLIER_SHEET_COLUMNS = [
  { key: "name",       en: "Adati name",       hi: "आढ़ती का नाम" },
  { key: "village",    en: "Village",          hi: "गाँव" },
  { key: "slips",      en: "Slips",            hi: "पर्चियाँ" },
  { key: "net",        en: "Net weight (qtl)", hi: "शुद्ध वज़न (क्विं)" },
  { key: "goods",      en: "Amount",           hi: "राशि" },
  { key: "commission", en: "Commission",       hi: "कमीशन" },
  { key: "gaushala",   en: "Gaushala",         hi: "गौशाला" },
  { key: "payable",    en: "Net amount",       hi: "कुल देय" },
  { key: "before",     en: "Previous balance", hi: "पिछला शेष" },
  { key: "paid",       en: "Paid",             hi: "दिया" },
  { key: "toPay",      en: "To pay",           hi: "देना" },
] as const;
export type SupplierSheetColumnKey = (typeof SUPPLIER_SHEET_COLUMNS)[number]["key"];
export const DEFAULT_SUPPLIER_SHEET_COLUMNS: Record<SupplierSheetColumnKey, boolean> = {
  name: true, village: false, slips: false, net: true, goods: true, commission: true, gaushala: true,
  payable: true, before: false, paid: false, toPay: true,
};

export const DailyListPrefsSchema = z.object({
  /** Where the blank entry row sits. */
  newRowPosition: z.enum(["top", "bottom"]).default("bottom"),
  /** Newest slips first, or in the order they were entered. */
  sortOrder: z.enum(["entry", "rstAsc", "rstDesc", "newestFirst", "nameAsc", "nameDesc"]).default("entry"),
  density: z.enum(["compact", "normal"]).default("normal"),
  columns: ColumnsSchema.default(DEFAULT_UI_COLUMNS),
  exportColumns: ColumnsSchema.default(DEFAULT_EXPORT_COLUMNS),
  /** Repeat the supplier and rate from the row above when starting a new one. */
  carryRateForward: z.boolean().default(true),
  showRunningTotal: z.boolean().default(true),
  /** Downloads carry one "Adati name" column, in this script. */
  exportNameLang: z.enum(["hi", "latin"]).default("hi"),
  millReportColumns: ColumnsSchema.default(DEFAULT_MILL_REPORT_COLUMNS),
  /** Columns of the supplier pay sheet, and the script its names are in. */
  supplierSheetColumns: ColumnsSchema.default(DEFAULT_SUPPLIER_SHEET_COLUMNS),
  supplierSheetNames: z.enum(["hi", "hinglish", "both"]).default("hi"),
  /** Column widths (px) dragged by hand on the daily list; the rest size themselves. */
  widths: z.record(z.string(), z.number().int().min(40).max(800)).default({}),
});

export type DailyListPrefs = z.infer<typeof DailyListPrefsSchema>;

export const PrefsSchema = z.object({
  dailyList: DailyListPrefsSchema.default({}),
  /** Where this user was last working; restored at the next sign-in. */
  lastBusinessId: z.string().nullable().default(null),
});

export type Prefs = z.infer<typeof PrefsSchema>;
export const defaultPrefs = (): Prefs => PrefsSchema.parse({});

export function parsePrefs(raw: string | null | undefined): Prefs {
  if (!raw) return defaultPrefs();
  const parsed = PrefsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : defaultPrefs();
}
