import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Calendar, Trash2, Truck, AlertTriangle, Check,
  RefreshCw, Download, Keyboard, Lock, Plus, X, Image as ImageIcon, CheckSquare,
} from "lucide-react";
import { api, ApiError, type Jins, type Merchant, type SlipRow, type SlipTotals, type SlipDay, type KatautiConfig } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, parseLooseNumber, parseQtlToGrams, parseRupeesToPaise, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { DailyListSettings } from "@/components/DailyListSettings.tsx";
import { usePrefs, DAILY_COLUMNS, type DailyColumnKey } from "@/lib/prefs.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { HindiInput } from "@/components/HindiInput.tsx";
import { NewLoadDialog } from "@/pages/Loads.tsx";
import {
  Button, Card, Select, Input, Badge, Alert, EmptyState, Dialog, Field, Spinner, Checkbox,
} from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

const todayISO = () => new Date().toLocaleDateString("en-CA");
const shiftDay = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
};

/** The row being typed. Kept as strings so half-typed numbers stay on screen. */
interface Draft {
  rstNo: string;
  adatiId: string | null;
  gross: string;
  /** Left blank unless the sheet's KATAUTI differs from the derived value. */
  katauti: string;
  rate: string;
}
const emptyDraft = (): Draft => ({ rstNo: "", adatiId: null, gross: "", katauti: "", rate: "" });

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

const NUMERIC = new Set<string>(["sr", "gross", "katauti", "deduction", "net", "rate", "amount", "bagsCount"]);
const WIDTHS: Record<string, string> = {
  sr: "w-10", rstNo: "w-20", adatiHi: "min-w-[170px]", adatiLatin: "min-w-[140px]",
  village: "w-28", mill: "w-16", jins: "w-16", gross: "w-24", katauti: "w-20",
  deduction: "w-20", net: "w-24", rate: "w-24", amount: "w-32", bagsCount: "w-16", status: "w-20",
};

const CELL = "h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-ink num text-right placeholder:text-faint focus:border-brand disabled:opacity-60";

