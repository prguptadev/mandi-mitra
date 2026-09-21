import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Settings2, RotateCcw, Lock, Monitor, Download } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, DAILY_COLUMNS, LOCKED_COLUMNS, MILL_REPORT_COLUMNS, type DailyListPrefs } from "@/lib/prefs.tsx";
import { Button, Dialog, Field, Select, Switch, Checkbox } from "@/components/ui/index.tsx";
import { defaultSupplierCharges, type SupplierCharges } from "@server/lib/supplierTerms.ts";

/**
 * How the daily list looks on this computer, in four plain sections: how rows
 * are entered, which columns show (on screen and in the download, side by
 * side), how downloads are written, and what the mill's dara report carries.
 * One Save keeps it on this computer for the person signed in.
 */
export function DailyListSettings() {
  const { t, pick } = useI18n();
  const { prefs, save, reset, saving } = usePrefs();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DailyListPrefs | null>(null);
  const sc = useQuery({ queryKey: ["settings", "supplier-charges"], queryFn: () => api.get<SupplierCharges>("/settings/supplier-charges"), enabled: open });
  const L = (sc.data ?? defaultSupplierCharges()).labels;
  const nameOf = (c: { key: string; en: string; hi: string }) =>
    c.key === "commission" ? pick(L.commission, L.commissionHi) : c.key === "gaushala" ? pick(L.gaushala, L.gaushalaHi)
    : c.key === "payable" ? pick(L.payable, L.payableHi) : pick(c.en, c.hi);

  const d = draft ?? prefs.dailyList;
  const set = <K extends keyof DailyListPrefs>(k: K, v: DailyListPrefs[K]) => setDraft({ ...d, [k]: v });
  const flip = (group: "columns" | "exportColumns" | "millReportColumns", key: string) => {
    if (group === "columns" && LOCKED_COLUMNS.includes(key as never)) return;
    // a download has one "Adati name" column; it stands for both name keys
    if (group === "exportColumns" && (key === "adatiHi" || key === "adatiLatin")) {
      const on = !(d.exportColumns.adatiHi || d.exportColumns.adatiLatin);
      setDraft({ ...d, exportColumns: { ...d.exportColumns, adatiHi: on, adatiLatin: on } });
      return;
    }
    setDraft({ ...d, [group]: { ...d[group], [key]: !d[group][key] } });
  };
  const close = () => { setOpen(false); setDraft(null); };
  const section = "rounded-xl border border-line p-4";
  const heading = "mb-3 text-[13px] font-semibold text-ink";

  return (
    <>
      <Button size="sm" variant="ghost" icon={<Settings2 className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)} title={t("dlp.title")} aria-label={t("dlp.title")} />

      <Dialog open={open} onClose={close} wide title={t("dlp.title")} sub={t("dlp.subHere")}
        footer={<>
          <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={saving}
            onClick={async () => { await reset(); close(); }}>{t("dlp.reset")}</Button>
          <div className="flex-1" />
          <Button onClick={close}>{t("common.cancel")}</Button>
          <Button variant="primary" icon={<Monitor className="h-3.5 w-3.5" />} loading={saving} disabled={!draft}
            onClick={async () => { await save(d); close(); }}>{t("dlp.saveHere")}</Button>
        </>}>
        <div className="space-y-4">
          {/* 1. entering rows */}
          <div className={section}>
            <p className={heading}>{t("dlp.sectionEntry")}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("dlp.newRow")}>
                <Select value={d.newRowPosition} className="h-9 text-[13px]"
                  onChange={(e) => set("newRowPosition", e.target.value as DailyListPrefs["newRowPosition"])}>
                  <option value="bottom">{t("dlp.newRow.bottom")}</option>
                  <option value="top">{t("dlp.newRow.top")}</option>
                </Select>
              </Field>
              <Field label={t("dlp.sortOrder")}>
                <Select value={d.sortOrder} className="h-9 text-[13px]"
                  onChange={(e) => set("sortOrder", e.target.value as DailyListPrefs["sortOrder"])}>
                  <option value="entry">{t("dlp.sort.entry")}</option>
                  <option value="rstAsc">{t("dlp.sort.rstAsc")}</option>
                  <option value="rstDesc">{t("dlp.sort.rstDesc")}</option>
                  <option value="newestFirst">{t("dlp.sort.newestFirst")}</option>
                  <option value="nameAsc">{t("dlp.sort.nameAsc")}</option>
                  <option value="nameDesc">{t("dlp.sort.nameDesc")}</option>
                </Select>
              </Field>
              <Field label={t("dlp.density")}>
                <Select value={d.density} className="h-9 text-[13px]"
                  onChange={(e) => set("density", e.target.value as DailyListPrefs["density"])}>
                  <option value="normal">{t("dlp.density.normal")}</option>
                  <option value="compact">{t("dlp.density.compact")}</option>
                </Select>
              </Field>
            </div>
            <div className="mt-3 space-y-2">
              <Switch checked={d.carryRateForward} onChange={(v) => set("carryRateForward", v)} label={t("dlp.carryRate")} />
              <Switch checked={d.showRunningTotal} onChange={(v) => set("showRunningTotal", v)} label={t("dlp.showRunningTotal")} />
            </div>
          </div>

          {/* 2. columns: on screen and in the download, side by side */}
          <div className={section}>
            <p className={heading}>{t("dlp.sectionColumns")}</p>
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="grid grid-cols-[1fr_7rem_7rem] bg-raised/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <span>{t("dlp.column")}</span>
                <span className="flex items-center justify-center gap-1"><Monitor className="h-3 w-3" />{t("dlp.onScreen")}</span>
                <span className="flex items-center justify-center gap-1"><Download className="h-3 w-3" />{t("dlp.inDownload")}</span>
              </div>
              <div className="max-h-[40vh] divide-y divide-line overflow-y-auto">
                {DAILY_COLUMNS.map((c) => {
                  const locked = LOCKED_COLUMNS.includes(c.key as never);
                  const inDl = c.key === "adatiHi" || c.key === "adatiLatin"
                    ? Boolean(d.exportColumns.adatiHi || d.exportColumns.adatiLatin) : Boolean(d.exportColumns[c.key]);
                  return (
                    <div key={c.key} className="grid grid-cols-[1fr_7rem_7rem] items-center px-3 py-1.5 text-[13px]">
                      <span className="flex items-center gap-1.5 text-ink">{nameOf(c)}{locked && <Lock className="h-3 w-3 text-faint" aria-label={t("dlp.locked")} />}</span>
                      <span className="flex justify-center">
                        <Checkbox checked={locked ? true : Boolean(d.columns[c.key])} disabled={locked} onChange={() => flip("columns", c.key)} aria-label={`${nameOf(c)} — ${t("dlp.onScreen")}`} />
                      </span>
                      <span className="flex justify-center">
                        {c.key === "adatiLatin"
                          ? <span className="text-[11px] text-faint">{t("dlp.oneNameColumn")}</span>
                          : <Checkbox checked={inDl} onChange={() => flip("exportColumns", c.key)} aria-label={`${nameOf(c)} — ${t("dlp.inDownload")}`} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-faint">{t("dlp.lockedNote")}</p>
          </div>

          {/* 3. downloads */}
          <div className={section}>
            <p className={heading}>{t("dlp.sectionDownload")}</p>
            <Field label={t("dlp.namesIn")} className="max-w-xs">
              <Select value={d.exportNameLang} className="h-9 text-[13px]"
                onChange={(e) => set("exportNameLang", e.target.value as DailyListPrefs["exportNameLang"])}>
                <option value="hi">{t("common.hindi")}</option>
                <option value="latin">{t("common.hinglish")}</option>
              </Select>
            </Field>
          </div>

          {/* 4. the report sent to a mill */}
          <div className={section}>
            <p className={heading}>{t("dlp.millReportColumns")}</p>
            <p className="-mt-2 mb-3 text-[12px] leading-snug text-muted">{t("dlp.millReportHelp")}</p>
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
              {MILL_REPORT_COLUMNS.map((c) => (
                <Checkbox key={c.key} checked={Boolean(d.millReportColumns[c.key])}
                  onChange={() => flip("millReportColumns", c.key)} label={pick(c.en, c.hi)} />
              ))}
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
