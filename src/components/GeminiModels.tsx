import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ExternalLink, FlaskConical, X } from "lucide-react";
import {
  api, ApiError, type GeminiSettings, type GeminiKeyModels, type ModelToday, type TryModelResult,
} from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Checkbox, Dialog, Field, Select, Spinner, Table, Td, Th, Tr } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/* Which Gemini models this key can use, how much of each is gone today, the
   backup order, and a side-by-side trial on a real page. Free allowances are
   per model, so the backup list is what lets a busy day keep reading. */

export function useGeminiSettings() {
  return useQuery({ queryKey: ["settings", "gemini"], queryFn: () => api.get<GeminiSettings>("/settings/gemini") });
}

export function useKeyModels(enabled = true) {
  return useQuery({
    queryKey: ["settings", "gemini", "models"],
    queryFn: () => api.get<GeminiKeyModels>("/settings/gemini/models"),
    enabled, staleTime: 60_000,
  });
}

/** Catalogue first (with our notes), then whatever else the key lists. */
export function modelChoices(g: GeminiSettings | undefined, k: GeminiKeyModels | undefined, lang: "en" | "hi" = "en") {
  const out: { id: string; label: string; note?: string; onKey: boolean | null }[] = [];
  const onKey = k?.ok ? new Set(k.models.map((m) => m.id)) : null;
  const seen = new Set<string>();
  for (const m of g?.models ?? []) {
    seen.add(m.id);
    out.push({ id: m.id, label: m.label, note: lang === "hi" && m.noteHi ? m.noteHi : m.note, onKey: onKey ? onKey.has(m.id) : null });
  }
  for (const m of k?.models ?? []) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: m.displayName || m.id, onKey: true });
  }
  // a saved model that is in neither list still has to show as selected
  for (const id of [g?.model, g?.fallbackModel, ...(g?.backupModels ?? [])]) {
    if (id && !seen.has(id)) { seen.add(id); out.push({ id, label: id, onKey: onKey ? onKey.has(id) : null }); }
  }
  return out;
}

export function TodayBadge({ u }: { u?: ModelToday }) {
  const { t } = useI18n();
  if (!u) return null;
  if (u.dailyLimit === 0) return <Badge tone="bad">{t("gm.notFree")}</Badge>;
  if (u.exhausted) return <Badge tone="bad">{t("gm.usedUp")}</Badge>;
  if (u.dailyLimit != null) {
    const left = u.dailyLimit - u.used;
    return <Badge tone={left <= 0 ? "bad" : left <= 3 ? "warn" : "ok"}>{t("gm.todayOf", { used: u.used, limit: u.dailyLimit })}</Badge>;
  }
  return u.used ? <Badge>{t("gm.todayUsed", { used: u.used })}</Badge> : null;
}

/* ------------------------------------------------------------ settings */

