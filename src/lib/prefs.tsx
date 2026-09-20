import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

export const DAILY_COLUMNS = [
  { key: "sr",         en: "Sr no",            hi: "क्र सं" },
  { key: "rstNo",      en: "RST no",           hi: "RST नं" },
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
  { key: "bagsCount",  en: "Bags",             hi: "बोरे" },
  { key: "status",     en: "Status",           hi: "स्थिति" },
] as const;

export type DailyColumnKey = (typeof DAILY_COLUMNS)[number]["key"];
/** These carry the arithmetic; hiding them would make the sheet unreadable. */
export const LOCKED_COLUMNS: DailyColumnKey[] = ["rstNo", "gross", "net", "rate", "amount"];

export interface DailyListPrefs {
  newRowPosition: "top" | "bottom";
  sortOrder: "entry" | "rstAsc" | "rstDesc" | "newestFirst";
  density: "compact" | "normal";
  columns: Record<string, boolean>;
  exportColumns: Record<string, boolean>;
  carryRateForward: boolean;
  showRunningTotal: boolean;
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
  },
};

const SESSION_KEY = "mandi.prefs.session";

function readSession(): Partial<Prefs> | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

interface Ctx {
  prefs: Prefs;
  /** True when a session-only override is masking the saved preferences. */
  sessionOverride: boolean;
  /** Apply for this browser only; nothing is written to the server. */
  setForSession: (patch: Partial<DailyListPrefs>) => void;
  /** Persist against the signed-in user, everywhere they sign in. */
  setForUser: (patch: Partial<DailyListPrefs>) => Promise<void>;
  clearSession: () => void;
  resetAll: () => Promise<void>;
  saving: boolean;
}

const PrefsCtx = createContext<Ctx | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Partial<Prefs> | null>(readSession);

  const q = useQuery({
    queryKey: ["prefs"],
    queryFn: () => api.get<{ prefs: Prefs }>("/auth/prefs"),
    staleTime: 60_000,
    retry: 1,
  });

  const saveM = useMutation({
    mutationFn: (patch: Partial<DailyListPrefs>) => api.put<Prefs>("/auth/prefs", { dailyList: patch }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["prefs"] }); },
  });

  const resetM = useMutation({
    mutationFn: () => api.post<Prefs>("/auth/prefs/reset"),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["prefs"] }); },
  });

  const saved = q.data?.prefs ?? DEFAULT_PREFS;

  const prefs: Prefs = useMemo(() => ({
    dailyList: {
      ...DEFAULT_PREFS.dailyList,
      ...saved.dailyList,
      ...(session?.dailyList ?? {}),
      columns: { ...DEFAULT_PREFS.dailyList.columns, ...saved.dailyList?.columns, ...(session?.dailyList?.columns ?? {}) },
      exportColumns: { ...DEFAULT_PREFS.dailyList.exportColumns, ...saved.dailyList?.exportColumns, ...(session?.dailyList?.exportColumns ?? {}) },
    },
  }), [saved, session]);

  const setForSession = (patch: Partial<DailyListPrefs>) => {
    const next: Partial<Prefs> = {
      dailyList: { ...(session?.dailyList ?? {}), ...patch } as DailyListPrefs,
    };
    setSession(next);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const clearSession = () => {
    setSession(null);
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  };

  const value: Ctx = {
    prefs,
    sessionOverride: session !== null,
    setForSession,
    setForUser: async (patch) => { clearSession(); await saveM.mutateAsync(patch); },
    clearSession,
    resetAll: async () => { clearSession(); await resetM.mutateAsync(); },
    saving: saveM.isPending || resetM.isPending,
  };

  return <PrefsCtx.Provider value={value}>{children}</PrefsCtx.Provider>;
}

export function usePrefs() {
  const c = useContext(PrefsCtx);
  if (!c) throw new Error("usePrefs outside PrefsProvider");
  return c;
}
