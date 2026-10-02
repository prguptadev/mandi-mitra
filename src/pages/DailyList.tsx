import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Calendar, Trash2, Truck, AlertTriangle, Check,
  RefreshCw, Download, Keyboard, Lock, Plus, X, Image as ImageIcon, CheckSquare,
  FileSpreadsheet, Pencil, ArrowUp, ArrowDown, LockOpen, MessageCircle,
} from "lucide-react";
import { api, ApiError, type Jins, type Merchant, type SlipRow, type SlipTotals, type SlipDay, type KatautiConfig } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSort } from "@/lib/useSort.ts";
import { useSession } from "@/lib/session.tsx";
import { useFormat, parseLooseNumber, parseQtlToGrams, parseRupeesToPaise, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { TallyMark, useTallyFlags } from "@/components/TallyMark.tsx";
import { useDayActions, type DayRow } from "@/lib/dayClose.tsx";
import { DailyListSettings } from "@/components/DailyListSettings.tsx";
import { usePrefs, DAILY_COLUMNS, type DailyColumnKey } from "@/lib/prefs.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { shiftDay } from "@server/lib/parchaLabels.ts";
import { HindiInput } from "@/components/HindiInput.tsx";
import { DownloadDialog } from "@/components/DownloadDialog.tsx";
import { WhatsAppDialog } from "@/components/WhatsAppDialog.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { useFY } from "@/lib/fy.tsx";
import { slipCharges, defaultSupplierCharges, supplierTermsOf, type SupplierCharges, type SupplierTerms } from "@server/lib/supplierTerms.ts";
import { sortSlips, type SlipSortOrder } from "@server/lib/slipOrder.ts";
import { rstKey, numberOnly, grossOdd, rateOdd, DEFAULT_RATE_RANGE, type GrossOdd, type RateRange } from "@server/lib/slipChecks.ts";
import { dmy } from "@server/lib/parchaLabels.ts";
import {
  Button, Card, Select, Input, Badge, Alert, EmptyState, Dialog, Field, Spinner, Checkbox,
} from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

const todayISO = () => new Date().toLocaleDateString("en-CA");
/** The row being typed. Kept as strings so half-typed numbers stay on screen. */
interface Draft {
  rstNo: string;
  adatiId: string | null;
  /** What is typed in the name box when no supplier is picked: saved as a new supplier. */
  adatiName?: string;
  gross: string;
  /** Left blank unless the sheet's KATAUTI differs from the derived value. */
  katauti: string;
  rate: string;
  /** Only while editing a row: its commodity. */
  jinsId?: string;
}
const emptyDraft = (): Draft => ({ rstNo: "", adatiId: null, adatiName: "", gross: "", katauti: "", rate: "" });

/** A row as the day's list sends it: checked against the whole day and the days around it. */
type Row = SlipRow & {
  /** The terms the slip was made with (JSON), which an edit keeps. */
  supplierTerms?: string | null;
  /** The katauti terms the slip was made with (JSON); none on a slip from before v0.3. */
  katautiTerms?: string | null;
  /** Slips on this date with this RST, every mill and commodity, this one included. */
  rstDay?: number;
  /** Other dates (30 days either side) with this RST and exactly this gross. */
  rstOtherDays?: string[];
  grossOdd?: GrossOdd;
  rateOdd?: RateRange | null;
};
type Totals = SlipTotals & { rstOtherDayRows?: number; usualRate?: Record<string, RateRange> };
type OtherSlip = { date: string; rstNo: string; millCode: string | null; nameHi: string; nameHinglish: string };
/** What the server found when a slip was saved — flags only, the slip is saved. */
type SavedFlags = { sameDay: OtherSlip[]; otherDays: OtherSlip[]; grossOdd: GrossOdd; rateOdd: RateRange | null };

/** A box that has something in it which does not read as a number. */
const unreadable = (s: string) => s.trim() !== "" && parseLooseNumber(s) === null;
/** The RST box keeps what was typed, with Hindi digits as English ones and no spaces. */
const rstTyped = (s: string) => s.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).replace(/\s+/g, "");

const halfUp = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/**
 * Live arithmetic, mirroring the server. Katauti units come from the gross
 * weight rounded to the nearest quintal unless the operator typed over them.
 */
function derive(draft: Draft, cfg: KatautiConfig) {
  const grossQtl = parseLooseNumber(draft.gross);
  const rate = parseLooseNumber(draft.rate);
  const grossGrams = grossQtl === null ? null : Math.round(grossQtl * GRAMS_PER_QTL);

  const typed = parseLooseNumber(draft.katauti);
  const suggested =
    grossGrams === null || cfg.mode === "none" ? null
    : cfg.mode === "per_quintal_rounded" ? halfUp(grossGrams / GRAMS_PER_QTL)
    : cfg.mode === "per_quintal_exact" ? grossGrams / GRAMS_PER_QTL
    : 0;
  const katautiUnits = typed !== null ? Math.round(typed) : suggested;
  const katautiGrams = katautiUnits === null ? null : Math.round(katautiUnits * cfg.kgPerUnit * 1000);
  const netGrams = grossGrams === null || katautiGrams === null ? null : grossGrams - katautiGrams;
  const ratePaise = rate === null ? null : Math.round(rate * 100);
  const amountPaise =
    netGrams === null || ratePaise === null ? null
    : Math.round((netGrams * ratePaise) / GRAMS_PER_QTL);
  return { grossGrams, katautiUnits, suggested, overridden: typed !== null, katautiGrams, netGrams, ratePaise, amountPaise };
}

const NUMERIC = new Set<string>(["sr", "gross", "katauti", "deduction", "net", "rate", "amount", "commission", "gaushala", "payable", "bagsCount"]);
const WIDTHS: Record<string, string> = {
  sr: "w-10", rstNo: "w-20", adatiHi: "min-w-[170px]", adatiLatin: "min-w-[140px]",
  village: "w-28", mill: "w-16", jins: "w-24", gross: "w-24", katauti: "w-20",
  deduction: "w-20", net: "w-24", rate: "w-24", amount: "w-32", commission: "w-24", gaushala: "w-24", payable: "w-32", bagsCount: "w-16", status: "w-20",
};

const CELL = "h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-ink num text-right placeholder:text-faint focus:border-brand disabled:opacity-60";