export function BackupModels({ g, k, editable }: { g: GeminiSettings; k?: GeminiKeyModels; editable: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (backupModels: string[]) => api.put("/settings/gemini", { backupModels }),
    onSuccess: async () => {
      setErr(null);
      await qc.invalidateQueries({ queryKey: ["settings", "gemini"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const { lang } = useI18n();
  const choices = modelChoices(g, k, lang);
  const label = (id: string) => choices.find((c) => c.id === id)?.label ?? id;
  const list = g.backupModels ?? [];
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    save.mutate(next);
  };

  return (
    <Field label={t("gm.backups")} hint={t("gm.backupsSub")}>
      {err && <Alert tone="bad" className="mb-2">{err}</Alert>}
      <div className="space-y-1.5">
        {list.length === 0 && <p className="text-[12px] text-faint">{t("gm.noBackups")}</p>}
        {list.map((id, i) => (
          <div key={id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-1.5">
            <span className="num w-5 text-center text-[12px] text-faint">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={id}>{label(id)}</span>
            <TodayBadge u={k?.usage?.[id]} />
            {editable && (
              <span className="flex items-center gap-0.5">
                <Button size="icon" variant="ghost" disabled={i === 0 || save.isPending} aria-label="Up" onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" disabled={i === list.length - 1 || save.isPending} aria-label="Down" onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" disabled={save.isPending} aria-label={t("common.delete")}
                  onClick={() => save.mutate(list.filter((x) => x !== id))}>
                  <X className="h-3.5 w-3.5 text-bad" />
                </Button>
              </span>
            )}
          </div>
        ))}
        {editable && list.length < 6 && (
          <Select value="" disabled={save.isPending}
            onChange={(e) => { if (e.target.value) save.mutate([...list, e.target.value]); }}>
            <option value="">{t("gm.addBackup")}</option>
            {choices.filter((c) => c.id !== g.model && !list.includes(c.id)).map((c) => (
              <option key={c.id} value={c.id}>{c.label}{c.onKey === false ? ` — ${t("gm.notOnKey")}` : ""}</option>
            ))}
          </Select>
        )}
      </div>
    </Field>
  );
}

export function KeyModelsList({ g, k, loading, onCheck }: {
  g: GeminiSettings; k?: GeminiKeyModels; loading: boolean; onCheck: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const choices = modelChoices(g, k, useI18n().lang);
  const role = (id: string) => id === g.model ? t("gm.main")
    : g.backupModels?.includes(id) ? t("gm.backup", { n: g.backupModels.indexOf(id) + 1 })
    : id === g.fallbackModel ? t("gm.fallback") : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" loading={loading}
          icon={open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          onClick={() => { setOpen(!open); if (!open) onCheck(); }}>
          {t("gm.onKey")}
        </Button>
        <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline">
          {t("gm.limitRef")} <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {open && (
        <>
          <p className="text-[12px] leading-snug text-muted">{t("gm.onKeySub")}</p>
          {k && !k.ok && k.error && <Alert tone="bad">{k.error}</Alert>}
          {loading && !k ? <Spinner /> : (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-line">
              <Table>
                <thead><tr><Th>{t("gm.colModel")}</Th><Th>{t("gm.colToday")}</Th></tr></thead>
                <tbody>
                  {choices.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13px] text-ink">{c.label}</span>
                          {role(c.id) && <Badge tone="brand">{role(c.id)}</Badge>}
                          {c.onKey === false && <Badge tone="warn">{t("gm.notOnKey")}</Badge>}
                        </div>
                        <div className="num text-[11px] text-faint">{c.id}{c.note ? ` · ${c.note}` : ""}</div>
                      </Td>
                      <Td><TodayBadge u={k?.usage?.[c.id]} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ trial */

type Trial = { state: "waiting" | "reading" | "done" | "error"; result?: TryModelResult; error?: string };

export function TryModelsButton({ scanId, pages }: { scanId: string; pages: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" icon={<FlaskConical className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
        {t("gm.try")}
      </Button>
      {open && <TryModelsDialog scanId={scanId} pages={pages} onClose={() => setOpen(false)} />}
    </>
  );
}

function TryModelsDialog({ scanId, pages, onClose }: { scanId: string; pages: number; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const gq = useGeminiSettings();
  const kq = useKeyModels();
  const g = gq.data;
  const choices = useMemo(() => modelChoices(g, kq.data), [g, kq.data]);
  const chain = useMemo(() => g ? [...new Set([g.model, ...(g.backupModels ?? []), g.fallbackModel])] : [], [g]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const ticked = picked ?? chain;
  const [page, setPage] = useState(1);
  const [trials, setTrials] = useState<Record<string, Trial>>({});
  const [running, setRunning] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const editable = can("settings.write");

  const setCfg = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put("/settings/gemini", body),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["settings", "gemini"] }); },
  });

  async function run() {
    setRunning(true);
    const order = [...ticked];
    setTrials(Object.fromEntries(order.map((m) => [m, { state: "waiting" }])));
    for (const m of order) {
      setTrials((p) => ({ ...p, [m]: { state: "reading" } }));
      try {
        const r = await api.post<TryModelResult>(`/scans/${scanId}/try-model`, { model: m, page });
        setTrials((p) => ({ ...p, [m]: { state: "done", result: r } }));
      } catch (e) {
        setTrials((p) => ({ ...p, [m]: { state: "error", error: e instanceof ApiError ? e.message : t("common.somethingWrong") } }));
      }
    }
    setRunning(false);
    await qc.invalidateQueries({ queryKey: ["settings", "gemini"] });
  }

  const label = (id: string) => choices.find((c) => c.id === id)?.label ?? id;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const ran = Object.keys(trials);

  return (
    <Dialog open onClose={running ? () => {} : onClose} wide title={t("gm.try")} sub={t("gm.trySub")}
      footer={<>
        <Button onClick={onClose} disabled={running}>{t("common.close")}</Button>
        <Button variant="primary" loading={running} disabled={!ticked.length} icon={<FlaskConical className="h-3.5 w-3.5" />}
          onClick={() => void run()}>{t("gm.run", { n: ticked.length })}</Button>
      </>}>
      {!g ? <Spinner /> : (
        <div className="space-y-4">
          {pages > 1 && (
            <Field label={t("gm.page")}>
              <Select value={String(page)} disabled={running} onChange={(e) => setPage(Number(e.target.value))}>
                {Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>{t("gm.pageN", { n: i + 1 })}</option>)}
              </Select>
            </Field>
          )}

          <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {choices.filter((c) => c.onKey !== false).map((c) => (
              <div key={c.id} className="flex min-w-0 items-center gap-2">
                <Checkbox checked={ticked.includes(c.id)} disabled={running}
                  onChange={(v) => setPicked(v ? [...ticked, c.id] : ticked.filter((x) => x !== c.id))}
                  label={<span className="truncate" title={c.id}>{c.label}</span>} />
                <TodayBadge u={kq.data?.usage?.[c.id]} />
              </div>
            ))}
          </div>

          {ran.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line">
              <Table>
                <thead>
                  <tr>
                    <Th>{t("gm.colModel")}</Th>
                    <Th numeric>{t("gm.colRows")}</Th>
                    <Th numeric title={t("gm.colNetHint")}>{t("gm.colNet")}</Th>
                    <Th numeric title={t("gm.colSameHint")}>{t("gm.colSame")}</Th>
                    <Th numeric>{t("gm.colConf")}</Th>
                    <Th numeric>{t("gm.colTime")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {ran.map((m) => {
                    const tr = trials[m];
                    const r = tr.result;
                    const good = r?.ok;
                    return (
                      <Fragment key={m}>
                        <Tr onClick={good ? () => setOpenRow(openRow === m ? null : m) : undefined}>
                          <Td>
                            <div className="flex items-center gap-1.5">
                              {good && (openRow === m ? <ChevronDown className="h-3.5 w-3.5 text-faint" /> : <ChevronRight className="h-3.5 w-3.5 text-faint" />)}
                              <span className="text-[13px] text-ink" title={m}>{label(m)}</span>
                            </div>
                            {tr.state === "waiting" && <span className="text-[11px] text-faint">{t("gm.waiting")}</span>}
                            {tr.state === "reading" && <span className="inline-flex items-center gap-1 text-[11px] text-muted"><Spinner className="h-3 w-3" />{t("gm.reading")}</span>}
                            {tr.state === "error" && <p className="text-[11px] text-bad">{tr.error}</p>}
                            {r && !r.ok && <p className="max-w-md break-words text-[11px] text-bad">{r.error}</p>}
                            {r?.truncated && <p className="text-[11px] text-warn">{t("gm.truncated")}</p>}
                          </Td>
                          <Td numeric>{good ? r!.rowsRead : ""}</Td>
                          <Td numeric>{good ? <span title={`${r!.netAgreeing}/${r!.netChecked}`}>{pct(r!.netAgreeing!, r!.netChecked!)}</span> : ""}</Td>
                          <Td numeric>
                            {good && r!.vsScan && r!.vsScan.rows > 0 ? (
                              <span title={t("gm.sameDetail", {
                                rst: r!.vsScan.rstFound, rows: r!.vsScan.rows, gross: r!.vsScan.grossSame,
                                rate: r!.vsScan.rateSame, name: r!.vsScan.nameSame, names: r!.vsScan.namesChecked,
                              })}>
                                <span className={cn("font-semibold", r!.vsScan.same === r!.vsScan.rows ? "text-ok" : r!.vsScan.same / r!.vsScan.rows >= 0.8 ? "text-warn" : "text-bad")}>
                                  {r!.vsScan.same}
                                </span>
                                <span className="text-faint"> / {r!.vsScan.rows}</span>
                              </span>
                            ) : good ? "—" : ""}
                          </Td>
                          <Td numeric>{good && r!.meanConfidence != null ? `${Math.round(r!.meanConfidence * 100)}%` : ""}</Td>
                          <Td numeric>{r ? `${(r.ms / 1000).toFixed(1)} s` : ""}</Td>
                          <Td align="right">
                            {good && editable && (
                              <span className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                                {g.model === m ? <Badge tone="brand">{t("gm.main")}</Badge> : (
                                  <Button size="sm" variant="ghost" loading={setCfg.isPending}
                                    onClick={() => setCfg.mutate({ model: m, backupModels: (g.backupModels ?? []).filter((x) => x !== m) })}>
                                    {t("gm.useMain")}
                                  </Button>
                                )}
                                {g.model !== m && ((g.backupModels ?? []).includes(m)
                                  ? <Badge>{t("gm.inBackups")}</Badge>
                                  : (
                                    <Button size="sm" variant="ghost" loading={setCfg.isPending} disabled={(g.backupModels ?? []).length >= 6}
                                      onClick={() => setCfg.mutate({ backupModels: [...(g.backupModels ?? []), m] })}>
                                      {t("gm.addAsBackup")}
                                    </Button>
                                  ))}
                              </span>
                            )}
                          </Td>
                        </Tr>
                        {openRow === m && good && (
                          <tr>
                            <td colSpan={7} className="bg-raised/40 px-3 py-2">
                              <RowsRead r={r!} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function RowsRead({ r }: { r: TryModelResult }) {
  const { t } = useI18n();
  return (
    <div className="max-h-72 overflow-y-auto">
      <table className="w-full text-[12px]">
        <thead className="text-faint">
          <tr>
            <th className="px-1.5 py-1 text-left font-medium">RST</th>
            <th className="px-1.5 py-1 text-left font-medium">{t("gm.name")}</th>
            <th className="px-1.5 py-1 text-right font-medium">{t("gm.gross")}</th>
            <th className="px-1.5 py-1 text-right font-medium">{t("gm.net")}</th>
            <th className="px-1.5 py-1 text-right font-medium">{t("gm.rate")}</th>
            <th className="px-1.5 py-1 text-right font-medium">{t("gm.colConf")}</th>
            <th className="px-1.5 py-1 text-left font-medium" />
          </tr>
        </thead>
        <tbody>
          {(r.rows ?? []).map((x, i) => (
            <tr key={i} className={cn("border-t border-line/60", x.struckThrough && "text-faint line-through")}>
              <td className="num px-1.5 py-1">{x.rstNo}</td>
              <td className="px-1.5 py-1">
                <span className="text-ink">{x.name}</span>
                {x.matchedName && x.matchedName !== x.name && <span className="text-faint"> → {x.matchedName}</span>}
              </td>
              <td className="num px-1.5 py-1 text-right">{x.grossQtl ?? ""}</td>
              <td className="num px-1.5 py-1 text-right">{x.netQtl ?? ""}</td>
              <td className="num px-1.5 py-1 text-right">{x.rate ?? ""}</td>
              <td className="num px-1.5 py-1 text-right">{x.confidence != null ? `${Math.round(x.confidence * 100)}%` : ""}</td>
              <td className="px-1.5 py-1">
                {!x.struckThrough && !x.onScan && <Badge tone="warn">{t("gm.notOnScan")}</Badge>}
                {x.diff.map((d) => <Badge key={d} tone="bad" className="ml-1">{t(`gm.diff.${d}` as "gm.diff.gross")}</Badge>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