export function DailyListPage() {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const { prefs } = usePrefs();
  const P = prefs.dailyList;

  const [date, setDate] = useState(todayISO);
  const [merchantId, setMerchantId] = useState<string>("");
  const [jinsId, setJinsId] = useState<string>("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const days = useQuery({ queryKey: ["slips", "days"], queryFn: () => api.get<SlipDay[]>("/slips/days") });

  const sheet = useQuery({
    queryKey: ["slips", { date, merchantId }],
    queryFn: () => api.get<{ rows: SlipRow[]; totals: SlipTotals }>(
      `/slips?${new URLSearchParams({ date, ...(merchantId ? { merchantId } : {}) })}`),
  });

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

  const rstTaken = useMemo(
    () => draft.rstNo.trim() !== "" && rows.some((r) => r.rstNo === draft.rstNo.trim()),
    [draft.rstNo, rows],
  );

  const nextRst = useQuery({
    queryKey: ["slips", "next-rst", date],
    queryFn: () => api.get<{ rstNo: string | null }>(`/slips/next-rst?date=${date}`),
  });

  const lastRate = useQuery({
    queryKey: ["slips", "last-rate", draft.adatiId, jinsId],
    queryFn: () => api.get<{ ratePaisePerQtl: number | null; slipDate: string | null }>(
      `/slips/last-rate?adatiId=${draft.adatiId}&jinsId=${jinsId}`),
    enabled: Boolean(draft.adatiId && jinsId),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/slips", {
      slipDate: date, rstNo: draft.rstNo.trim(),
      adatiId: draft.adatiId, jinsId,
      merchantId: merchantId || null,
      grossGrams: d.grossGrams,
      katautiUnits: d.overridden ? d.katautiUnits : null,
      ratePaisePerQtl: d.ratePaise ?? 0,
    }),
    onSuccess: async () => {
      setErr(null);
      // most rows on a sheet share a rate, so keep it unless told otherwise
      setDraft(P.carryRateForward ? { ...emptyDraft(), rate: draft.rate } : emptyDraft());
      await qc.invalidateQueries({ queryKey: ["slips"] });
      rstRef.current?.focus();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const update = useMutation({
    mutationFn: ({ id, draft: dr }: { id: string; draft: Draft }) => {
      const dd = derive(dr, katautiCfg);
      return api.put(`/slips/${id}`, {
        rstNo: dr.rstNo.trim(), adatiId: dr.adatiId,
        grossGrams: dd.grossGrams,
        katautiUnits: dd.overridden ? dd.katautiUnits : null,
        ratePaisePerQtl: dd.ratePaise ?? 0,
      });
    },
    onSuccess: async () => { setEditing(null); setErr(null); await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/slips/${id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["slips"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const reassign = useMutation({
    mutationFn: (toMerchant: string | null) => api.post("/slips/reassign", {
      slipIds: [...selected], merchantId: toMerchant,
    }),
    onSuccess: async () => { setSelected(new Set()); await qc.invalidateQueries({ queryKey: ["slips"] }); },
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

  const draftReady =
    draft.rstNo.trim() !== "" && draft.adatiId !== null &&
    d.grossGrams !== null && d.grossGrams > 0 && d.netGrams !== null && d.netGrams > 0;

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
      else if (draftReady && !create.isPending) create.mutate();
    };

  const sheetTotalGrams = parseQtlToGrams(sheetTotal);
  const sheetDiff = sheetTotalGrams !== null && totals ? totals.netGrams - sheetTotalGrams : null;

  const exportCsv = () => {
    const cols = DAILY_COLUMNS.filter((c) => P.exportColumns[c.key] !== false);
    const value = (c: DailyColumnKey, r: SlipRow, i: number): string | number => {
      switch (c) {
        case "sr": return i + 1;
        case "rstNo": return r.rstNo;
        case "adatiHi": return r.adatiNameHi;
        case "adatiLatin": return r.adatiNameHinglish;
        case "village": return r.adatiVillage ?? "";
        case "mill": return r.merchantCode ?? "";
        case "jins": return r.jinsCode;
        case "gross": return (r.grossGrams / GRAMS_PER_QTL).toFixed(2);
        case "katauti": return r.katautiUnits;
        case "deduction": return (r.katautiGrams / GRAMS_PER_QTL).toFixed(2);
        case "net": return (r.netGrams / GRAMS_PER_QTL).toFixed(2);
        case "rate": return r.ratePending ? "" : (r.ratePaisePerQtl / 100).toFixed(2);
        case "amount": return r.ratePending ? "" : (r.amountPaise / 100).toFixed(2);
        case "bagsCount": return r.bagsCount ?? "";
        case "status": return r.status;
        default: return "";
      }
    };
    const totalValue = (c: DailyColumnKey): string | number => {
      if (!totals) return "";
      switch (c) {
        case "rstNo": return "TOTAL";
        case "gross": return (totals.grossGrams / GRAMS_PER_QTL).toFixed(2);
        case "katauti": return totals.katautiUnits;
        case "deduction": return (totals.katautiGrams / GRAMS_PER_QTL).toFixed(2);
        case "net": return (totals.netGrams / GRAMS_PER_QTL).toFixed(2);
        case "rate": return (totals.weightedAvgRatePaise / 100).toFixed(2);
        case "amount": return (totals.amountPaise / 100).toFixed(2);
        case "bagsCount": return totals.bagsCount || "";
        default: return "";
      }
    };
    const header = cols.map((c) => c.en);
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const body = ordered.map((r, i) => cols.map((c) => value(c.key, r, i)));
    const foot = totals ? [cols.map((c) => totalValue(c.key))] : [];
    const csv = [header, ...body, ...foot].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `daily-list-${date}${activeMill ? "-" + activeMill.code : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const dayInfo = days.data?.find((x) => x.slipDate === date);

  /* ---------------------------------------------- column-driven rendering */

  /* Rows already on a load are locked, so they can never be part of a bulk
     action — select-all means "everything I am allowed to move". */
  const selectableIds = rows.filter((r) => !r.loadId).map((r) => r.id);

  /* Selected slips straight onto a truck: one commodity per truck, and the
     sheet's mill is the likely destination when they all share one. */
  const [truckPreset, setTruckPreset] = useState<null | { slipIds: string[]; merchantId: string | null; jinsId: string; date: string; netGrams: number }>(null);
  const putOnTruck = () => {
    const sel = rows.filter((r) => selected.has(r.id) && !r.loadId);
    const jinsIds = [...new Set(sel.map((r) => r.jinsId))];
    if (jinsIds.length !== 1) { setErr(t("daily.mixedJins")); return; }
    const mills = [...new Set(sel.map((r) => r.merchantId))];
    setTruckPreset({
      slipIds: sel.map((r) => r.id), jinsId: jinsIds[0],
      merchantId: mills.length === 1 ? mills[0] : null,
      date, netGrams: sel.reduce((s, r) => s + r.netGrams, 0),
    });
  };
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0;

  /* A row cannot be entered without a supplier, so one name column is always
     shown: if both are switched off, the Hindi one comes back. */
  const visibleCols = DAILY_COLUMNS.filter((c) =>
    P.columns[c.key] !== false
    || (c.key === "adatiHi" && P.columns.adatiHi === false && P.columns.adatiLatin === false));
  // the supplier box lives in the first name column on screen, Hindi or Hinglish
  const nameCol: DailyColumnKey = visibleCols.some((c) => c.key === "adatiHi") ? "adatiHi" : "adatiLatin";
  const PAD = P.density === "compact" ? "py-0.5" : "py-1";

  const ordered = useMemo(() => {
    const list = [...rows];
    if (P.sortOrder === "rstAsc") list.sort((a, b) => (Number(a.rstNo) || 0) - (Number(b.rstNo) || 0));
    else if (P.sortOrder === "rstDesc") list.sort((a, b) => (Number(b.rstNo) || 0) - (Number(a.rstNo) || 0));
    else if (P.sortOrder === "newestFirst") list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [rows, P.sortOrder]);

  const rstCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.rstNo, (m.get(r.rstNo) ?? 0) + 1);
    return m;
  }, [rows]);

  function displayCell(key: DailyColumnKey, r: SlipRow, i: number) {
    switch (key) {
      case "sr": return <span className="num text-[11px] text-faint">{i + 1}</span>;
      case "rstNo": return (rstCount.get(r.rstNo) ?? 0) > 1
        ? <span className="num rounded border-2 border-warn px-1 font-medium" title={t("daily.rstRepeated")}>{r.rstNo}</span>
        : <span className="num font-medium">{r.rstNo}</span>;
      case "adatiHi": return (
        <span className="flex items-center gap-1.5">
          <span lang="hi" className="truncate text-[14px] text-ink">{r.adatiNameHi}</span>
          {r.scanBatchId && (
            <Link href={`/scan/${r.scanBatchId}`} title={t("daily.fromScan")}
              className="shrink-0 text-faint transition-colors hover:text-brand">
              <ImageIcon className="h-3.5 w-3.5" />
            </Link>
          )}
          {r.ratePending && <Badge tone="warn">{t("daily.ratePending")}</Badge>}
          {r.loadId && (
            <Link href={`/loads/${r.loadId}`} title={r.loadStatus === "billed" ? t("daily.lockedRow") : t("daily.onTruckHelp")}>
              <Badge tone={r.loadStatus === "billed" ? "ok" : "neutral"}>
                {r.loadStatus === "billed" ? <Lock className="h-2.5 w-2.5" /> : <Truck className="h-2.5 w-2.5" />}
                {r.loadTruckNo ?? t("daily.onLoad")}
              </Badge>
            </Link>
          )}
        </span>
      );
      case "adatiLatin": return <span className="truncate text-[12px] text-muted">{r.adatiNameHinglish}</span>;
      case "village": return <span className="text-[12px] text-muted">{lang === "hi" ? (r.adatiVillage ?? "") : (r.adatiVillage ?? "")}</span>;
      case "mill": return r.merchantCode ? <Badge tone="neutral" className="num">{r.merchantCode}</Badge> : <span className="text-faint">—</span>;
      case "jins": return <span className="num text-[12px] text-muted">{r.jinsCode}</span>;
      case "gross": return f.weight(r.grossGrams);
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
      case "rate": return r.ratePending ? <span className="text-faint">—</span> : f.rate(r.ratePaisePerQtl);
      case "amount": return r.ratePending
        ? <span className="text-faint">—</span>
        : <span className="font-semibold">{f.amount(r.amountPaise)}</span>;
      case "bagsCount": return r.bagsCount != null ? f.int(r.bagsCount) : <span className="text-faint">—</span>;
      case "status": return <span className="text-[11px] text-muted">{r.status}</span>;
      default: return null;
    }
  }

  function editCell(
    key: DailyColumnKey, ed: Draft,
    dd: ReturnType<typeof derive>, r: SlipRow, i: number,
  ) {
    const upd = (patch: Partial<Draft>) => setEditing({ id: r.id, draft: { ...ed, ...patch } });
    switch (key) {
      case "sr": return <span className="num text-[11px] text-faint">{i + 1}</span>;
      case "rstNo": return <input className={cn(CELL, "text-left")} value={ed.rstNo} autoFocus
        onChange={(e) => upd({ rstNo: e.target.value })} />;
      case "adatiHi":
      case "adatiLatin":
        if (key !== nameCol) return displayCell(key, r, i);
        return <SupplierPicker value={ed.adatiId}
          selectedLabel={{ nameHi: r.adatiNameHi, nameHinglish: r.adatiNameHinglish }}
          onChange={(v) => upd({ adatiId: v })} />;
      case "gross": return <input className={CELL} value={ed.gross} inputMode="decimal"
        onChange={(e) => upd({ gross: e.target.value })} />;
      case "katauti": return <input className={cn(CELL, !ed.katauti && "text-faint")} inputMode="numeric"
        value={ed.katauti} placeholder={dd.suggested === null ? "" : String(dd.suggested)}
        onChange={(e) => upd({ katauti: e.target.value })} />;
      case "deduction": return <span className="num text-faint">{dd.katautiGrams === null ? "—" : f.weight(dd.katautiGrams)}</span>;
      case "net": return <span className="num font-semibold">{dd.netGrams === null ? "—" : f.weight(dd.netGrams)}</span>;
      case "rate": return <input className={CELL} value={ed.rate} inputMode="decimal" disabled={!can("rate.edit")}
        onChange={(e) => upd({ rate: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); update.mutate({ id: r.id, draft: ed }); }
          if (e.key === "Escape") setEditing(null);
        }} />;
      case "amount": return <span className="num font-semibold">{dd.amountPaise === null ? "—" : f.amount(dd.amountPaise)}</span>;
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
      case "bagsCount": return totals.bagsCount ? f.int(totals.bagsCount) : null;
      default: return null;
    }
  }

  const entryRow = can("slip.write") ? (
    <tr className="bg-brand/[0.04]">
      <td className="border-b border-line px-2 py-1.5 text-center">
        <Plus className="mx-auto h-3.5 w-3.5 text-brand" />
      </td>
      {visibleCols.map((c) => (
        <td key={c.key} className={cn("border-b border-line px-1 py-1.5", NUMERIC.has(c.key) && "text-right")}>
          {c.key === "sr" ? <span className="num text-[11px] text-faint">{rows.length + 1}</span>
            : c.key === "rstNo" ? (
              <input ref={rstRef} className={cn(CELL, "text-left", rstTaken && "border-2 border-warn")}
                value={draft.rstNo} placeholder={t("daily.rstPlaceholder")}
                onChange={(e) => setDraft((p) => ({ ...p, rstNo: e.target.value }))}
                onKeyDown={step("adati")} />
            ) : c.key === nameCol ? (
              <SupplierPicker ref={adatiRef} value={draft.adatiId}
                onChange={(v) => setDraft((p) => ({ ...p, adatiId: v }))}
                onCommit={() => grossRef.current?.focus()}
                onCreate={can("adati.write") ? (name) => setNewSupplierName(name) : undefined} />
            ) : c.key === "gross" ? (
              <input ref={grossRef} className={CELL} value={draft.gross} inputMode="decimal" placeholder="19.20"
                onChange={(e) => setDraft((p) => ({ ...p, gross: e.target.value }))}
                onKeyDown={step("bags")} />
            ) : c.key === "katauti" ? (
              <input ref={bagsRef} inputMode="numeric" value={draft.katauti}
                className={cn(CELL, !draft.katauti && "text-faint")}
                placeholder={d.suggested === null ? "" : String(d.suggested)}
                title={t("daily.katautiAuto")}
                onChange={(e) => setDraft((p) => ({ ...p, katauti: e.target.value }))}
                onKeyDown={step("rate")} />
            ) : c.key === "deduction" ? (
              <span className="num text-faint">{d.katautiGrams === null ? "—" : f.weight(d.katautiGrams)}</span>
            ) : c.key === "net" ? (
              <span className={cn("num font-semibold", d.netGrams !== null && d.netGrams <= 0 && "text-bad")}>
                {d.netGrams === null ? "—" : f.weight(d.netGrams)}
              </span>
            ) : c.key === "rate" ? (
              <input ref={rateRef} className={CELL} value={draft.rate} inputMode="decimal"
                disabled={!can("rate.edit")}
                placeholder={lastRate.data?.ratePaisePerQtl ? f.rate(lastRate.data.ratePaisePerQtl) : "3500"}
                onChange={(e) => setDraft((p) => ({ ...p, rate: e.target.value }))}
                onKeyDown={step("save")} />
            ) : c.key === "amount" ? (
              <span className="num font-semibold text-brand">{d.amountPaise === null ? "—" : f.amount(d.amountPaise)}</span>
            ) : c.key === "mill" ? (
              activeMill ? <Badge tone="neutral" className="num">{activeMill.code}</Badge> : <span className="text-faint">—</span>
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
            <Button size="sm" variant="ghost" icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => setShowHelp(true)} />
            <DailyListSettings />
            {can("export.data") && (
              <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCsv} disabled={!rows.length}>
                CSV
              </Button>
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
            <Select value={jinsId} onChange={(e) => setJinsId(e.target.value)} className="h-8 text-[13px]">
              {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2 text-[11px] text-faint">
            <Badge tone="neutral">{t("daily.perBag", { kg: katautiCfg.kgPerUnit })}</Badge>
            {dayInfo && <Badge tone="brand">{t("daily.rowCount", { n: dayInfo.n })}</Badge>}
          </div>
        </div>
      </Card>

      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {notice && <Alert tone="ok" className="mb-3">{notice}</Alert>}
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
            {can("slip.write") && (
              <Button size="sm" variant="secondary" loading={recompute.isPending}
                icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => recompute.mutate()}>
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
            {can("load.write") && (
              <Button size="sm" variant="primary" icon={<Truck className="h-3.5 w-3.5" />} onClick={putOnTruck}>
                {t("daily.putOnTruck")}
              </Button>
            )}
            <span className="text-[12px] text-muted">{t("daily.reassign")}:</span>
            {mills.data?.map((m) => (
              <Button key={m.id} size="sm" variant="secondary" loading={reassign.isPending}
                icon={<Truck className="h-3.5 w-3.5" />} onClick={() => reassign.mutate(m.id)}>
                {m.code}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} icon={<X className="h-3.5 w-3.5" />} />
          </div>
        </Card>
      )}

      <Card className="overflow-visible">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-raised/80">
                <th className="w-8 border-b border-line px-2 py-1.5">
                  {can("slip.write") && selectableIds.length > 0 && (
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={(v) => setSelected(v ? new Set(selectableIds) : new Set())}
                    />
                  )}
                </th>
                {visibleCols.map((c) => (
                  <th key={c.key}
                    title={c.key === "katauti" ? t("daily.katautiAuto") : undefined}
                    className={cn(
                      "border-b border-line px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted",
                      NUMERIC.has(c.key) ? "text-right" : "text-left",
                      WIDTHS[c.key],
                    )}>
                    {pick(c.en, c.hi)}
                    {(c.key === "rate" || c.key === "amount") && f.symbol && (
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

              {!sheet.isLoading && ordered.map((r, i) => {
                // on a draft truck a slip can still be corrected; an approved parcha locks it
                const locked = r.loadStatus === "billed";
                if (editing?.id === r.id) {
                  const ed = editing.draft;
                  const dd = derive(ed, r.katautiCfg);
                  return (
                    <tr key={r.id} className="bg-brand/[0.06]">
                      <td className={cn("border-b border-line/70 px-2", PAD)} />
                      {visibleCols.map((c) => (
                        <td key={c.key} className={cn("border-b border-line/70 px-1", PAD, NUMERIC.has(c.key) && "text-right")}>
                          {editCell(c.key, ed, dd, r, i)}
                        </td>
                      ))}
                      <td className={cn("border-b border-line/70 px-1", PAD)}>
                        <div className="flex items-center gap-0.5">
                          <Button size="icon" variant="primary" className="h-7 w-7" loading={update.isPending}
                            onClick={() => update.mutate(editing)}><Check className="h-3.5 w-3.5" /></Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(null)}>
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
                    locked && "opacity-75",
                  )}>
                    <td className={cn("border-b border-line/70 px-2", PAD)}>
                      {!r.loadId && can("slip.write") && (
                        <Checkbox checked={selected.has(r.id)} onChange={(v) => {
                          const next = new Set(selected);
                          if (v) next.add(r.id); else next.delete(r.id);
                          setSelected(next);
                        }} />
                      )}
                    </td>
                    {visibleCols.map((c) => (
                      <td key={c.key} className={cn(
                        "border-b border-line/70 px-2", PAD,
                        NUMERIC.has(c.key) && "num text-right",
                      )}>
                        {displayCell(c.key, r, i)}
                      </td>
                    ))}
                    <td className={cn("border-b border-line/70 px-1", PAD)}>
                      <div className="flex items-center justify-end gap-0.5">
                        {can("slip.write") && !locked && (
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => setEditing({
                              id: r.id,
                              draft: {
                                rstNo: r.rstNo, adatiId: r.adatiId,
                                gross: (r.grossGrams / GRAMS_PER_QTL).toFixed(2),
                                katauti: r.katautiOverride ? String(r.katautiUnits) : "",
                                rate: (r.ratePaisePerQtl / 100).toFixed(2),
                              },
                            })}>
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {can("slip.delete") && !r.loadId && (
                          <Button size="icon" variant="ghost" className="h-7 w-7"
                            onClick={() => { if (confirm(t("daily.confirmDeleteRow", { rst: r.rstNo }))) remove.mutate(r.id); }}>
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
                    <td key={c.key} className={cn("px-2 py-2", NUMERIC.has(c.key) ? "num text-right" : "text-right")}>
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
          <EmptyState icon={<Calendar className="h-8 w-8" />} title={t("daily.empty")} sub={t("daily.emptySub")} />
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
      {truckPreset && (
        <NewLoadDialog open preset={truckPreset}
          onClose={() => { setTruckPreset(null); setSelected(new Set()); }} />
      )}
    </>
  );
}
