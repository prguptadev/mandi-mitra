import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Check, AlertTriangle, Eye, Trash2, Zap, ExternalLink } from "lucide-react";
import { api, ApiError, type GeminiSettings } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, DEFAULT_DISPLAY, type DisplayConfig } from "@/lib/format.tsx";
import { SkeletonForm } from "@/components/Skeletons.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { GeminiUsageBar } from "@/components/GeminiUsage.tsx";
import { BackupModels, KeyModelsList, modelChoices, useKeyModels } from "@/components/GeminiModels.tsx";
import {
  Button, Card, CardHeader, Field, Input, Select, Switch, Alert, Badge,
} from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/* ------------------------------------------------- numbers & currency card */

export function NumberFormatCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { can } = useSession();
  const [draft, setDraft] = useState<DisplayConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["settings", "display"],
    queryFn: () => api.get<DisplayConfig>("/settings/display"),
  });
  useEffect(() => { if (q.data && !draft) setDraft(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.put<DisplayConfig>("/settings/display", draft),
    onSuccess: async () => {
      setSaved(true); setErr(null);
      await qc.invalidateQueries({ queryKey: ["settings", "display"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const cfg = draft ?? q.data ?? DEFAULT_DISPLAY;
  const set = <K extends keyof DisplayConfig>(k: K, v: DisplayConfig[K]) => {
    setDraft({ ...cfg, [k]: v });
    setSaved(false);
  };
  const dirty = draft !== null && q.data !== undefined && JSON.stringify(draft) !== JSON.stringify(q.data);
  const editable = can("settings.write");

  // preview is computed locally so it updates before saving
  const preview = (() => {
    const paise = 112785122;
    const fixed = Math.abs(paise / 100).toFixed(cfg.moneyDecimals);
    const [int, frac] = fixed.split(".");
    const g =
      cfg.numberFormat === "indian"
        ? int.length <= 3 ? int : int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + int.slice(-3)
        : cfg.numberFormat === "international" ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
        : int;
    const body = frac ? `${g}.${frac}` : g;
    const sym = cfg.showCurrencySymbol ? cfg.currencySymbol + (cfg.symbolSpacing ? " " : "") : "";
    return sym + body;
  })();

  if (q.isLoading) return <Card><div className="p-4"><SkeletonForm fields={6} /></div></Card>;

  return (
    <Card>
      <CardHeader title={t("settings.numbers")} sub={t("settings.numbersSub")} />
      <div className="space-y-4 p-4">
        {err && <Alert tone="bad">{err}</Alert>}
        {saved && !dirty && <Alert tone="ok">{t("common.saved")}</Alert>}

        <div className="rounded-lg border border-line bg-raised/40 px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-faint">{t("settings.preview")}</p>
          <p className="num mt-0.5 text-2xl font-semibold tracking-tight text-ink">{preview}</p>
          <p className="text-[11px] text-faint">
            {cfg.showWordAmount ? "11.28 lakh · " : ""}
            {(310.74).toFixed(cfg.weightDecimals)} {cfg.weightUnitLabel} @ {(3413.45).toFixed(cfg.rateDecimals)}
          </p>
        </div>

        <Field label={t("settings.numberFormat")}>
          <Select value={cfg.numberFormat} disabled={!editable}
            onChange={(e) => set("numberFormat", e.target.value as DisplayConfig["numberFormat"])}>
            <option value="indian">{t("settings.format.indian")}</option>
            <option value="international">{t("settings.format.international")}</option>
            <option value="plain">{t("settings.format.plain")}</option>
          </Select>
        </Field>

        <div className="space-y-3 rounded-lg border border-line p-3">
          <Switch checked={cfg.showCurrencySymbol} disabled={!editable}
            onChange={(v) => set("showCurrencySymbol", v)}
            label={t("settings.showSymbol")} hint={t("settings.showSymbolSub")} />
          {cfg.showCurrencySymbol && (
            <div className="grid gap-3 pl-[2.9rem] sm:grid-cols-2">
              <Field label={t("settings.currencySymbol")}>
                <Input value={cfg.currencySymbol} maxLength={4} disabled={!editable} className="h-8 text-[13px]"
                  onChange={(e) => set("currencySymbol", e.target.value)} />
              </Field>
              <div className="flex items-end pb-1.5">
                <Switch checked={cfg.symbolSpacing} disabled={!editable}
                  onChange={(v) => set("symbolSpacing", v)} label={t("settings.symbolSpacing")} />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("settings.moneyDecimals")}>
            <Select value={String(cfg.moneyDecimals)} disabled={!editable}
              onChange={(e) => set("moneyDecimals", Number(e.target.value) as 0 | 2)}>
              <option value="2">{t("settings.decimals2")}</option>
              <option value="0">{t("settings.decimals0")}</option>
            </Select>
          </Field>
          <Field label={t("settings.weightDecimals")}>
            <Select value={String(cfg.weightDecimals)} disabled={!editable}
              onChange={(e) => set("weightDecimals", Number(e.target.value) as 2 | 3)}>
              <option value="2">{t("settings.decimals2")}</option>
              <option value="3">{t("settings.decimals3")}</option>
            </Select>
          </Field>
          <Field label={t("settings.rateDecimals")}>
            <Select value={String(cfg.rateDecimals)} disabled={!editable}
              onChange={(e) => set("rateDecimals", Number(e.target.value) as 0 | 2)}>
              <option value="2">{t("settings.decimals2")}</option>
              <option value="0">{t("settings.decimals0")}</option>
            </Select>
          </Field>
        </div>

        <Field label={t("settings.negativeStyle")}>
          <Select value={cfg.negativeStyle} disabled={!editable}
            onChange={(e) => set("negativeStyle", e.target.value as DisplayConfig["negativeStyle"])}>
            <option value="minus">{t("settings.negative.minus")}</option>
            <option value="brackets">{t("settings.negative.brackets")}</option>
          </Select>
        </Field>

        <Switch checked={cfg.showWordAmount} disabled={!editable}
          onChange={(v) => set("showWordAmount", v)} label={t("settings.showWordAmount")} />

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label={t("settings.weightUnitLabel")}>
            <Input value={cfg.weightUnitLabel} maxLength={8} disabled={!editable}
              onChange={(e) => set("weightUnitLabel", e.target.value)} />
          </Field>
          <Field label={t("settings.defaultKatauti")} hint={t("settings.defaultKatautiSub")}>
            <div className="flex gap-2">
              <Select value={cfg.katautiMode} disabled={!editable} className="flex-1"
                onChange={(e) => set("katautiMode", e.target.value as DisplayConfig["katautiMode"])}>
                <option value="per_quintal_rounded">{t("merchant.katautiMode.per_quintal_rounded")}</option>
                <option value="per_quintal_exact">{t("merchant.katautiMode.per_quintal_exact")}</option>
                <option value="none">{t("merchant.katautiMode.none")}</option>
              </Select>
              <NumberInput value={cfg.katautiKgPerUnit} emptyValue={0} disabled={!editable}
                onValueChange={(n) => set("katautiKgPerUnit", n ?? 0)}
                className="h-9.5 w-20 rounded-lg border bg-surface px-3 text-sm text-ink focus:border-brand" />
            </div>
          </Field>
        </div>

        {editable && (
          <Button variant="primary" loading={save.isPending} disabled={!dirty}
            onClick={() => { setErr(null); save.mutate(); }}>{t("common.save")}</Button>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------- gemini card */

export function GeminiCard() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { can } = useSession();
  const [apiKey, setApiKey] = useState("");
  const [entering, setEntering] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; ms: number; error?: string; reply?: string } | null>(null);

  // the server shows this card to those who set it or scan with it
  const allowed = can("settings.write") || can("scan.create");
  const q = useQuery({
    queryKey: ["settings", "gemini"],
    queryFn: () => api.get<GeminiSettings>("/settings/gemini"),
    enabled: allowed,
  });

  const [keyWarning, setKeyWarning] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<{ keyWarning: string | null }>("/settings/gemini", body),
    onSuccess: async (r) => {
      setApiKey(""); setEntering(false); setErr(null); setTest(null);
      setKeyWarning(r?.keyWarning ?? null);
      await qc.invalidateQueries({ queryKey: ["settings", "gemini"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const sources = useQuery({
    queryKey: ["settings", "gemini", "sources"],
    queryFn: () => api.get<{ businessId: string; name: string; shortCode: string; maskedKey: string }[]>("/settings/gemini/sources"),
    enabled: can("settings.write"),
  });

  const copyKey = useMutation({
    mutationFn: (businessId: string) => api.post("/settings/gemini/copy-from", { businessId }),
    onSuccess: async () => { setErr(null); await qc.invalidateQueries({ queryKey: ["settings", "gemini"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const runTest = useMutation({
    mutationFn: () => api.post<{ ok: boolean; ms: number; error?: string; reply?: string }>("/settings/gemini/test", {}),
    onSuccess: (r) => setTest(r),
    onError: (e) => setTest({ ok: false, ms: 0, error: e instanceof ApiError ? e.message : "failed" }),
  });

  const keyModels = useKeyModels(allowed && Boolean(q.data?.configured));

  if (!allowed) return null;
  if (q.isLoading) return <Card><div className="p-4"><SkeletonForm fields={4} /></div></Card>;
  if (q.isError || !q.data) {
    return <Card><CardHeader title={t("settings.gemini")} /><div className="p-4"><Alert tone="bad">{q.error instanceof ApiError ? q.error.message : t("common.somethingWrong")}</Alert></div></Card>;
  }
  const g = q.data;
  const editable = can("settings.write");
  const choices = modelChoices(g, keyModels.data, lang);
  // a model Google does not list for this key would only fail; keep it only if it is the saved one
  const options = (current: string) => choices.filter((m) => m.onKey !== false || m.id === current);

  return (
    <Card>
      <CardHeader
        title={t("settings.gemini")} sub={t("settings.geminiSub")}
        action={
          g.configured
            ? <Badge tone="ok"><Check className="h-2.5 w-2.5" /> {t("settings.apiKeySet")}</Badge>
            : <Badge tone="warn">{t("settings.apiKeyNone")}</Badge>
        }
      />
      <div className="space-y-4 p-4">
        {err && <Alert tone="bad">{err}</Alert>}
        {g.keyUnreadable && <Alert tone="bad">{t("settings.apiKeyUnreadable")}</Alert>}
        {keyWarning && (
          <Alert tone="warn">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{keyWarning}</span>
            </span>
          </Alert>
        )}

        {g.configured && !entering ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2.5">
            <KeyRound className="h-4 w-4 shrink-0 text-brand" />
            <span className="num flex-1 text-[13px] text-ink">{g.maskedKey}</span>
            {editable && (
              <>
                <Button size="sm" onClick={() => setEntering(true)}>{t("settings.replaceKey")}</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad" />}
                  loading={save.isPending}
                  onClick={() => { if (confirm(t("settings.removeKey") + "?")) save.mutate({ clearKey: true }); }} />
              </>
            )}
          </div>
        ) : (
          editable && (
            <Field label={t("settings.apiKey")} hint={t("settings.apiKeyHelp")}>
              <div className="flex gap-2">
                <Input value={apiKey} type="password" autoComplete="off" className="num"
                  placeholder="AIza..." onChange={(e) => setApiKey(e.target.value)} />
                <Button variant="primary" loading={save.isPending} disabled={apiKey.trim().length < 20}
                  onClick={() => { setErr(null); save.mutate({ apiKey: apiKey.trim() }); }}>
                  {t("common.save")}
                </Button>
                {g.configured && <Button onClick={() => { setEntering(false); setApiKey(""); }}>{t("common.cancel")}</Button>}
              </div>
            </Field>
          )
        )}

        {/* one owner, two firms — no need to paste the same key twice */}
        {(sources.data?.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {sources.data!.map((b) => (
              <Button key={b.businessId} size="sm" variant="secondary" loading={copyKey.isPending}
                onClick={() => copyKey.mutate(b.businessId)}>
                {t("settings.copyKeyFrom", { name: b.shortCode })}
                <span className="num ml-1 text-[11px] text-faint">{b.maskedKey}</span>
              </Button>
            ))}
          </div>
        )}

        <GeminiUsageBar />

        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline">
          aistudio.google.com <ExternalLink className="h-3 w-3" />
        </a>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label={t("settings.model")}>
            <Select value={g.model} disabled={!editable}
              onChange={(e) => save.mutate({ model: e.target.value, backupModels: (g.backupModels ?? []).filter((x) => x !== e.target.value) })}>
              {options(g.model).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
            <p className="mt-1 text-[11px] leading-snug text-faint">{choices.find((m) => m.id === g.model)?.note}</p>
          </Field>
          <Field label={t("settings.fallbackModel")} hint={t("settings.fallbackModelSub")}>
            <Select value={g.fallbackModel} disabled={!editable}
              onChange={(e) => save.mutate({ fallbackModel: e.target.value })}>
              {options(g.fallbackModel).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <BackupModels g={g} k={keyModels.data} editable={editable} />
          </div>
          {g.configured && (
            <div className="sm:col-span-2">
              <KeyModelsList g={g} k={keyModels.data} loading={keyModels.isFetching}
                onCheck={() => void keyModels.refetch()} />
            </div>
          )}
        </div>

        {g.configured && (
          <div className="space-y-2.5 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" loading={runTest.isPending} icon={<Zap className="h-3.5 w-3.5" />}
                onClick={() => runTest.mutate()}>{t("settings.testKey")}</Button>
              {test?.ok && (
                <Badge tone="ok"><Check className="h-2.5 w-2.5" /> {t("settings.testOk", { ms: test.ms })}</Badge>
              )}
            </div>
            {test && !test.ok && (
              <Alert tone="bad">
                <span className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{test.error}</span>
                </span>
              </Alert>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
