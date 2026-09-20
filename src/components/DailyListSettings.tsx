import { useState } from "react";
import { Settings2, RotateCcw, Monitor, User, Lock } from "lucide-react";
import { useI18n } from "@/lib/i18n.tsx";
import { usePrefs, DAILY_COLUMNS, LOCKED_COLUMNS, type DailyListPrefs } from "@/lib/prefs.tsx";
import { Button, Dialog, Field, Select, Switch, Checkbox, Badge, Alert } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Per-screen layout controls. Any user can change them; the scope buttons
 * decide whether the change lives in this browser or follows their login.
 */
export function DailyListSettings() {
  const { t, pick } = useI18n();
  const { prefs, sessionOverride, setForSession, setForUser, clearSession, resetAll, saving } = usePrefs();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DailyListPrefs | null>(null);

  const d = draft ?? prefs.dailyList;
  const set = <K extends keyof DailyListPrefs>(k: K, v: DailyListPrefs[K]) =>
    setDraft({ ...d, [k]: v });

  const toggleCol = (group: "columns" | "exportColumns", key: string) => {
    if (group === "columns" && LOCKED_COLUMNS.includes(key as never)) return;
    setDraft({ ...d, [group]: { ...d[group], [key]: !d[group][key] } });
  };

  const close = () => { setOpen(false); setDraft(null); };

  return (
    <>
      <Button size="sm" variant="ghost" icon={<Settings2 className="h-3.5 w-3.5" />}
        onClick={() => setOpen(true)} title={t("dlp.title")}>
        {sessionOverride && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
      </Button>

      <Dialog open={open} onClose={close} wide title={t("dlp.title")} sub={t("dlp.sub")}
        footer={
          <>
            <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />}
              loading={saving} onClick={async () => { await resetAll(); close(); }}>
              {t("dlp.reset")}
            </Button>
            <div className="flex-1" />
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="secondary" icon={<Monitor className="h-3.5 w-3.5" />}
              disabled={!draft} onClick={() => { setForSession(d); close(); }}>
              {t("dlp.applySession")}
            </Button>
            <Button variant="primary" icon={<User className="h-3.5 w-3.5" />}
              loading={saving} disabled={!draft}
              onClick={async () => { await setForUser(d); close(); }}>
              {t("dlp.applyUser")}
            </Button>
          </>
        }>
        <div className="space-y-4">
          {sessionOverride && (
            <Alert tone="warn">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("dlp.sessionActive")}</span>
                <Button size="sm" variant="secondary"
                  onClick={() => { clearSession(); setDraft(null); }}>{t("dlp.clearSession")}</Button>
              </div>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("dlp.newRow")}>
              <Select value={d.newRowPosition} className="h-8 text-[13px]"
                onChange={(e) => set("newRowPosition", e.target.value as DailyListPrefs["newRowPosition"])}>
                <option value="bottom">{t("dlp.newRow.bottom")}</option>
                <option value="top">{t("dlp.newRow.top")}</option>
              </Select>
            </Field>
            <Field label={t("dlp.sortOrder")}>
              <Select value={d.sortOrder} className="h-8 text-[13px]"
                onChange={(e) => set("sortOrder", e.target.value as DailyListPrefs["sortOrder"])}>
                <option value="entry">{t("dlp.sort.entry")}</option>
                <option value="rstAsc">{t("dlp.sort.rstAsc")}</option>
                <option value="rstDesc">{t("dlp.sort.rstDesc")}</option>
                <option value="newestFirst">{t("dlp.sort.newestFirst")}</option>
              </Select>
            </Field>
            <Field label={t("dlp.density")}>
              <Select value={d.density} className="h-8 text-[13px]"
                onChange={(e) => set("density", e.target.value as DailyListPrefs["density"])}>
                <option value="normal">{t("dlp.density.normal")}</option>
                <option value="compact">{t("dlp.density.compact")}</option>
              </Select>
            </Field>
          </div>

          <div className="space-y-2.5 rounded-lg border border-line p-3">
            <Switch checked={d.carryRateForward} onChange={(v) => set("carryRateForward", v)}
              label={t("dlp.carryRate")} />
            <Switch checked={d.showRunningTotal} onChange={(v) => set("showRunningTotal", v)}
              label={t("dlp.showRunningTotal")} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {(["columns", "exportColumns"] as const).map((group) => (
              <div key={group} className="rounded-lg border border-line p-3">
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
                  {t(group === "columns" ? "dlp.uiColumns" : "dlp.exportColumns")}
                </p>
                <div className="space-y-1.5">
                  {DAILY_COLUMNS.map((c) => {
                    const locked = group === "columns" && LOCKED_COLUMNS.includes(c.key as never);
                    return (
                      <div key={c.key} className="flex items-center justify-between gap-2">
                        <Checkbox
                          checked={locked ? true : Boolean(d[group][c.key])}
                          disabled={locked}
                          onChange={() => toggleCol(group, c.key)}
                          label={pick(c.en, c.hi)}
                        />
                        {locked && (
                          <Badge title={t("dlp.locked")}><Lock className="h-2.5 w-2.5" /></Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-line bg-raised/40 p-3 text-[12px] leading-relaxed text-muted">
            <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
              <Monitor className="h-3.5 w-3.5" /> {t("dlp.scopeSession")}
            </p>
            <p>{t("dlp.scopeSessionSub")}</p>
            <p className="mb-1 mt-2.5 flex items-center gap-1.5 font-semibold text-ink">
              <User className="h-3.5 w-3.5" /> {t("dlp.scopeUser")}
            </p>
            <p>{t("dlp.scopeUserSub")}</p>
          </div>
        </div>
      </Dialog>
    </>
  );
}
