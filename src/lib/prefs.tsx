import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

export const DAILY_COLUMNS = [
  { key: "sr",         en: "Sr no",            hi: "क्र सं" },
  { key: "rstNo",      en: "Kanta slip (RST)",           hi: "कांटा पर्ची (RST)" },
  { key: "adatiHi",    en: "Adati (Hindi)",    hi: "आढ़ती (हिन्दी)" },
  { key: "adatiLatin", en: "Adati (Hinglish)", hi: "आढ़ती (हिंग्लिश)" },
  { key: "village",    en: "Village",          hi: "गाँव" },
  { key: "mill",       en: "Mill",             hi: "मिल" },
  { key: "jins",       en: "Commodity",        hi: "जिंस" },
  { key: "gross",      en: "Dharam kanta",     hi: "धर्म कांटा" },
  { key: "katauti",    en: "Katauti",          hi: "कटौती" },
  { key: "deduction",  en: "Deduction weight", hi: "कटौती वज़न" },
  { key: "net",        en: "Net weight",       hi: "शुद्ध वज़न" },
  { key: "rate",       en: "Rate",             hi: "दर" },
  { key: "amount",     en: "Amount",           hi: "राशि" },
  { key: "commission", en: "Commission",       hi: "कमीशन" },
  { key: "gaushala",   en: "Gaushala",         hi: "गौशाला" },
  { key: "payable",    en: "Net amount",       hi: "कुल देय" },
  { key: "bagsCount",  en: "Bags",             hi: "बोरे" },
  { key: "status",     en: "Status",           hi: "स्थिति" },
] as const;

export type DailyColumnKey = (typeof DAILY_COLUMNS)[number]["key"];
/** These carry the arithmetic; hiding them would make the sheet unreadable. */
export const LOCKED_COLUMNS: DailyColumnKey[] = ["rstNo", "gross", "net", "rate", "amount"];

export { MILL_REPORT_COLUMNS, DEFAULT_MILL_REPORT_COLUMNS, type MillReportColumnKey } from "@server/lib/prefs.ts";
import { DEFAULT_MILL_REPORT_COLUMNS } from "@server/lib/prefs.ts";
import type { SlipSortOrder } from "@server/lib/slipOrder.ts";

export interface DailyListPrefs {
  newRowPosition: "top" | "bottom";
  sortOrder: SlipSortOrder;
  density: "compact" | "normal";
  columns: Record<string, boolean>;
  exportColumns: Record<string, boolean>;
  carryRateForward: boolean;
  showRunningTotal: boolean;
  /** Downloads carry one "Adati name" column, in this script. */
  exportNameLang: "hi" | "latin";
  /** Columns of the report sent to a mill ("dara"). */
  millReportColumns: Record<string, boolean>;
}

export interface Prefs { dailyList: DailyListPrefs }

const cols = (off: string[]) =>
  Object.fromEntries(DAILY_COLUMNS.map((c) => [c.key, !off.includes(c.key)]));

export const DEFAULT_PREFS: Prefs = {
  dailyList: {
    newRowPosition: "bottom",
    sortOrder: "entry",
    density: "normal",
    columns: cols(["village", "bagsCount", "status", "jins"]),
    exportColumns: cols(["status"]),
    carryRateForward: true,
    showRunningTotal: true,
    exportNameLang: "hi",
    millReportColumns: { ...DEFAULT_MILL_REPORT_COLUMNS },
  },
};

/** Where settings were kept before v0.3.2 (this browser only); moved to the computer once. */
const OLD_BROWSER_KEY = "mandi.prefs.session";

interface Ctx {
  prefs: Prefs;
  /** Keep this layout on this computer, for the person signed in. */
  save: (dailyList: DailyListPrefs) => Promise<void>;
  /** Back to the standard layout. */
  reset: () => Promise<void>;
  saving: boolean;
}

const PrefsCtx = createContext<Ctx | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // what the person saved to their login before v0.3.2 still counts, under this computer's choice
  const q = useQuery({ queryKey: ["prefs"], queryFn: () => api.get<{ prefs: Prefs }>("/auth/prefs"), staleTime: 60_000, retry: 1 });
  const dev = useQuery({ queryKey: ["prefs", "device"], queryFn: () => api.get<{ dailyList: DailyListPrefs | null }>("/auth/device-prefs"), staleTime: 60_000, retry: 1 });

  const saveM = useMutation({
    mutationFn: (dailyList: DailyListPrefs) => api.put("/auth/device-prefs", { dailyList }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["prefs"] }); },
  });
  const resetM = useMutation({
    mutationFn: async () => { await api.del("/auth/device-prefs"); await api.post("/auth/prefs/reset"); },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["prefs"] }); },
  });

  // settings kept in this browser by older versions move to the computer, once
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current || !dev.isSuccess || dev.data.dailyList) return;
    moved.current = true;
    try {
      const raw = localStorage.getItem(OLD_BROWSER_KEY);
      const old = raw ? (JSON.parse(raw) as Partial<Prefs>).dailyList : null;
      if (old) {
        const full = { ...DEFAULT_PREFS.dailyList, ...(q.data?.prefs.dailyList ?? {}), ...old } as DailyListPrefs;
        void saveM.mutateAsync(full).then(() => localStorage.removeItem(OLD_BROWSER_KEY)).catch(() => undefined);
      }
    } catch { /* nothing to move */ }
  }, [dev.isSuccess, dev.data]);

  const saved = q.data?.prefs ?? DEFAULT_PREFS;
  const here = dev.data?.dailyList ?? null;

  const prefs: Prefs = useMemo(() => ({
    dailyList: {
      ...DEFAULT_PREFS.dailyList,
      ...saved.dailyList,
      ...(here ?? {}),
      // a column added in a later version shows as its default until chosen
      columns: { ...DEFAULT_PREFS.dailyList.columns, ...saved.dailyList?.columns, ...(here?.columns ?? {}) },
      exportColumns: { ...DEFAULT_PREFS.dailyList.exportColumns, ...saved.dailyList?.exportColumns, ...(here?.exportColumns ?? {}) },
      millReportColumns: { ...DEFAULT_PREFS.dailyList.millReportColumns, ...saved.dailyList?.millReportColumns, ...(here?.millReportColumns ?? {}) },
    },
  }), [saved, here]);

  const value: Ctx = {
    prefs,
    save: async (dailyList) => { await saveM.mutateAsync(dailyList); },
    reset: async () => { await resetM.mutateAsync(); },
    saving: saveM.isPending || resetM.isPending,
  };

  return <PrefsCtx.Provider value={value}>{children}</PrefsCtx.Provider>;
}

export function usePrefs() {
  const c = useContext(PrefsCtx);
  if (!c) throw new Error("usePrefs outside PrefsProvider");
  return c;
}