export function DailyListPage() {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const ask = useConfirm();
  const { prefs, save: savePrefs } = usePrefs();
  const P = prefs.dailyList;
  const [downloading, setDownloading] = useState<null | "list" | "dara">(null);
  const [sharing, setSharing] = useState<null | "list" | "dara">(null);

  // a link like /daily?date=2026-09-20 (from the dashboard's flags) opens that day
  const search = useSearch();
  const [date, setDate] = useState(() => {
    const d = new URLSearchParams(search).get("date");
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayISO();
  });
  // another financial year chosen in the top bar: open a day inside it
  const { fy } = useFY();
  const fyFirst = useRef(true);
  useEffect(() => {
    if (fyFirst.current) { fyFirst.current = false; return; }
    if (date < fy.from || date > fy.to) setDate(fy.current ? todayISO() : fy.to);
  }, [fy.start]);
  /* a closed day is shown locked: no new row, no edits, no deletes */
  const dayQ = useQuery({ queryKey: ["days", "one", date], queryFn: () => api.get<DayRow>(`/days/one?day=${date}`) });
  const dayClosed = dayQ.data?.closed ?? null;
  const dayAct = useDayActions();
  const canSlip = can("slip.write") && !dayClosed;
  const canDel = can("slip.delete") && !dayClosed;
  const tallyFlags = useTallyFlags("slip", date, date);
  // the dashboard's day-rate card links a mill's line here as /daily?date=…&mill=<id>
  const [merchantId, setMerchantId] = useState<string>(() => new URLSearchParams(search).get("mill") ?? "");
  /** Commodity new rows get. */
  const [jinsId, setJinsId] = useState<string>("");
  /** Commodity the list shows; "" = all of them. */
  const [filterJins, setFilterJins] = useState<string>("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  /** `grossShown` is the gross as the edit box first showed it: if it is not touched, the stored grams stay exactly as they are. */
  const [editing, setEditing] = useState<{ id: string; draft: Draft; grossShown?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Approved parchas on a day just changed: their frozen figures no longer match it. */
  const [staleWarn, setStaleWarn] = useState<string | null>(null);
  const warnStale = (r: unknown) => {
    const list = (r as { approvedParchas?: { parchaNo: string; truckNo: string | null }[] } | null)?.approvedParchas ?? [];
    setStaleWarn(list.length ? t("daily.parchaStale", { nos: list.map((p) => `#${p.parchaNo}${p.truckNo ? ` (${p.truckNo})` : ""}`).join(", ") }) : null);
  };
  /** After a save: what deserves a second look. The slip is saved either way. */
  const [flagWarn, setFlagWarn] = useState<{ rst: string; lines: string[]; saved?: boolean } | null>(null);
  const who = (o: OtherSlip) => [o.millCode, pick(o.nameHinglish, o.nameHi)].filter(Boolean).join(" · ");
  const warnFlags = (rst: string, fl: SavedFlags | undefined, grossGrams: number | null, ratePaise: number | null) => {
    if (!fl) { setFlagWarn(null); return; }
    const lines = [
      fl.sameDay.length ? t("daily.flagSameDay", { rst, who: fl.sameDay.map(who).join(", ") }) : "",
      fl.otherDays.length ? t("daily.flagOtherDay", { rst, dates: fl.otherDays.map((o) => `${dmy(o.date)} (${who(o)})`).join(", ") }) : "",
      fl.grossOdd === "large" ? t("daily.flagGrossLarge", { q: f.weight(grossGrams ?? 0) }) : "",
      fl.grossOdd === "small" ? t("daily.flagGrossSmall", { q: f.weight(grossGrams ?? 0) }) : "",
      fl.rateOdd ? t("daily.flagRateFar", { rate: f.rate(ratePaise ?? 0), floor: f.rate(fl.rateOdd.floorPaise), ceil: f.rate(fl.rateOdd.ceilPaise) }) : "",
    ].filter(Boolean);
    setFlagWarn(lines.length ? { rst, lines, saved: true } : null);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheetTotal, setSheetTotal] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState<string | null>(null);

  const rstRef = useRef<HTMLInputElement>(null);
  const adatiRef = useRef<HTMLInputElement>(null);
  const grossRef = useRef<HTMLInputElement>(null);
  const bagsRef = useRef<HTMLInputElement>(null);
  const rateRef = useRef<HTMLInputElement>(null);

  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jinsList = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  /** Commission and gaushala each supplier adds, and what the columns are called (Settings). */
  const sc = useQuery({ queryKey: ["settings", "supplier-charges"], queryFn: () => api.get<SupplierCharges>("/settings/supplier-charges") });
  const terms = sc.data ?? defaultSupplierCharges();
  const colLabel = (c: { key: string; en: string; hi: string }) =>
    c.key === "commission" ? pick(terms.labels.commission, terms.labels.commissionHi)
    : c.key === "gaushala" ? pick(terms.labels.gaushala, terms.labels.gaushalaHi)
    : c.key === "payable" ? pick(terms.labels.payable, terms.labels.payableHi)
    : pick(c.en, c.hi);
  /** A row being typed: what the supplier will add, worked out exactly as the server will —
   *  a new row on today's terms, a row being edited on the terms it was made with. */
  const preview = (amountPaise: number | null, netGrams: number | null, ratePaise: number | null, own: SupplierTerms = terms) =>
    amountPaise === null || netGrams === null || ratePaise === null ? null : slipCharges(amountPaise, netGrams, ratePaise, own);
  const days = useQuery({ queryKey: ["slips", "days"], queryFn: () => api.get<SlipDay[]>("/slips/days") });

  const sheet = useQuery({
    queryKey: ["slips", { date, merchantId, jinsId: filterJins }],
    queryFn: () => api.get<{ rows: Row[]; totals: Totals }>(
      `/slips?${new URLSearchParams({ date, ...(merchantId ? { merchantId } : {}), ...(filterJins ? { jinsId: filterJins } : {}) })}`),
  });

  /* A different day, mill or commodity is a different list: nothing ticked,
     half-edited or said about the old one may carry over to it (a bulk move
     would otherwise reach rows no longer on screen). */
  useEffect(() => {
    setSelected(new Set());
    setEditing(null);
    setErr(null);
    setNotice(null);
    setStaleWarn(null);
    setFlagWarn(null);
    setSheetTotal("");
  }, [date, merchantId, filterJins]);

  // default the commodity to 1509 — it is what almost every sheet carries
  useEffect(() => {
    if (!jinsId && jinsList.data?.length) {
      setJinsId(jinsList.data.find((j) => j.code === "1509")?.id ?? jinsList.data[0].id);
    }
  }, [jinsList.data]);

  const activeMill = mills.data?.find((m) => m.id === merchantId) ?? null;
  const katautiCfg: KatautiConfig = activeMill?.chargeConfig.katauti
    ?? { mode: f.cfg.katautiMode, kgPerUnit: f.cfg.katautiKgPerUnit };

  const d = derive(draft, katautiCfg);
  const rows = sheet.data?.rows ?? [];
  const totals = sheet.data?.totals;
  /** What the ticked rows add up to, for the "are you sure" box. */
  const pickedSummary = () => {
    const picked = rows.filter((r) => selected.has(r.id));
    return [
      { label: t("scan.confirmLines"), value: String(picked.length) },
      { label: t("daily.net"), value: f.weight(picked.reduce((x, r) => x + r.netGrams, 0), { unit: true }) },
      { label: t("daily.amount"), value: f.money(picked.reduce((x, r) => x + r.amountPaise, 0)) },
    ];
  };

  const nextRst = useQuery({
    queryKey: ["slips", "next-rst", date],
    queryFn: () => api.get<{ rstNo: string | null; taken?: string[] }>(`/slips/next-rst?date=${date}`),
  });
  /* The new row's RST against the whole day — every mill and commodity, not
     only the rows this filtered list shows — compared as numbers ("0634" is 634). */
  const rstTaken = useMemo(() => {
    const k = rstKey(draft.rstNo);
    if (!k) return false;
    const taken = nextRst.data?.taken;
    return taken ? taken.includes(k) : rows.some((r) => rstKey(r.rstNo) === k);
  }, [draft.rstNo, rows, nextRst.data]);

  const lastRate = useQuery({
    queryKey: ["slips", "last-rate", draft.adatiId, jinsId],
    queryFn: () => api.get<{ ratePaisePerQtl: number | null; slipDate: string | null }>(
      `/slips/last-rate?adatiId=${draft.adatiId}&jinsId=${jinsId}`),
    enabled: Boolean(draft.adatiId && jinsId),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; approvedParchas?: { parchaNo: string; truckNo: string | null }[]; supplierCreated?: { nameHi: string; nameHinglish: string } | null; flags?: SavedFlags }>("/slips", {
      slipDate: date, rstNo: draft.rstNo.trim(),
      adatiId: draft.adatiId ?? undefined,
      adatiName: draft.adatiId ? undefined : (draft.adatiName?.trim() || undefined),
      jinsId,
      merchantId: merchantId || null,
      grossGrams: d.grossGrams,
      katautiUnits: d.overridden ? d.katautiUnits : null,
      // blank is "rate to be agreed"; anything that does not read as a number never gets here (draftReady)
      ratePaisePerQtl: d.ratePaise ?? 0,
    }),
    onSuccess: async (r) => {
      setErr(null);
      warnStale(r);
      warnFlags(draft.rstNo.trim(), r.flags, d.grossGrams, d.ratePaise);
      if (r.supplierCreated) { setNotice(t("daily.supplierAdded", { name: pick(r.supplierCreated.nameHinglish, r.supplierCreated.nameHi) })); await qc.invalidateQueries({ queryKey: ["adati"] }); }
      // most rows on a sheet share a rate, so keep it unless told otherwise
      setDraft(P.carryRateForward ? { ...emptyDraft(), rate: draft.rate } : emptyDraft());
      await qc.invalidateQueries({ queryKey: ["slips"] });
      rstRef.current?.focus();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const update = useMutation({
    mutationFn: ({ id, draft: dr, grossShown }: { id: string; draft: Draft; grossShown?: string }) => {
      const dd = derive(dr, katautiCfg);
      return api.put<{ supplierCreated?: { nameHi: string; nameHinglish: string } | null; flags?: SavedFlags }>(`/slips/${id}`, {
        rstNo: dr.rstNo.trim(),
        adatiId: dr.adatiId ?? undefined,
        adatiName: dr.adatiId ? undefined : (dr.adatiName?.trim() || undefined),
        ...(dr.jinsId ? { jinsId: dr.jinsId } : {}),
        // an untouched gross is not re-sent: 28.605 shown as 28.61 must not become 28.61
        ...(grossShown !== undefined && dr.gross === grossShown ? {} : { grossGrams: dd.grossGrams }),
        katautiUnits: dd.overridden ? dd.katautiUnits : null,
        ratePaisePerQtl: dd.ratePaise ?? 0,
      });
    },
    onSuccess: async (r, v) => {
      const dd = derive(v.draft, katautiCfg);
      const was = rows.find((x) => x.id === v.id);
      warnFlags(v.draft.rstNo.trim(), r?.flags, v.grossShown !== undefined && v.draft.gross === v.grossShown ? was?.grossGrams ?? dd.grossGrams : dd.grossGrams, dd.ratePaise);
      setEditing(null); setErr(null); warnStale(r);
      if (r?.supplierCreated) { setNotice(t("daily.supplierAdded", { name: pick(r.supplierCreated.nameHinglish, r.supplierCreated.nameHi) })); await qc.invalidateQueries({ queryKey: ["adati"] }); }
      await qc.invalidateQueries({ queryKey: ["slips"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/slips/${id}`),
    onSuccess: async (r) => { warnStale(r); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const setJins = useMutation({
    mutationFn: (to: string) => api.post<{ updated: number }>("/slips/set-jins", { slipIds: [...selected], jinsId: to }),
    onSuccess: async (r, to) => {
      setSelected(new Set());
      setErr(null);
      warnStale(r);
      const code = jinsList.data?.find((j) => j.id === to)?.code ?? "";
      setNotice(t("daily.jinsMoved", { n: r.updated, code }));
      await qc.invalidateQueries({ queryKey: ["slips"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const reassign = useMutation({
    mutationFn: (toMerchant: string | null) => api.post("/slips/reassign", {
      slipIds: [...selected], merchantId: toMerchant,
    }),
    onSuccess: async (r) => { setSelected(new Set()); warnStale(r); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const recompute = useMutation({
    mutationFn: () => api.post<{ scanned: number; changed: number }>("/slips/recompute", { slipDate: date }),
    onSuccess: async (r) => {
      setNotice(t("daily.recomputeDone", { scanned: r.scanned, changed: r.changed }));
      await qc.invalidateQueries({ queryKey: ["slips"] });
    },
  });

  const addSupplier = useMutation({
    mutationFn: (nameHi: string) => api.post<{ id: string }>("/adati", { nameHi }),
    onSuccess: async (r) => {
      setNewSupplierName(null);
      await qc.invalidateQueries({ queryKey: ["adati"] });
      setDraft((p) => ({ ...p, adatiId: r.id }));
      grossRef.current?.focus();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  /* A box with something in it that is not a number is never saved as 0 or
     as blank: the row waits, with that box red. */
  const draftBad = { gross: unreadable(draft.gross), katauti: unreadable(draft.katauti), rate: unreadable(draft.rate) };
  const draftReady =
    draft.rstNo.trim() !== "" && (draft.adatiId !== null || (draft.adatiName ?? "").trim() !== "") &&
    d.grossGrams !== null && d.grossGrams > 0 && d.netGrams !== null && d.netGrams > 0 &&
    !draftBad.gross && !draftBad.katauti && !draftBad.rate;
  /* Figures that look like a lost or extra decimal point, while typing: an
     orange box and a reason. A flag only — Enter still saves. */
  const draftGrossOdd = grossOdd(d.grossGrams);
  const draftRange = totals?.usualRate?.[jinsId] ?? DEFAULT_RATE_RANGE;
  const draftRateOdd = rateOdd(d.ratePaise, draftRange);

  /** Enter walks the row; Enter on the last field saves and starts the next. */
  const step = (next: "adati" | "gross" | "bags" | "rate" | "save") =>
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") { setDraft(emptyDraft()); setErr(null); rstRef.current?.focus(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (next === "adati") adatiRef.current?.focus();
      else if (next === "gross") grossRef.current?.focus();
      else if (next === "bags") bagsRef.current?.focus();
      else if (next === "rate") rateRef.current?.focus();
      else if (draftBad.gross || draftBad.katauti || draftBad.rate) setErr(t("daily.boxUnreadable"));
      else if (draftReady && !create.isPending) create.mutate();
    };

  /** Saving an edited row — the tick and Enter go through here, and send exactly the same. */
  const saveEdit = async () => {
    if (!editing || update.isPending) return;
    const ed = editing.draft;
    if (ed.gross.trim() === "" || unreadable(ed.gross) || unreadable(ed.katauti) || unreadable(ed.rate)) {
      setErr(t("daily.boxUnreadable"));
      return;
    }
    const was = rows.find((x) => x.id === editing.id);
    const rateNow = derive(ed, katautiCfg).ratePaise ?? 0;
    // taking the rate off a priced slip wipes what its supplier is owed: say so first
    if (was && was.ratePaisePerQtl > 0 && rateNow === 0) {
      const ok = await ask({
        title: t("daily.rateOffTitle", { rst: was.rstNo }), message: t("daily.rateOffSub"), danger: true, confirmLabel: t("daily.rateOffGo"),
        rows: [
          { label: t("daily.rate"), value: `${f.rate(was.ratePaisePerQtl)} → —` },
          { label: t("daily.amount"), value: `${f.money(was.amountPaise)} → ${f.money(0)}` },
          { label: pick(terms.labels.payable, terms.labels.payableHi), value: `${f.money(was.payablePaise)} → ${f.money(0)}`, big: true },
        ],
      });
      if (!ok) return;
    }
    update.mutate(editing);
  };

  const sheetTotalGrams = parseQtlToGrams(sheetTotal);
  const sheetDiff = sheetTotalGrams !== null && totals ? totals.netGrams - sheetTotalGrams : null;

  const dayInfo = days.data?.find((x) => x.slipDate === date);

  /* ---------------------------------------------- column-driven rendering */

  /* Select-all means every row of the day. */
  const selectableIds = rows.map((r) => r.id);

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  /* A row cannot be entered without a supplier, so one name column is always
     shown: if both are switched off, the Hindi one comes back. */
  const visibleCols = DAILY_COLUMNS.filter((c) =>
    P.columns[c.key] !== false
    || (c.key === "adatiHi" && P.columns.adatiHi === false && P.columns.adatiLatin === false)
    // with every commodity on screen, each row has to say which one it is
    || (c.key === "jins" && !filterJins));
  // the supplier box lives in the first name column on screen, Hindi or Hinglish
  const nameCol: DailyColumnKey = visibleCols.some((c) => c.key === "adatiHi") ? "adatiHi" : "adatiLatin";
  const PAD = P.density === "compact" ? "py-0.5" : "py-1";
  /* A header's right edge can be dragged to set that column's width; a
     double-click on the edge gives the column back its own width. Widths are
     kept with this computer's layout. */
  const [liveW, setLiveW] = useState<Record<string, number>>({});
  const widthOf = (k: string) => liveW[k] ?? P.widths?.[k];
  const cw = (k: string) => { const w = widthOf(k); return w ? { width: w, minWidth: w, maxWidth: w, overflow: "hidden" as const } : undefined; };
  const startResize = (k: string) => (e: React.MouseEvent<HTMLSpanElement>) => {
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget.parentElement as HTMLElement);
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    let w = w0;
    // one redraw per frame: a season day can have 1,500 rows under this heading
    let frame = 0;
    const move = (ev: MouseEvent) => {
      w = Math.round(Math.min(800, Math.max(40, w0 + ev.clientX - x0)));
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setLiveW((m) => ({ ...m, [k]: w })); });
    };
    const up = () => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      if (frame) cancelAnimationFrame(frame);
      setLiveW((m) => ({ ...m, [k]: w }));
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      if (Math.abs(w - w0) >= 2) void savePrefs({ ...P, widths: { ...(P.widths ?? {}), [k]: w } }).catch(() => undefined);
    };
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  const resetWidth = (k: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setLiveW((m) => { const n = { ...m }; delete n[k]; return n; });
    const rest = { ...(P.widths ?? {}) }; delete rest[k];
    void savePrefs({ ...P, widths: rest }).catch(() => undefined);
  };

  const ordered = useMemo(
    () => sortSlips(rows, P.sortOrder, (r) => (nameCol === "adatiHi" ? r.adatiNameHi : r.adatiNameHinglish || r.adatiNameHi)),
    [rows, P.sortOrder, nameCol],
  );

  /* Clicking the name or RST heading sorts by it: up, down, then back to
     the order entered. The choice lasts for this browser, like the gear's. */
  const SORT_CYCLE: Partial<Record<DailyColumnKey, [SlipSortOrder, SlipSortOrder]>> = {
    adatiHi: ["nameAsc", "nameDesc"], adatiLatin: ["nameAsc", "nameDesc"], rstNo: ["rstAsc", "rstDesc"],
  };
  /* Every other column sorts on the screen only (up, down, off); name and
     RST keep using the list's own order, which downloads follow too. */
  const colSort = useSort(ordered, {
    village: (r) => r.adatiVillage, mill: (r) => r.merchantCode, jins: (r) => r.jinsCode, gross: (r) => r.grossGrams,
    katauti: (r) => r.katautiUnits, deduction: (r) => r.katautiGrams, net: (r) => r.netGrams,
    rate: (r) => (r.ratePending ? null : r.ratePaisePerQtl), amount: (r) => (r.ratePending ? null : r.amountPaise),
    commission: (r) => (r.ratePending ? null : r.commissionPaise), gaushala: (r) => (r.ratePending ? null : r.gaushalaPaise),
    payable: (r) => (r.ratePending ? null : r.payablePaise),
    bagsCount: (r) => r.bagsCount, status: (r) => r.status, sr: () => null,
  }, { storageKey: "daily-cols" });
  const shown = colSort.sorted;
  const sortBy = (key: DailyColumnKey) => {
    const cyc = SORT_CYCLE[key];
    if (!cyc) {
      if (key !== "sr") colSort.th(key).onSort();
      return;
    }
    colSort.setSort(null);
    const next: SlipSortOrder = P.sortOrder === cyc[0] ? cyc[1] : P.sortOrder === cyc[1] ? "entry" : cyc[0];
    void savePrefs({ ...P, sortOrder: next }).catch(() => undefined);
  };
  const sortMark = (key: DailyColumnKey) => {
    const cyc = SORT_CYCLE[key];
    if (!cyc) return colSort.sort?.key === key ? (colSort.sort.dir === "asc" ? "▲" : "▼") : null;
    if (colSort.sort || (key !== nameCol && key !== "rstNo")) return null;
    return P.sortOrder === cyc[0] ? "▲" : P.sortOrder === cyc[1] ? "▼" : null;
  };

  /* The repeat mark comes from the server, which counts the whole day (every
     mill and commodity), so a filtered list still shows it. */
  const rstCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(rstKey(r.rstNo), (m.get(rstKey(r.rstNo)) ?? 0) + 1);
    return m;
  }, [rows]);
  const rstOnDay = (r: Row) => r.rstDay ?? rstCount.get(rstKey(r.rstNo)) ?? 1;

  function displayCell(key: DailyColumnKey, r: Row, i: number) {
    switch (key) {
      case "sr": return <span className="inline-flex items-center gap-1"><span className="num text-[11px] text-faint">{i + 1}</span><TallyMark flag={tallyFlags[r.id]} /></span>;
      case "rstNo": {
        // orange: the same RST again today, or the same RST and weight on another date — a flag, never a block
        const other = r.rstOtherDays ?? [];
        const why = [
          rstOnDay(r) > 1 ? t("daily.rstRepeated") : "",
          other.length ? t("daily.rstOtherDays", { rst: r.rstNo, dates: other.map(dmy).join(", ") }) : "",
        ].filter(Boolean).join(" · ");
        if (!why) return <span className="num font-medium">{r.rstNo}</span>;
        return (
          <span className="inline-flex flex-wrap items-center gap-1" title={why}>
            <span className="num rounded border-2 border-warn px-1 font-medium">{r.rstNo}</span>
            {/* the other date in plain sight, so a tap or a glance is enough */}
            {other.length > 0 && (
              <button type="button" className="num rounded bg-warn-soft px-1 text-[10px] font-medium text-warn"
                aria-label={why} onClick={() => setFlagWarn({ rst: r.rstNo, lines: [why] })}>
                {dmy(other[0]).slice(0, 5)}{other.length > 1 ? ` +${other.length - 1}` : ""}
              </button>
            )}
          </span>
        );
      }
      case "adatiHi": return (
        <span className="flex items-center gap-1.5">
          <span lang="hi" className="truncate text-[14px] text-ink">{r.adatiNameHi}</span>
          {r.scanBatchId && can("scan.review") && (
            <Link href={`/scan/${r.scanBatchId}`} title={t("daily.fromScan")}
              className="shrink-0 text-faint transition-colors hover:text-brand">
              <ImageIcon className="h-3.5 w-3.5" />
            </Link>
          )}
          {r.ratePending && <Badge tone="warn">{t("daily.ratePending")}</Badge>}
        </span>
      );
      case "adatiLatin": return <span className="truncate text-[12px] text-muted">{r.adatiNameHinglish}</span>;
      case "village": return <span className="text-[12px] text-muted">{lang === "hi" ? (r.adatiVillage ?? "") : (r.adatiVillage ?? "")}</span>;
      case "mill": return r.merchantCode ? <Badge tone="neutral" className="num">{r.merchantCode}</Badge> : <span className="text-faint">—</span>;
      case "jins": return <span className="num text-[12px] text-muted">{r.jinsCode}</span>;
      case "gross": return r.grossOdd
        ? <span className="text-warn" title={t(r.grossOdd === "large" ? "daily.grossLargeTip" : "daily.grossSmallTip")}>{f.weight(r.grossGrams)} !</span>
        : f.weight(r.grossGrams);
      case "katauti": return (
        <span className={cn(r.katautiOverride && "text-warn")}>
          {f.int(r.katautiUnits)}
          {r.katautiOverride && <span className="ml-0.5 text-[10px]" title={t("daily.katautiEdited")}>*</span>}
        </span>
      );
      case "deduction": return <span className="text-faint">{f.weight(r.katautiGrams)}</span>;
      case "net": return (
        <span className={cn("font-semibold", r.netMismatchGrams !== 0 && "text-bad")}>
          {f.weight(r.netGrams)}
          {r.netMismatchGrams !== 0 && <span className="ml-1 text-[10px]">({f.weight(r.expectedNetGrams)})</span>}
        </span>
      );
      case "rate": return r.ratePending ? <span className="text-faint">—</span>
        : r.rateOdd
          ? <span className="text-warn" title={t("daily.rateFarTip", { floor: f.rate(r.rateOdd.floorPaise), ceil: f.rate(r.rateOdd.ceilPaise) })}>{f.rate(r.ratePaisePerQtl)} !</span>
          : f.rate(r.ratePaisePerQtl);
      case "amount": return r.ratePending
        ? <span className="text-faint">—</span>
        : <span className="font-semibold">{f.amount(r.amountPaise)}</span>;
      case "commission": return r.ratePending ? <span className="text-faint">—</span> : f.amount(r.commissionPaise);
      case "gaushala": return r.ratePending ? <span className="text-faint">—</span> : f.amount(r.gaushalaPaise);
      case "payable": return r.ratePending
        ? <span className="text-faint">—</span>
        : <span className="font-semibold text-ink">{f.amount(r.payablePaise)}</span>;
      case "bagsCount": return r.bagsCount != null ? f.int(r.bagsCount) : <span className="text-faint">—</span>;
      case "status": return <span className="text-[11px] text-muted">{t(`slip.status.${r.status}` as "slip.status.open")}</span>;
      default: return null;
    }
  }

  function editCell(
    key: DailyColumnKey, ed: Draft,
    dd: ReturnType<typeof derive>, r: Row, i: number,
  ) {
    const upd = (patch: Partial<Draft>) => setEditing((e) => ({ ...e, id: r.id, draft: { ...ed, ...patch } }));
    // the edit keeps the supplier terms the slip was made with, so the preview uses them too
    const own = supplierTermsOf({ supplierTerms: r.supplierTerms ?? null }, terms);
    switch (key) {
      case "sr": return <span className="num text-[11px] text-faint">{i + 1}</span>;
      case "rstNo": return <input className={cn(CELL, "text-left")} value={ed.rstNo} autoFocus
        onChange={(e) => upd({ rstNo: rstTyped(e.target.value) })} />;
      case "adatiHi":
      case "adatiLatin":
        if (key !== nameCol) return displayCell(key, r, i);
        return <SupplierPicker value={ed.adatiId}
          selectedLabel={{ nameHi: r.adatiNameHi, nameHinglish: r.adatiNameHinglish }}
          onChange={(v) => upd({ adatiId: v })} onQueryChange={(q) => upd({ adatiName: q })} />;
      case "gross": return <input className={cn(CELL, (unreadable(ed.gross) || !ed.gross.trim()) && "border-2 border-bad")} value={ed.gross} inputMode="decimal"
        onChange={(e) => upd({ gross: numberOnly(e.target.value) })} />;
      case "katauti": return <input className={cn(CELL, !ed.katauti && "text-faint", unreadable(ed.katauti) && "border-2 border-bad")} inputMode="numeric"
        value={ed.katauti} placeholder={dd.suggested === null ? "" : String(dd.suggested)}
        onChange={(e) => upd({ katauti: numberOnly(e.target.value) })} />;
      case "deduction": return <span className="num text-faint">{dd.katautiGrams === null ? "—" : f.weight(dd.katautiGrams)}</span>;
      case "net": return <span className="num font-semibold">{dd.netGrams === null ? "—" : f.weight(dd.netGrams)}</span>;
      case "rate": return <input className={cn(CELL, unreadable(ed.rate) && "border-2 border-bad")} value={ed.rate} inputMode="decimal" disabled={!can("rate.edit")}
        onChange={(e) => upd({ rate: numberOnly(e.target.value) })}
        onKeyDown={(e) => {
          // Enter saves exactly as the tick does: an untouched gross is not re-sent
          if (e.key === "Enter") { e.preventDefault(); void saveEdit(); }
          if (e.key === "Escape") setEditing(null);
        }} />;
      case "amount": return <span className="num font-semibold">{dd.amountPaise === null ? "—" : f.amount(dd.amountPaise)}</span>;
      case "commission": case "gaushala": case "payable": {
        // a slip carrying no charges of its own keeps its stored ones while its amount and net stand, as the server does
        const p = !r.supplierTerms && dd.amountPaise === r.amountPaise && dd.netGrams === r.netGrams && dd.ratePaise === r.ratePaisePerQtl
          ? { commissionPaise: r.commissionPaise, gaushalaPaise: r.gaushalaPaise, payablePaise: r.payablePaise }
          : preview(dd.amountPaise, dd.netGrams, dd.ratePaise, own);
        return <span className="num text-muted">{p ? f.amount(key === "commission" ? p.commissionPaise : key === "gaushala" ? p.gaushalaPaise : p.payablePaise) : "—"}</span>;
      }
      case "jins": return (
        <select className={cn(CELL, "min-w-[5.5rem] px-1 text-left")} value={ed.jinsId ?? r.jinsId} title={t("daily.jins")}
          onChange={(e) => upd({ jinsId: e.target.value })}>
          {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code}</option>)}
        </select>
      );
      default: return displayCell(key, r, i);
    }
  }

  function totalCell(key: DailyColumnKey) {
    if (!totals) return null;
    switch (key) {
      case "gross": return f.weight(totals.grossGrams);
      case "katauti": return f.int(totals.katautiUnits);
      case "deduction": return <span className="text-muted">{f.weight(totals.katautiGrams)}</span>;
      case "net": return <span className="text-[14px]">{f.weight(totals.netGrams)}</span>;
      case "rate": return (
        <span className="text-[12px] text-muted" title={t("daily.weightedAvg")}>
          {f.rate(totals.weightedAvgRatePaise)}
          {totals.ratePendingRows > 0 && <span className="ml-1 text-[10px] font-normal text-warn">*</span>}
        </span>
      );
      case "amount": return <span className="text-[14px] text-brand">{f.amount(totals.amountPaise)}</span>;
      case "commission": return f.amount(totals.commissionPaise);
      case "gaushala": return f.amount(totals.gaushalaPaise);
      case "payable": return <span className="text-[14px] text-ink">{f.amount(totals.payablePaise)}</span>;
      case "bagsCount": return totals.bagsCount ? f.int(totals.bagsCount) : null;
      default: return null;
    }
  }

  const draftCharges = preview(d.amountPaise, d.netGrams, d.ratePaise);
  const entryRow = canSlip ? (
    <tr className="bg-brand/[0.04]">
      <td className="border-b border-line px-2 py-1.5 text-center">
        <Plus className="mx-auto h-3.5 w-3.5 text-brand" />
      </td>
      {visibleCols.map((c) => (
        <td key={c.key} style={cw(c.key)} className={cn("border-b border-line px-1 py-1.5", NUMERIC.has(c.key) && "text-right")}>
          {c.key === "sr" ? <span className="num text-[11px] text-faint">{rows.length + 1}</span>
            : c.key === "rstNo" ? (
              <input ref={rstRef} className={cn(CELL, "text-left", rstTaken && "border-2 border-warn")}
                value={draft.rstNo} placeholder={t("daily.rstPlaceholder")}
                title={rstTaken ? t("daily.rstTakenTip") : undefined}
                onChange={(e) => setDraft((p) => ({ ...p, rstNo: rstTyped(e.target.value) }))}
                onKeyDown={step("adati")} />
            ) : c.key === nameCol ? (
              <SupplierPicker ref={adatiRef} value={draft.adatiId}
                onChange={(v) => setDraft((p) => ({ ...p, adatiId: v }))}
                onQueryChange={(q) => setDraft((p) => ({ ...p, adatiName: q }))}
                onCommit={() => grossRef.current?.focus()}
                placeholder={t("daily.typeNameAuto")} />
            ) : c.key === "gross" ? (
              <input ref={grossRef} value={draft.gross} inputMode="decimal" placeholder="19.20"
                className={cn(CELL, draftBad.gross ? "border-2 border-bad" : draftGrossOdd && "border-2 border-warn")}
                title={draftBad.gross ? t("daily.boxUnreadable") : draftGrossOdd ? t(draftGrossOdd === "large" ? "daily.grossLargeTip" : "daily.grossSmallTip") : undefined}
                onChange={(e) => setDraft((p) => ({ ...p, gross: numberOnly(e.target.value) }))}
                onKeyDown={step("bags")} />
            ) : c.key === "katauti" ? (
              <input ref={bagsRef} inputMode="numeric" value={draft.katauti}
                className={cn(CELL, !draft.katauti && "text-faint", draftBad.katauti && "border-2 border-bad")}
                placeholder={d.suggested === null ? "" : String(d.suggested)}
                title={t("daily.katautiAuto")}
                onChange={(e) => setDraft((p) => ({ ...p, katauti: numberOnly(e.target.value) }))}
                onKeyDown={step("rate")} />
            ) : c.key === "deduction" ? (
              <span className="num text-faint">{d.katautiGrams === null ? "—" : f.weight(d.katautiGrams)}</span>
            ) : c.key === "net" ? (
              <span className={cn("num font-semibold", d.netGrams !== null && d.netGrams <= 0 && "text-bad")}>
                {d.netGrams === null ? "—" : f.weight(d.netGrams)}
              </span>
            ) : c.key === "rate" ? (
              <input ref={rateRef} value={draft.rate} inputMode="decimal"
                className={cn(CELL, draftBad.rate ? "border-2 border-bad" : draftRateOdd && "border-2 border-warn")}
                title={draftBad.rate ? t("daily.boxUnreadable")
                  : draftRateOdd ? t("daily.rateFarTip", { floor: f.rate(draftRange.floorPaise), ceil: f.rate(draftRange.ceilPaise) })
                  : t("daily.rateBlankTip")}
                disabled={!can("rate.edit")}
                placeholder={lastRate.data?.ratePaisePerQtl ? f.rate(lastRate.data.ratePaisePerQtl) : "3500"}
                onChange={(e) => setDraft((p) => ({ ...p, rate: numberOnly(e.target.value) }))}
                onKeyDown={step("save")} />
            ) : c.key === "amount" ? (
              <span className="num font-semibold text-brand">{d.amountPaise === null ? "—" : f.amount(d.amountPaise)}</span>
            ) : c.key === "commission" || c.key === "gaushala" || c.key === "payable" ? (
              <span className="num text-muted">{draftCharges ? f.amount(c.key === "commission" ? draftCharges.commissionPaise : c.key === "gaushala" ? draftCharges.gaushalaPaise : draftCharges.payablePaise) : "—"}</span>
            ) : c.key === "mill" ? (
              activeMill ? <Badge tone="neutral" className="num">{activeMill.code}</Badge> : <span className="text-faint">—</span>
            ) : c.key === "jins" ? (
              <select className={cn(CELL, "min-w-[5.5rem] px-1 text-left")} value={jinsId} title={t("daily.jinsNew")}
                onChange={(e) => setJinsId(e.target.value)}>
                {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code}</option>)}
              </select>
            ) : null}
        </td>
      ))}
      <td className="border-b border-line px-1 py-1.5">
        <Button size="icon" variant="primary" className="h-7 w-7" loading={create.isPending}
          disabled={!draftReady} onClick={() => create.mutate()} title={t("daily.saveRow")}>
          <Check className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  ) : null;


  return (
    <>
      <PageHeader
        title={t("daily.title")}
        sub={t("daily.sub")}
        action={
          <div className="flex items-center gap-2">
            {!dayClosed && can("day.close") && date <= todayISO() && dayQ.data && (
              <Button size="sm" variant="secondary" icon={<Lock className="h-3.5 w-3.5" />} loading={dayAct.busy}
                onClick={async () => { const fresh = await dayQ.refetch(); if (fresh.data) await dayAct.close(fresh.data); }}>
                {t("dc.closeThisDay")}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => setShowHelp(true)} title={t("daily.keys")} aria-label={t("daily.keys")} />
            <DailyListSettings />
            {can("export.data") && (
              <>
                <Button size="sm" variant="secondary" icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={() => setSharing("list")} title={t("wa.title")}>
                  {t("wa.button")}
                </Button>
                <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => setDownloading("list")} title={t("dl.dara")}>
                  {t("dl.button")}
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* sheet header — mirrors the top of the paper form */}
      <Card className="mb-3">
        <div className="flex flex-wrap items-end gap-3 p-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-faint">{t("daily.date")}</label>
            <div className="flex items-center gap-1">
              <Button size="icon" className="h-8 w-8" onClick={() => setDate(shiftDay(date, -1))} aria-label={t("daily.prevDay")}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())}
                className="h-8 w-[150px] num text-[13px]" />
              <Button size="icon" className="h-8 w-8" onClick={() => setDate(shiftDay(date, 1))} aria-label={t("daily.nextDay")}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDate(todayISO())}>{t("daily.today")}</Button>
            </div>
          </div>

          <div className="min-w-[180px]">
            <label className="mb-1 block text-[11px] font-medium text-faint">{t("daily.mill")}</label>
            <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("daily.allMills")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
            </Select>
          </div>

          <div className="min-w-[160px]">
            <label className="mb-1 block text-[11px] font-medium text-faint">{t("daily.jins")}</label>
            <Select value={filterJins} className="h-8 text-[13px]"
              onChange={(e) => { setFilterJins(e.target.value); if (e.target.value) setJinsId(e.target.value); }}>
              <option value="">{t("daily.allJins")}</option>
              {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2 text-[11px] text-faint">
            <Badge tone="neutral">{t("daily.perBag", { kg: katautiCfg.kgPerUnit })}</Badge>
            {dayInfo && <Badge tone="brand">{t("daily.rowCount", { n: dayInfo.n })}</Badge>}
          </div>
        </div>
      </Card>

      {dayAct.dialog}
      {dayClosed && (
        <Alert tone="brand" className="mb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <Lock className="h-4 w-4 shrink-0" />
              <span><b>{t("dc.dayIsClosed")}</b> {t("dc.closedBy", { by: dayClosed.by ?? "—", at: new Date(dayClosed.at * 1000).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN") })}. {t("dc.dayIsClosedSub")}</span>
            </span>
            {can("day.reopen") && (
              <Button size="sm" variant="secondary" icon={<LockOpen className="h-3.5 w-3.5" />} onClick={() => dayAct.reopen(date)}>{t("dc.reopenBtn")}</Button>
            )}
          </div>
        </Alert>
      )}
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {notice && <Alert tone="ok" className="mb-3">{notice}</Alert>}
      {staleWarn && (
        <Alert tone="warn" className="mb-3" closable={false}>
          <span className="flex items-start justify-between gap-2"><span>{staleWarn}</span>
            <button type="button" className="shrink-0 text-faint hover:text-ink" onClick={() => setStaleWarn(null)} aria-label={t("common.close")}><X className="h-3.5 w-3.5" /></button></span>
        </Alert>
      )}
      {flagWarn && (
        <Alert tone="warn" className="mb-3" closable={false}>
          <span className="flex items-start justify-between gap-2">
            <span>
              <b>{t(flagWarn.saved ? "daily.flagSavedTitle" : "daily.flagTitle", { rst: flagWarn.rst })}</b>
              {flagWarn.lines.map((l, i) => <span key={i} className="block">{l}</span>)}
            </span>
            <button type="button" className="shrink-0 text-faint hover:text-ink" onClick={() => setFlagWarn(null)} aria-label={t("common.close")}><X className="h-3.5 w-3.5" /></button>
          </span>
        </Alert>
      )}
      {totals && (totals.rstOtherDayRows ?? 0) > 0 && (
        <Alert tone="warn" className="mb-3">
          <p className="font-semibold">{t("daily.rstOtherDayRows", { n: totals.rstOtherDayRows ?? 0 })}</p>
          <p>{t("daily.rstOtherDaySub")}</p>
        </Alert>
      )}
      {totals && totals.ratePendingRows > 0 && (
        <Alert tone="warn" className="mb-3">
          <p className="font-semibold">{t("daily.ratePendingRows", { n: totals.ratePendingRows })}</p>
          <p>{t("daily.ratePendingSub")}</p>
        </Alert>
      )}
      {totals && totals.bagWarningRows > 0 && (
        <Alert tone="warn" className="mb-3">
          <p className="font-semibold">{t("daily.bagWarningRows", { n: totals.bagWarningRows })}</p>
          <p>{t("daily.bagWarningSub")}</p>
        </Alert>
      )}
      {totals && totals.mismatchRows > 0 && (
        <Alert tone="warn" className="mb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("daily.mismatchRows", { n: totals.mismatchRows })}
            </span>
            {canSlip && (
              <Button size="sm" variant="secondary" loading={recompute.isPending}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={async () => { if (await ask({ title: t("daily.recompute"), message: t("daily.confirmRecompute", { n: totals?.mismatchRows ?? 0 }) })) recompute.mutate(); }}>
                {t("daily.recompute")}
              </Button>
            )}
          </div>
        </Alert>
      )}

      {selected.size > 0 && (
        <Card className="mb-3">
          <div className="flex flex-wrap items-center gap-2 p-2.5">
            <Badge tone="brand">{t("daily.selectedRows", { n: selected.size })}</Badge>
            {!allSelected && selectableIds.length > selected.size && (
              <Button size="sm" variant="ghost" icon={<CheckSquare className="h-3.5 w-3.5" />}
                onClick={() => setSelected(new Set(selectableIds))}>
                {t("daily.selectAllN", { n: selectableIds.length })}
              </Button>
            )}
            <span className="text-[12px] text-muted">{t("daily.reassign")}:</span>
            {mills.data?.map((m) => (
              <Button key={m.id} size="sm" variant="secondary" loading={reassign.isPending}
                icon={<Truck className="h-3.5 w-3.5" />}
                onClick={async () => {
                  /* Rows already at this mill stay exactly as they are; the rest are
                     worked out again on its katauti — shown before, so nothing moves unseen. */
                  const picked = rows.filter((r) => selected.has(r.id));
                  const moving = picked.filter((r) => r.merchantId !== m.id);
                  const after = moving.map((r) => derive({ ...emptyDraft(), gross: String(r.grossGrams / GRAMS_PER_QTL), katauti: r.katautiOverride ? String(r.katautiUnits) : "", rate: String(r.ratePaisePerQtl / 100) }, m.chargeConfig.katauti));
                  const netNow = moving.reduce((x, r) => x + r.netGrams, 0);
                  const netAfter = after.reduce((x, a) => x + (a.netGrams ?? 0), 0);
                  const amtNow = moving.reduce((x, r) => x + r.amountPaise, 0);
                  const amtAfter = after.reduce((x, a) => x + (a.amountPaise ?? 0), 0);
                  if (await ask({ title: t("daily.confirmMoveTitle", { mill: m.code }), message: t("daily.confirmMoveSub"),
                    rows: [
                      { label: t("daily.mill"), value: `${m.code} — ${pick(m.name, m.nameHi)}`, big: true },
                      { label: t("daily.moveCount"), value: t("daily.moveCountOf", { n: moving.length, stay: picked.length - moving.length }) },
                      { label: t("daily.net"), value: netAfter === netNow ? f.weight(netNow, { unit: true }) : `${f.weight(netNow, { unit: true })} → ${f.weight(netAfter, { unit: true })}` },
                      { label: t("daily.amount"), value: amtAfter === amtNow ? f.money(amtNow) : `${f.money(amtNow)} → ${f.money(amtAfter)}`, big: amtAfter !== amtNow },
                    ],
                    warnings: [amtAfter !== amtNow ? t("daily.moveChangesMoney") : ""] })) reassign.mutate(m.id);
                }}>
                {m.code}
              </Button>
            ))}
            {(jinsList.data?.length ?? 0) > 1 && (
              <>
                <span className="ml-2 text-[12px] text-muted">{t("daily.setJins")}:</span>
                {jinsList.data!.map((j) => (
                  <Button key={j.id} size="sm" variant="secondary" loading={setJins.isPending}
                    onClick={async () => {
                      if (await ask({ title: t("daily.confirmJinsTitle", { code: j.code }),
                        rows: [{ label: t("daily.jins"), value: pick(j.name, j.nameHi), big: true }, ...pickedSummary()] })) setJins.mutate(j.id);
                    }} title={pick(j.name, j.nameHi)}>
                    {j.code}
                  </Button>
                ))}
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} icon={<X className="h-3.5 w-3.5" />} title={t("daily.clearSelection")} aria-label={t("daily.clearSelection")} />
          </div>
        </Card>
      )}

      {/* on a long day: straight to the new row at the bottom, or back to the top */}
      {rows.length > 12 && (
        <div className="no-print fixed bottom-5 right-5 z-30 flex flex-col gap-2">
          <Button size="icon" variant="secondary" className="h-10 w-10 rounded-full shadow-pop" title={t("daily.jumpTop")} aria-label={t("daily.jumpTop")}
            onClick={() => document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" })}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="primary" className="h-10 w-10 rounded-full shadow-pop" title={t("daily.jumpBottom")} aria-label={t("daily.jumpBottom")}
            onClick={() => {
              const main = document.querySelector("main");
              main?.scrollTo({ top: main.scrollHeight, behavior: "smooth" });
              // the new row sits at the bottom: ready to type the next RST
              if (P.newRowPosition === "bottom") setTimeout(() => rstRef.current?.focus({ preventScroll: true }), 450);
            }}>
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      )}
      <Card className="overflow-visible">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-raised/80">
                <th className="w-8 border-b border-line px-2 py-1.5">
                  {canSlip && selectableIds.length > 0 && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={(v) => setSelected(v ? new Set(selectableIds) : new Set())}
                    />
                  )}
                </th>
                {visibleCols.map((c) => (
                  <th key={c.key} style={cw(c.key)}
                    title={c.key === "katauti" ? t("daily.katautiAuto") : c.key !== "sr" ? t("daily.clickToSort") : undefined}
                    onClick={c.key !== "sr" ? () => sortBy(c.key) : undefined}
                    className={cn(
                      "border-b border-line px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted",
                      NUMERIC.has(c.key) ? "text-right" : "text-left",
                      c.key !== "sr" && "cursor-pointer select-none hover:text-ink",
                      "relative", WIDTHS[c.key],
                    )}>
                    <span role="separator" aria-orientation="vertical" title={t("daily.dragWidth")}
                      onMouseDown={startResize(c.key)} onDoubleClick={resetWidth(c.key)} onClick={(e) => e.stopPropagation()}
                      className="absolute right-0 top-0 z-10 h-full w-3 cursor-col-resize border-r-2 border-line/40 hover:border-brand hover:bg-brand/10" />
                    <span title={c.key === "commission" ? t("sc.commissionTip", { pct: terms.commissionPct }) : c.key === "gaushala" ? t("sc.gaushalaTip", { r: terms.gaushalaPerQtl }) : c.key === "payable" ? t("sc.payableTip") : undefined}>{colLabel(c)}</span>
                    {sortMark(c.key) && <span className="ml-1 text-brand">{sortMark(c.key)}</span>}
                    {(c.key === "rate" || c.key === "amount" || c.key === "commission" || c.key === "gaushala" || c.key === "payable") && f.symbol && (
                      <span className="ml-0.5 font-normal normal-case text-faint">{f.symbol}</span>
                    )}
                  </th>
                ))}
                <th className="w-16 border-b border-line px-2 py-1.5" />
              </tr>
            </thead>

            <tbody>
              {sheet.isLoading && (
                <tr><td colSpan={visibleCols.length + 2} className="p-0">
                  <SkeletonTable rows={6} cols={[{ w: "w-12" }, { w: "w-40" }, { w: "w-16", numeric: true }, { w: "w-12", numeric: true }, { w: "w-16", numeric: true }, { w: "w-20", numeric: true }]} />
                </td></tr>
              )}

              {P.newRowPosition === "top" && entryRow}

              {!sheet.isLoading && shown.map((r, i) => {
                if (editing?.id === r.id) {
                  const ed = editing.draft;
                  /* As the server will: a slip keeps the katauti terms it was made
                     with, a corrected weight too (r.katautiCfg). A slip from before
                     those were kept keeps its stored net until its weight or katauti
                     is changed; then the mill's terms of today (r.katautiCfg) apply. */
                  const reweighed = (editing.grossShown === undefined || ed.gross !== editing.grossShown)
                    && parseQtlToGrams(ed.gross) !== r.grossGrams;
                  const katSame = ed.katauti === (r.katautiOverride ? String(r.katautiUnits) : "");
                  // an untouched gross box shows the weight to 2 places; the server keeps the stored grams, so does the preview
                  const kept = editing.grossShown !== undefined && ed.gross === editing.grossShown ? { ...ed, gross: String(r.grossGrams / GRAMS_PER_QTL) } : ed;
                  const worked = derive(kept, r.katautiCfg);
                  const dd = !r.katautiTerms && !reweighed && katSame
                    ? { ...worked, katautiUnits: r.katautiUnits, katautiGrams: r.grossGrams - r.netGrams, netGrams: r.netGrams,
                      amountPaise: worked.ratePaise === r.ratePaisePerQtl ? r.amountPaise : worked.ratePaise === null ? null : Math.round((r.netGrams * worked.ratePaise) / GRAMS_PER_QTL) }
                    : worked;
                  return (
                    <tr key={r.id} className="bg-brand/[0.06]">
                      <td className={cn("border-b border-line/70 px-2", PAD)} />
                      {visibleCols.map((c) => (
                        <td key={c.key} style={cw(c.key)} className={cn("border-b border-line/70 px-1", PAD, NUMERIC.has(c.key) && "text-right")}>
                          {editCell(c.key, ed, dd, r, i)}
                        </td>
                      ))}
                      <td className={cn("border-b border-line/70 px-1", PAD)}>
                        <div className="flex items-center gap-0.5">
                          <Button size="icon" variant="primary" className="h-7 w-7" loading={update.isPending}
                            onClick={() => void saveEdit()} title={t("common.save")} aria-label={t("common.save")}><Check className="h-3.5 w-3.5" /></Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(null)} title={t("common.cancel")} aria-label={t("common.cancel")}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={r.id} className={cn(
                    "transition-colors hover:bg-raised/40",
                    !r.reconciles && "bg-bad-soft/60",
                  )}>
                    <td className={cn("border-b border-line/70 px-2", PAD)}>
                      {canSlip && (
                        <Checkbox checked={selected.has(r.id)} onChange={(v) => {
                          const next = new Set(selected);
                          if (v) next.add(r.id); else next.delete(r.id);
                          setSelected(next);
                        }} />
                      )}
                    </td>
                    {visibleCols.map((c) => (
                      <td key={c.key} style={cw(c.key)} className={cn(
                        "border-b border-line/70 px-2", PAD,
                        NUMERIC.has(c.key) && "num text-right",
                      )}>
                        {displayCell(c.key, r, i)}
                      </td>
                    ))}
                    <td className={cn("border-b border-line/70 px-1", PAD)}>
                      <div className="flex items-center justify-end gap-0.5">
                        {canSlip && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" title={t("common.edit")} aria-label={t("common.edit")}
                            onClick={() => setEditing({
                              id: r.id,
                              grossShown: (r.grossGrams / GRAMS_PER_QTL).toFixed(2),
                              draft: {
                                rstNo: r.rstNo, adatiId: r.adatiId,
                                gross: (r.grossGrams / GRAMS_PER_QTL).toFixed(2),
                                katauti: r.katautiOverride ? String(r.katautiUnits) : "",
                                rate: (r.ratePaisePerQtl / 100).toFixed(2),
                                jinsId: r.jinsId,
                              },
                            })}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canDel && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" title={t("common.delete")} aria-label={t("common.delete")}
                            onClick={async () => {
                              if (await ask({ title: t("daily.confirmDeleteRow", { rst: r.rstNo }), danger: true, confirmLabel: t("confirm.yesDelete"),
                                rows: [{ label: t("daily.supplier"), value: <span lang="hi">{r.adatiNameHi}</span> }, { label: t("daily.net"), value: f.weight(r.netGrams, { unit: true }) }, { label: t("daily.amount"), value: f.money(r.amountPaise) }] })) remove.mutate(r.id);
                            }}>
                            <Trash2 className="h-3.5 w-3.5 text-bad/80" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {P.newRowPosition === "bottom" && entryRow}
            </tbody>

            {totals && totals.rows > 0 && P.showRunningTotal && (
              <tfoot>
                <tr className="bg-raised font-semibold">
                  <td />
                  {visibleCols.map((c, idx) => (
                    <td key={c.key} style={cw(c.key)} className={cn("px-2 py-2", NUMERIC.has(c.key) ? "num text-right" : "text-right")}>
                      {idx === 0 && !NUMERIC.has(c.key)
                        ? <span className="text-[12px] uppercase tracking-wide text-muted">{t("daily.totals")}</span>
                        : totalCell(c.key)}
                    </td>
                  ))}
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {!sheet.isLoading && rows.length === 0 && (
          <EmptyState icon={<Calendar className="h-8 w-8" />}
            title={filterJins || merchantId ? t("daily.emptyFiltered") : t("daily.empty")} sub={t("daily.emptySub")} />
        )}
      </Card>

      {/* cross-check against what is written at the bottom of the paper sheet */}
      {totals && totals.rows > 0 && (
        <Card className="mt-3">
          <div className="flex flex-wrap items-end gap-3 p-3">
            <div className="min-w-[180px]">
              <label className="mb-1 block text-[11px] font-medium text-faint">{t("daily.sheetTotal")}</label>
              <Input value={sheetTotal} onChange={(e) => setSheetTotal(e.target.value)}
                inputMode="decimal" mono placeholder="620.36" className="h-8 text-[13px]" />
              <p className="mt-1 text-[11px] text-faint">{t("daily.sheetTotalSub")}</p>
            </div>
            {sheetDiff !== null && (
              <div className="pb-5">
                {sheetDiff === 0 ? (
                  <Badge tone="ok"><Check className="h-3 w-3" /> {t("daily.matches")}</Badge>
                ) : (
                  <Badge tone="bad">
                    <AlertTriangle className="h-3 w-3" />
                    {t("daily.differsBy", { amount: `${f.weight(Math.abs(sheetDiff))} ${f.unit}` })}
                  </Badge>
                )}
              </div>
            )}
            <div className="ml-auto pb-5 text-right">
              <p className="text-[11px] text-faint">{t("daily.weightedAvg")}</p>
              <p className="num text-lg font-semibold text-ink">{f.rate(totals.weightedAvgRatePaise)}</p>
              {totals.ratePendingRows > 0 && (
                <p className="text-[11px] text-warn">
                  {t("daily.pricedNet")}: {f.weight(totals.pricedNetGrams, { unit: true })}
                </p>
              )}
              {/* what the day's slips put on the suppliers' accounts */}
              {totals.payablePaise !== totals.amountPaise && (
                <p className="mt-1 text-[12px] text-muted">
                  {t("sc.daySummary", { amount: f.money(totals.amountPaise), commission: f.money(totals.commissionPaise), gaushala: f.money(totals.gaushalaPaise) })}
                  {" = "}<b className="num text-ink">{f.money(totals.payablePaise)}</b>
                </p>
              )}
              {f.words(totals.amountPaise) && (
                <p className="text-[11px] text-faint">{f.words(totals.amountPaise)}</p>
              )}
            </div>
          </div>
        </Card>
      )}

      <Dialog open={showHelp} onClose={() => setShowHelp(false)} title={t("daily.keyboardHelp")}>
        <div className="space-y-2 text-[13px]">
          {[
            ["Enter", t("daily.enterToSave")],
            ["Esc", t("daily.escToCancel")],
            ["↓ ↑", t("daily.searchSupplier")],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-3">
              <kbd className="num rounded border border-line bg-raised px-1.5 py-0.5 text-[11px]">{k}</kbd>
              <span className="text-muted">{v}</span>
            </div>
          ))}
          <p className="border-t border-line pt-2 text-[12px] text-faint">{t("daily.netAuto")}</p>
        </div>
      </Dialog>

      <Dialog open={newSupplierName !== null} onClose={() => setNewSupplierName(null)}
        title={t("adati.add")}
        footer={<>
          <Button onClick={() => setNewSupplierName(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={addSupplier.isPending}
            onClick={() => newSupplierName && addSupplier.mutate(newSupplierName)}>
            {t("common.add")}
          </Button>
        </>}>
        <Field label={t("adati.nameHi")} hint={t("adati.nameHiHelp")}>
          <HindiInput value={newSupplierName ?? ""} autoFocus onChange={setNewSupplierName} />
        </Field>
      </Dialog>
      {/* room under the last line, so the round jump buttons never sit on the totals */}
      {rows.length > 12 && <div className="h-24" aria-hidden />}
      {downloading && (
        <DownloadDialog open date={date} merchantId={merchantId} mills={mills.data ?? []} jinsId={filterJins} jinsList={jinsList.data ?? []}
          initial={downloading} onClose={() => setDownloading(null)} />
      )}
      {sharing && (
        <WhatsAppDialog open date={date} merchantId={merchantId} mills={mills.data ?? []} jinsId={filterJins} jinsList={jinsList.data ?? []}
          initial={sharing} onClose={() => setSharing(null)} />
      )}
    </>
  );
}
