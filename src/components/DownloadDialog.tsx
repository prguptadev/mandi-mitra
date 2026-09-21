import { useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import { api, ApiError, type Merchant, type SlipRow, type SlipTotals } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, DAILY_COLUMNS, MILL_REPORT_COLUMNS, type DailyColumnKey } from "@/lib/prefs.tsx";
import { Button, Dialog, Field, Input, Select, Tabs, Alert, Badge } from "@/components/ui/index.tsx";
import { sortSlips, type SlipSortOrder } from "@server/lib/slipOrder.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Everything that leaves the daily list: the list itself as CSV, and the
   report sent to a mill ("dara") as Excel or CSV. Either for one day or a
   from–to range, in the order and columns set in the daily-list settings. */

const Q = 100_000;

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Fetch the Dara (mill report) file and save it; errors come back as ApiError. */
export async function downloadDara(opts: {
  merchantId: string; from: string; to: string; names: "hi" | "latin"; sort: SlipSortOrder;
  format: "xlsx" | "csv"; columns: string[];
}) {
  const qs = new URLSearchParams({
    merchantId: opts.merchantId, from: opts.from, to: opts.to, names: opts.names, sort: opts.sort, format: opts.format,
    ...(opts.columns.length ? { cols: opts.columns.join(",") } : {}),
  });
  const res = await fetch(`/api/reports/mill?${qs}`, { credentials: "same-origin" });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `dara.${opts.format}`;
  save(await res.blob(), name);
}

