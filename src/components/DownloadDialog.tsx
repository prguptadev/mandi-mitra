import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, Eye } from "lucide-react";
import { ApiError, type Merchant, type Jins } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, MILL_REPORT_COLUMNS } from "@/lib/prefs.tsx";
import { Button, Dialog, Field, Input, Select, Tabs, Alert, Badge } from "@/components/ui/index.tsx";
import type { SlipSortOrder } from "@server/lib/slipOrder.ts";
import { buildListTable, buildDaraTable, csvOf, type ExportTable } from "@/lib/exportTable.ts";
import { ExportPreview } from "@/components/ExportPreview.tsx";
import { daraStartJins } from "@/lib/dailyList.ts";

/* Everything that leaves the daily list: the list itself as CSV, and the
   report sent to a mill ("dara") as Excel or CSV. Either for one day or a
   from–to range, in the order and columns set in the daily-list settings. */


function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Fetch a file the server makes and save it under the server's name; errors come back as ApiError. */
export async function fetchAndSave(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  save(await res.blob(), name);
}

/** Fetch the Dara (mill report) file and save it; errors come back as ApiError. */
export async function downloadDara(opts: {
  merchantId: string; from: string; to: string; names: "hi" | "latin"; sort: SlipSortOrder;
  format: "xlsx" | "csv"; columns: string[]; jinsId?: string;
}) {
  const qs = new URLSearchParams({
    merchantId: opts.merchantId, from: opts.from, to: opts.to, names: opts.names, sort: opts.sort, format: opts.format,
    ...(opts.jinsId ? { jinsId: opts.jinsId } : {}),
    ...(opts.columns.length ? { cols: opts.columns.join(",") } : {}),
  });
  await fetchAndSave(`/api/reports/mill?${qs}`, `dara.${opts.format}`);
}

export function DownloadDialog({ open, onClose, date, merchantId, mills, jinsId = "", jinsList = [], initial = "list" }: {
  open: boolean; onClose: () => void; date: string; merchantId: string; mills: Merchant[];
  /** The commodity the list on screen shows ("" = all), and the choices. */
  jinsId?: string; jinsList?: Jins[];
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
  const [jins, setJins] = useState(jinsId);
  // a dara is one commodity's rate: never a blend of paddy and wheat
  const daraJins = jins || daraStartJins(jinsList);
  const [names, setNames] = useState<"hi" | "latin">(P.exportNameLang);
  const [sort, setSort] = useState<SlipSortOrder>(P.sortOrder);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const f0 = span === "day" ? day : from;
  const t0 = span === "day" ? day : to;
  const daraMill = mill || mills[0]?.id || "";
  const bad = !f0 || !t0 || f0 > t0 || (kind === "dara" && !daraMill);

  const listOpts = () => ({ from: f0, to: t0, merchantId: mill || undefined, jinsId: jins || undefined, names, sort, prefs: P, mills, jinsList });
  const daraOpts = () => ({
    merchantId: daraMill, from: f0, to: t0, names, sort, ...(daraJins ? { jinsId: daraJins } : {}),
    columns: MILL_REPORT_COLUMNS.filter((c) => P.millReportColumns[c.key]).map((c) => c.key),
  });
  const listCsv = async () => {
    const table = await buildListTable(listOpts());
    save(new Blob([csvOf(table)], { type: "text/csv;charset=utf-8" }), `${table.fileBase}.csv`);
  };
  const [preview, setPreview] = useState<ExportTable | null>(null);
  const showPreview = async () => {
    setErr(null); setBusy(true);
    try { setPreview(kind === "list" ? await buildListTable(listOpts()) : await buildDaraTable(daraOpts())); }
    catch (e) { setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")); }
    finally { setBusy(false); }
  };
  useEffect(() => { setPreview(null); }, [kind, f0, t0, mill, jins, names, sort]);

  const dara = () => downloadDara({ ...daraOpts(), format });

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
        <Button variant="secondary" disabled={bad || busy} icon={<Eye className="h-4 w-4" />} onClick={showPreview}>{t("dl.preview")}</Button>
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
            {mills.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
          </Select>
        </Field>
        {jinsList.length > 0 && (
          <Field label={t("daily.jins")}>
            <Select value={kind === "dara" ? daraJins : jins} onChange={(e) => setJins(e.target.value)}>
              {kind === "list" && <option value="">{t("daily.allJins")}</option>}
              {jinsList.map((j) => <option key={j.id} value={j.id}>{pick(j.name, j.nameHi)}</option>)}
            </Select>
          </Field>
        )}
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
      {preview && <ExportPreview table={preview} className="mt-4" />}
      {f0 > t0 && <p className="mt-3 text-[13px] text-bad">{t("dl.badRange")}</p>}
    </Dialog>
  );
}
