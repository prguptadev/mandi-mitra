import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FileSpreadsheet } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, SUPPLIER_SHEET_COLUMNS, type DailyListPrefs } from "@/lib/prefs.tsx";
import { fyStartOf } from "@/lib/fy.tsx";
import { Button, Dialog, Field, Input, Select, Alert, Checkbox } from "@/components/ui/index.tsx";
import { fetchAndSave } from "@/components/DownloadDialog.tsx";
import { defaultSupplierCharges, type SupplierCharges } from "@server/lib/supplierTerms.ts";
import { dmy } from "@server/lib/parchaLabels.ts";

/* The supplier pay sheet, from the ledger: one row per adati, what his
   purchases in the period came to and what is left to pay him at its end, as
   Excel or CSV. Till date runs from 1 April of that financial year. The names
   come in Hindi or Hinglish; the columns ticked here are kept for next time on
   this computer. Every figure in the file is the server's own sum. */

const aprilOf = (iso: string) => (iso ? `${fyStartOf(iso)}-04-01` : "");

export function PaySheetDialog({ onClose, date }: { onClose: () => void; date: string }) {
  const { t, pick } = useI18n();
  const { prefs, save } = usePrefs();
  const P = prefs.dailyList;
  // commission, gaushala and net amount go by the names set in Settings
  const sc = useQuery({ queryKey: ["settings", "supplier-charges"], queryFn: () => api.get<SupplierCharges>("/settings/supplier-charges") });
  const L = (sc.data ?? defaultSupplierCharges()).labels;
  const label = (c: { key: string; en: string; hi: string }) =>
    c.key === "commission" ? pick(L.commission, L.commissionHi) : c.key === "gaushala" ? pick(L.gaushala, L.gaushalaHi)
    : c.key === "payable" ? pick(L.payable, L.payableHi) : pick(c.en, c.hi);

  const [mode, setMode] = useState<"till" | "day" | "range">("till");
  const [day, setDay] = useState(date);
  const [from, setFrom] = useState(aprilOf(date));
  const [to, setTo] = useState(date);
  const [names, setNames] = useState<DailyListPrefs["supplierSheetNames"]>(P.supplierSheetNames === "hinglish" ? "hinglish" : "hi");
  const [cols, setCols] = useState<Record<string, boolean>>({ ...P.paySheetColumns, name: true });
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // the period exactly as the file's second line will say it
  const start = mode === "till" ? aprilOf(day) : mode === "day" ? day : from;
  const end = mode === "range" ? to : day;
  const reversed = Boolean(start && end && start > end);
  const bad = !start || !end || reversed;
  // the same words as the file's second line (sheetPeriod in supplierSheet.ts)
  const period = bad ? "" : start === end ? dmy(end) : `${dmy(start)} to ${dmy(end)}`;

  const go = async () => {
    setErr(null);
    setBusy(true);
    try {
      const keys = SUPPLIER_SHEET_COLUMNS.filter((c) => cols[c.key]).map((c) => c.key);
      const qs = new URLSearchParams({ mode, names, format, cols: keys.join(","), ...(mode === "range" ? { from, to } : { date: day }) });
      await fetchAndSave(`/api/ledger/sheet?${qs}`, `pay-sheet.${format}`);
      // kept for next time, on this computer
      const changed = names !== P.supplierSheetNames
        || SUPPLIER_SHEET_COLUMNS.some((c) => Boolean(cols[c.key]) !== Boolean(P.paySheetColumns[c.key]));
      if (changed) void save({ ...P, paySheetColumns: cols, supplierSheetNames: names }).catch(() => undefined);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} wide title={t("sheet.title")} sub={t("sheet.sub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={busy} disabled={bad}
          icon={format === "xlsx" ? <FileSpreadsheet className="h-4 w-4" /> : <Download className="h-4 w-4" />}
          onClick={go}>{t("dl.download")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("dl.period")}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="till">{t("sheet.till")}</option>
            <option value="day">{t("dl.oneDay")}</option>
            <option value="range">{t("dl.range")}</option>
          </Select>
        </Field>
        {mode === "range" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("load.from")}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t("load.to")}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
        ) : (
          <Field label={t("daily.date")}>
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        )}
        <Field label={t("sheet.names")}>
          <Select value={names} onChange={(e) => setNames(e.target.value as typeof names)}>
            <option value="hi">{t("common.hindi")}</option>
            <option value="hinglish">{t("common.hinglish")}</option>
          </Select>
        </Field>
        <Field label={t("dl.format")}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
          </Select>
        </Field>
      </div>
      <p className="mt-3 text-[13px] text-muted">
        {reversed ? <span className="text-bad">{t("dl.badRange")}</span> : <>
          {period && <><span className="num font-medium text-ink">{period}</span> · </>}
          {mode === "day" ? t("sheet.whoDay") : t("sheet.whoPeriod")}
        </>}
      </p>

      <div className="mt-4 rounded-lg border border-line bg-raised/40 p-3">
        <p className="mb-2 text-[12px] text-muted">{t("sheet.columns")}</p>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
          {SUPPLIER_SHEET_COLUMNS.map((c) => (
            <Checkbox key={c.key} checked={Boolean(cols[c.key])} disabled={c.key === "name"}
              onChange={(v) => setCols((p) => ({ ...p, [c.key]: v }))} label={label(c)} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}