export function DownloadDialog({ open, onClose, date, merchantId, mills, initial = "list" }: {
  open: boolean; onClose: () => void; date: string; merchantId: string; mills: Merchant[];
  initial?: "list" | "dara";
}) {
  const { t, pick } = useI18n();
  const { prefs } = usePrefs();
  const P = prefs.dailyList;
  const [kind, setKind] = useState<"list" | "dara">(initial);
  const [span, setSpan] = useState<"day" | "range">("day");
  const [day, setDay] = useState(date);
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [mill, setMill] = useState(merchantId);
  const [names, setNames] = useState<"hi" | "latin">(P.exportNameLang);
  const [sort, setSort] = useState<SlipSortOrder>(P.sortOrder);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const f0 = span === "day" ? day : from;
  const t0 = span === "day" ? day : to;
  const daraMill = mill || mills[0]?.id || "";
  const bad = !f0 || !t0 || f0 > t0 || (kind === "dara" && !daraMill);

  const listCsv = async () => {
    const qs = new URLSearchParams({ from: f0, to: t0, ...(mill ? { merchantId: mill } : {}) });
    const data = await api.get<{ rows: SlipRow[]; totals: SlipTotals }>(`/slips?${qs}`);
    const nameOf = (r: SlipRow) => (names === "latin" ? r.adatiNameHinglish || r.adatiNameHi : r.adatiNameHi);
    const rows = sortSlips(data.rows, sort, nameOf);
    const tot = data.totals;

    // one "Adati name" column where either name column was chosen; a date column when several days
    type Col = { key: DailyColumnKey | "date" | "adati"; label: string };
    const cols: Col[] = [];
    for (const c of DAILY_COLUMNS) {
      if (c.key === "adatiLatin") continue;
      if (c.key === "adatiHi") {
        if (P.exportColumns.adatiHi !== false || P.exportColumns.adatiLatin !== false) cols.push({ key: "adati", label: "Adati name" });
        continue;
      }
      if (P.exportColumns[c.key] === false) continue;
      cols.push({ key: c.key, label: c.en });
      if (c.key === "sr" && f0 !== t0) cols.push({ key: "date", label: "Date" });
    }
    if (f0 !== t0 && !cols.some((c) => c.key === "date")) cols.unshift({ key: "date", label: "Date" });

    const val = (k: Col["key"], r: SlipRow, i: number): string | number => {
      switch (k) {
        case "sr": return i + 1;
        case "date": return dmy(r.slipDate);
        case "rstNo": return r.rstNo;
        case "adati": return nameOf(r);
        case "village": return r.adatiVillage ?? "";
        case "mill": return r.merchantCode ?? "";
        case "jins": return r.jinsCode;
        case "gross": return (r.grossGrams / Q).toFixed(2);
        case "katauti": return r.katautiUnits;
        case "deduction": return (r.katautiGrams / Q).toFixed(2);
        case "net": return (r.netGrams / Q).toFixed(2);
        case "rate": return r.ratePending ? "" : (r.ratePaisePerQtl / 100).toFixed(2);
        case "amount": return r.ratePending ? "" : (r.amountPaise / 100).toFixed(2);
        case "bagsCount": return r.bagsCount ?? "";
        case "status": return r.status;
        default: return "";
      }
    };
    const totalVal = (k: Col["key"]): string | number => {
      switch (k) {
        case "rstNo": return "TOTAL";
        case "gross": return (tot.grossGrams / Q).toFixed(2);
        case "katauti": return tot.katautiUnits;
        case "deduction": return (tot.katautiGrams / Q).toFixed(2);
        case "net": return (tot.netGrams / Q).toFixed(2);
        case "rate": return (tot.weightedAvgRatePaise / 100).toFixed(2);
        case "amount": return (tot.amountPaise / 100).toFixed(2);
        case "bagsCount": return tot.bagsCount || "";
        default: return "";
      }
    };
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [
      cols.map((c) => c.label),
      ...rows.map((r, i) => cols.map((c) => val(c.key, r, i))),
      cols.map((c) => totalVal(c.key)),
    ];
    const millCode = mills.find((m) => m.id === mill)?.code;
    save(new Blob(["﻿" + lines.map((l) => l.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }),
      `daily-list-${f0}${f0 === t0 ? "" : `-to-${t0}`}${millCode ? "-" + millCode : ""}.csv`);
  };

  const dara = () => downloadDara({
    merchantId: daraMill, from: f0, to: t0, names, sort, format,
    columns: MILL_REPORT_COLUMNS.filter((c) => P.millReportColumns[c.key]).map((c) => c.key),
  });

  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (kind === "list") await listCsv(); else await dara();
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    } finally {
      setBusy(false);
    }
  };

  const daraCols = MILL_REPORT_COLUMNS.filter((c) => P.millReportColumns[c.key]);

  return (
    <Dialog open={open} onClose={onClose} wide title={t("dl.title")} sub={t("dl.sub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={bad}
          icon={kind === "dara" && format === "xlsx" ? <FileSpreadsheet className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          onClick={go}>{t("dl.download")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Tabs value={kind} onChange={setKind} className="mb-4"
        tabs={[{ value: "list", label: t("dl.list") }, { value: "dara", label: t("dl.dara") }]} />
      <p className="mb-4 text-[13px] text-muted">{kind === "list" ? t("dl.listHelp") : t("dl.daraHelp")}</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("dl.period")}>
          <Select value={span} onChange={(e) => setSpan(e.target.value as typeof span)}>
            <option value="day">{t("dl.oneDay")}</option>
            <option value="range">{t("dl.range")}</option>
          </Select>
        </Field>
        {span === "day" ? (
          <Field label={t("daily.date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("load.from")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t("load.to")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
        )}
        <Field label={t("load.mill")} hint={kind === "dara" ? t("dl.daraMill") : undefined}>
          <Select value={kind === "dara" ? daraMill : mill} onChange={(e) => setMill(e.target.value)}>
            {kind === "list" && <option value="">{t("daily.allMills")}</option>}
            {mills.map((m) => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
          </Select>
        </Field>
        <Field label={t("dlp.namesIn")}>
          <Select value={names} onChange={(e) => setNames(e.target.value as typeof names)}>
            <option value="hi">{t("common.hindi")}</option>
            <option value="latin">{t("common.hinglish")}</option>
          </Select>
        </Field>
        <Field label={t("dlp.sortOrder")}>
          <Select value={sort} onChange={(e) => setSort(e.target.value as SlipSortOrder)}>
            <option value="entry">{t("dlp.sort.entry")}</option>
            <option value="rstAsc">{t("dlp.sort.rstAsc")}</option>
            <option value="rstDesc">{t("dlp.sort.rstDesc")}</option>
            <option value="newestFirst">{t("dlp.sort.newestFirst")}</option>
            <option value="nameAsc">{t("dlp.sort.nameAsc")}</option>
            <option value="nameDesc">{t("dlp.sort.nameDesc")}</option>
          </Select>
        </Field>
        {kind === "dara" && (
          <Field label={t("dl.format")}>
            <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
              <option value="xlsx">Excel</option>
              <option value="csv">CSV</option>
            </Select>
          </Field>
        )}
      </div>

      {kind === "dara" && (
        <div className="mt-4 rounded-lg border border-line bg-raised/40 p-3 text-[12px] text-muted">
          <p className="mb-1.5">{t("dl.daraCols")}</p>
          <div className="flex flex-wrap gap-1.5">
            {daraCols.map((c) => <Badge key={c.key}>{pick(c.en, c.hi)}</Badge>)}
            {span === "range" && from !== to && !daraCols.some((c) => c.key === "date") && <Badge tone="brand">{t("dl.plusDate")}</Badge>}
          </div>
          <p className="mt-1.5 text-faint">{t("dl.daraColsWhere")}</p>
        </div>
      )}
      {f0 > t0 && <p className="mt-3 text-[13px] text-bad">{t("dl.badRange")}</p>}
    </Dialog>
  );
}
