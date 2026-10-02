import { useEffect, useRef, useState } from "react";
import { MessageCircle, Copy, Download, Check } from "lucide-react";
import { ApiError, type Merchant, type Jins } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, MILL_REPORT_COLUMNS } from "@/lib/prefs.tsx";
import { Button, Dialog, Field, Input, Select, Tabs, Alert, Spinner } from "@/components/ui/index.tsx";
import { ExportPreview } from "@/components/ExportPreview.tsx";
import { daraStartJins } from "@/lib/dailyList.ts";
import { buildListTable, buildDaraTable, csvOf, whatsappText, whatsappLink, type ExportTable } from "@/lib/exportTable.ts";
import type { SlipSortOrder } from "@server/lib/slipOrder.ts";

/* The daily list or a mill's dara, sent on WhatsApp. WhatsApp takes text from
   a link (wa.me), never a file: the table goes as a fixed-width message, and
   the CSV is saved here for the operator to attach in the chat that opens. */

function saveFile(text: string, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function WhatsAppDialog({ open, onClose, date, merchantId, mills, jinsId = "", jinsList = [], initial = "list" }: {
  open: boolean; onClose: () => void; date: string; merchantId: string; mills: Merchant[];
  jinsId?: string; jinsList?: Jins[]; initial?: "list" | "dara";
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
  const daraJins = jins || daraStartJins(jinsList);
  // Hinglish lines up in a fixed-width block; Hindi is there for those who want it
  const [names, setNames] = useState<"hi" | "latin">("latin");
  const [sort, setSort] = useState<SlipSortOrder>(P.sortOrder);
  const [phone, setPhone] = useState("");
  const phoneTouched = useRef(false);
  const [table, setTable] = useState<ExportTable | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const f0 = span === "day" ? day : from;
  const t0 = span === "day" ? day : to;
  const daraMill = mill || mills[0]?.id || "";
  const bad = !f0 || !t0 || f0 > t0 || (kind === "dara" && !daraMill);

  // the mill's saved number, until the operator types one
  useEffect(() => {
    if (phoneTouched.current) return;
    const m = mills.find((x) => x.id === (kind === "dara" ? daraMill : mill));
    setPhone(m?.phone ?? "");
  }, [kind, mill, daraMill, mills]);

  // the table follows every choice; a slow answer that is no longer wanted is dropped
  const seq = useRef(0);
  useEffect(() => {
    if (!open || bad) { setTable(null); return; }
    const my = ++seq.current;
    setBusy(true); setErr(null);
    const job = kind === "list"
      ? buildListTable({ from: f0, to: t0, merchantId: mill || undefined, jinsId: jins || undefined, names, sort, prefs: P, mills, jinsList })
      : buildDaraTable({ merchantId: daraMill, from: f0, to: t0, names, sort, jinsId: daraJins || undefined,
        columns: MILL_REPORT_COLUMNS.filter((c) => P.millReportColumns[c.key]).map((c) => c.key) });
    job.then((tb) => { if (my === seq.current) setTable(tb); })
      .catch((e) => { if (my === seq.current) { setTable(null); setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")); } })
      .finally(() => { if (my === seq.current) setBusy(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, f0, t0, mill, daraMill, jins, daraJins, names, sort, bad]);

  const msg = table ? whatsappText(table) : null;
  const empty = table !== null && table.rows.length === 0;

  const copy = async () => {
    if (!msg) return;
    try { await navigator.clipboard.writeText(msg.text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const openWhatsApp = () => {
    if (!msg) return;
    window.open(whatsappLink(phone, msg.text), "_blank", "noopener");
  };

  return (
    <Dialog open={open} onClose={onClose} wide title={t("wa.title")} sub={t("wa.sub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="secondary" disabled={!table || empty} icon={<Download className="h-4 w-4" />}
          onClick={() => table && saveFile(csvOf(table, kind === "dara"), `${table.fileBase}.csv`)}>{t("wa.saveCsv")}</Button>
        <Button variant="secondary" disabled={!msg || empty} icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} onClick={copy}>
          {copied ? t("wa.copied") : t("wa.copy")}
        </Button>
        <Button variant="primary" disabled={!msg || empty} icon={<MessageCircle className="h-4 w-4" />} onClick={openWhatsApp}>{t("wa.open")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Tabs value={kind} onChange={setKind} className="mb-4"
        tabs={[{ value: "list", label: t("dl.list") }, { value: "dara", label: t("dl.dara") }]} />

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
            <option value="latin">{t("common.hinglish")}</option>
            <option value="hi">{t("common.hindi")}</option>
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
        <Field label={t("wa.phone")} hint={t("wa.phoneHint")}>
          <Input value={phone} inputMode="tel" mono placeholder="98765 43210"
            onChange={(e) => { phoneTouched.current = true; setPhone(e.target.value); }} />
        </Field>
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-[12px] font-medium text-muted">{t("wa.preview")}{busy && <Spinner className="ml-2 inline-block h-3 w-3" />}</p>
        {table && !empty && <ExportPreview table={table} />}
        {empty && <p className="rounded-lg border border-line px-3 py-2 text-[13px] text-faint">{t("wa.noRows")}</p>}
        {f0 > t0 && <p className="text-[13px] text-bad">{t("dl.badRange")}</p>}
      </div>

      {msg && !empty && (
        <div className="mt-4">
          <p className="mb-1.5 text-[12px] font-medium text-muted">{t("wa.message")}</p>
          <pre className="max-h-56 overflow-auto whitespace-pre rounded-lg border border-line bg-raised/40 p-3 font-mono text-[12px] leading-snug text-ink">{msg.text}</pre>
          {msg.cut > 0 && <p className="mt-1.5 text-[12px] text-warn">{t("wa.rowsCut", { n: table!.rows.length - msg.cut })}</p>}
        </div>
      )}
      <Alert tone="neutral" className="mt-4">{t("wa.fileNote")}</Alert>
    </Dialog>
  );
}
