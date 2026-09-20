import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ZoomIn, ZoomOut, Maximize2, Check, X, AlertTriangle, AlertCircle, Sparkles,
  ArrowRight, Trash2, RotateCcw, ScanLine, ChevronLeft, ChevronRight, Equal,
} from "lucide-react";
import { api, ApiError, type ScanBatch, type ScanRow, type ScanIssue, type Adati, type Jins, type Merchant } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, parseLooseNumber, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import {
  Button, Card, CardHeader, Select, Input, Badge, Alert, Dialog, Field, Spinner, EmptyState, Tabs,
} from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

const CELL = "h-7 w-full rounded border border-line bg-surface px-1.5 text-[12px] num text-right focus:border-brand disabled:opacity-60";

function Stat({ label, value, tone, title }: { label: string; value: string | number; tone?: "ok" | "warn" | "bad"; title?: string }) {
  return (
    <div title={title} className="rounded-lg border border-line bg-surface px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-faint">{label}</p>
      <p className={cn("num text-lg font-semibold leading-tight",
        tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "bad" && "text-bad")}>
        {value}
      </p>
    </div>
  );
}

/** The scanned page, with zoom, so the operator can read faint digits. */
function PageViewer({ scanId, pages }: { scanId: string; pages: ScanBatch["pages"] }) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = pages[page];

  if (!current) return null;
  const isPdf = current.mimeType === "application/pdf";

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {pages.length > 1 && (
          <>
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="num text-[12px] text-muted">{t("scan.page", { n: page + 1 })} / {pages.length}</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page === pages.length - 1}
              onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </>
        )}
        <div className="flex-1" />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} title={t("scan.zoomOut")}>
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="num w-10 text-center text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoom((z) => Math.min(5, z + 0.25))} title={t("scan.zoomIn")}>
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoom(1)} title={t("scan.fit")}>
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div ref={boxRef} className="flex-1 overflow-auto bg-raised/40 p-2">
        {isPdf ? (
          <iframe title={current.name} src={`/api/scans/${scanId}/page/${page}`} className="h-full min-h-[600px] w-full rounded border border-line bg-white" />
        ) : (
          <img
            src={`/api/scans/${scanId}/page/${page}`}
            alt={current.name}
            style={{ width: `${zoom * 100}%` }}
            className="mx-auto rounded border border-line bg-white"
          />
        )}
      </div>
    </Card>
  );
}

function IssueChip({ issue }: { issue: ScanIssue }) {
  const { t } = useI18n();
  // localise from the code; the server's English is only a fallback
  const key = `issue.${issue.code}` as never;
  const localised = t(key, issue.params as Record<string, string | number> | undefined);
  const text = localised === key ? issue.message : localised;
  return (
    <span className={cn(
      "inline-flex items-start gap-1 rounded px-1.5 py-0.5 text-[11px] leading-snug",
      issue.level === "error" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn",
    )}>
      {issue.level === "error" ? <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
      {text}
    </span>
  );
}

export function ScanReviewPage({ scanId }: { scanId: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const [, navigate] = useLocation();

  const [draft, setDraft] = useState<ScanRow[] | null>(null);
  const [filter, setFilter] = useState<"all" | "issues" | "blocking" | "clean">("all");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; learned: number; date: string } | null>(null);

  const batch = useQuery({
    queryKey: ["scan", scanId],
    queryFn: () => api.get<ScanBatch>(`/scans/${scanId}`),
  });
  const suppliers = useQuery({ queryKey: ["adati", {}], queryFn: () => api.get<Adati[]>("/adati") });
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jinsList = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });

  const rows = draft ?? batch.data?.rows ?? [];
  const summary = batch.data?.summary ?? null;

  const save = useMutation({
    mutationFn: (payload: { rows: ScanRow[]; slipDate?: string | null; merchantId?: string | null; jinsId?: string | null }) =>
      api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"] }>(`/scans/${scanId}/rows`, payload),
    onSuccess: async () => { setDraft(null); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const run = useMutation({
    mutationFn: (model?: string) => api.post(`/scans/${scanId}/run`, model ? { model } : {}),
    onSuccess: async () => { setDraft(null); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const commit = useMutation({
    mutationFn: () => api.post<{ created: number; learnedAliases: number; slipDate: string }>(`/scans/${scanId}/commit`),
    onSuccess: async (r) => {
      setDone({ created: r.created, learned: r.learnedAliases, date: r.slipDate });
      await qc.invalidateQueries();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/scans/${scanId}`),
    onSuccess: () => navigate("/scan"),
  });

  /** Local edit, then a debounced round-trip so every check is recomputed server-side. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchRow = (id: string, patch: Partial<ScanRow>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate({ rows: next }), 500);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const visible = useMemo(() => {
    if (filter === "issues") return rows.filter((r) => !r.excluded && r.issues.length > 0);
    if (filter === "blocking") return rows.filter((r) => !r.excluded && r.blocking);
    if (filter === "clean") return rows.filter((r) => !r.excluded && r.issues.length === 0);
    return rows;
  }, [rows, filter]);

  if (batch.isLoading) {
    return (<><PageHeader title={t("scan.review")} /><Card><SkeletonTable rows={8} /></Card></>);
  }
  const b = batch.data!;

  if (done) {
    return (
      <Card className="mx-auto max-w-lg">
        <EmptyState
          icon={<Check className="h-8 w-8 text-ok" />}
          title={t("scan.committed", { n: done.created, date: done.date })}
          sub={done.learned > 0 ? t("scan.learned", { n: done.learned }) : undefined}
          action={
            <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />}
              onClick={() => navigate(`/daily`)}>{t("scan.openDaily")}</Button>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={t("scan.review")} sub={t("scan.reviewSub")}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad" />}
              onClick={() => { if (confirm(t("scan.confirmDelete"))) remove.mutate(); }} />
            {b.status !== "committed" && (
              <Button size="sm" variant="secondary" loading={run.isPending}
                icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => run.mutate(undefined)}>
                {t("scan.tryAgain")}
              </Button>
            )}
          </div>
        }
      />

      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {b.status === "committed" && <Alert tone="ok" className="mb-3">{t("scan.status.committed")}</Alert>}
      {b.errorText && (
        <Alert tone="bad" className="mb-3">
          <p className="font-semibold">{t("scan.failedTitle")}</p>
          <p>{b.errorText}</p>
        </Alert>
      )}

      {/* sheet header — what the reader saw, and what will be written */}
      <Card className="mb-3">
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Field label={t("daily.date")} className="w-[160px]">
            <Input type="date" value={b.slipDate ?? ""} className="h-8 num text-[13px]"
              onChange={(e) => save.mutate({ rows, slipDate: e.target.value || null })} />
          </Field>
          <Field label={t("daily.mill")} className="min-w-[180px]">
            <Select value={b.merchantId ?? ""} className="h-8 text-[13px]"
              onChange={(e) => save.mutate({ rows, merchantId: e.target.value || null })}>
              <option value="">{t("daily.noMill")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
            </Select>
          </Field>
          <Field label={t("daily.jins")} className="min-w-[160px]">
            <Select value={b.jinsId ?? ""} className="h-8 text-[13px]"
              onChange={(e) => save.mutate({ rows, jinsId: e.target.value || null })}>
              <option value="">—</option>
              {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
            </Select>
          </Field>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-faint">
            {b.model && <Badge tone="neutral">{b.model}</Badge>}
            {b.tokensIn != null && <span className="num">{t("scan.costNote", { in: b.tokensIn, out: b.tokensOut ?? 0 })}</span>}
          </div>
        </div>
      </Card>

      {summary && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label={t("scan.summary.total")} value={summary.total} />
          <Stat label={t("scan.summary.clean")} value={summary.clean} tone="ok" />
          <Stat label={t("scan.summary.warnings")} value={summary.warnings} tone={summary.warnings ? "warn" : undefined} />
          <Stat label={t("scan.summary.blocking")} value={summary.blocking} tone={summary.blocking ? "bad" : "ok"} />
          <Stat label={t("scan.summary.netAgree")} title={t("scan.netAgreeHelp")}
            value={`${summary.netAgreeing}/${summary.netChecked}`}
            tone={summary.netChecked > 0 && summary.netAgreeing === summary.netChecked ? "ok" : "warn"} />
          <Stat label={t("scan.summary.names")} value={`${summary.autoMatchedNames}/${summary.included}`}
            tone={summary.autoMatchedNames === summary.included ? "ok" : "warn"} />
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.35fr)]">
        <div className="lg:sticky lg:top-4 lg:h-[calc(100vh-8rem)]">
          <PageViewer scanId={scanId} pages={b.pages} />
        </div>

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
            <Tabs value={filter} onChange={setFilter} className="border-0"
              tabs={[
                { value: "all", label: t("scan.rowsAll"), count: rows.length },
                { value: "blocking", label: t("scan.rowsBlocking"), count: summary?.blocking ?? 0 },
                { value: "issues", label: t("scan.rowsIssues"), count: summary?.warnings ?? 0 },
                { value: "clean", label: t("scan.rowsClean"), count: summary?.clean ?? 0 },
              ]} />
            <div className="flex-1" />
            {save.isPending && <Spinner />}
          </div>

          <div className="divide-y divide-line/70">
            {visible.map((r) => {
              const matched = r.adatiId
                ? suppliers.data?.find((s) => s.id === r.adatiId) ?? null
                : null;
              return (
                <div key={r.id} className={cn(
                  "p-2.5 transition-colors",
                  r.excluded && "bg-raised/40 opacity-55",
                  !r.excluded && r.blocking && "bg-bad-soft/40",
                  !r.excluded && !r.blocking && r.issues.length > 0 && "bg-warn-soft/30",
                )}>
                  <div className="flex items-start gap-2">
                    <div className="flex w-full min-w-0 flex-col gap-2">
                      {/* line 1: rst + name */}
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={r.rstNo} disabled={r.excluded || b.status === "committed"}
                          onChange={(e) => patchRow(r.id, { rstNo: e.target.value })}
                          className={cn(CELL, "w-16 text-left")} placeholder="RST"
                        />
                        <div className="min-w-[200px] flex-1">
                          {r.adatiId || r.match ? (
                            <div className="flex items-center gap-1.5">
                              <span lang="hi" className="truncate text-[14px] font-medium text-ink">
                                {matched?.nameHi ?? r.match?.nameHi}
                              </span>
                              <span className="truncate text-[11px] text-faint">
                                {matched?.nameHinglish ?? r.match?.nameHinglish}
                              </span>
                              {r.match && (
                                <Badge tone={r.match.via === "fuzzy" ? "warn" : "ok"} className="shrink-0">
                                  {t(`scan.matchedBy.${r.match.via}` as never)}
                                </Badge>
                              )}
                              {!r.excluded && b.status !== "committed" && (
                                <Button size="icon" variant="ghost" className="h-6 w-6"
                                  onClick={() => patchRow(r.id, { adatiId: null, nameCorrected: true })}>
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          ) : (
                            <SupplierPicker
                              suppliers={suppliers.data ?? []}
                              value={r.adatiId}
                              disabled={r.excluded || b.status === "committed"}
                              placeholder={r.adatiRawText || t("scan.pickName")}
                              onChange={(v) => patchRow(r.id, { adatiId: v, nameCorrected: true })}
                            />
                          )}
                        </div>
                        {r.ocr.adatiName && (
                          <span lang="hi" className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted"
                            title={t("scan.ocrSaid")}>
                            {t("scan.ocrSaid")}: {r.ocr.adatiName}
                          </span>
                        )}
                        {r.ocr.confidence != null && (
                          <Badge tone={r.ocr.confidence >= 0.8 ? "ok" : r.ocr.confidence >= 0.6 ? "warn" : "bad"} className="num shrink-0">
                            {Math.round(r.ocr.confidence * 100)}%
                          </Badge>
                        )}
                        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0"
                          title={r.excluded ? t("scan.include") : t("scan.exclude")}
                          disabled={b.status === "committed"}
                          onClick={() => patchRow(r.id, { excluded: !r.excluded })}>
                          {r.excluded ? <RotateCcw className="h-3 w-3" /> : <Trash2 className="h-3 w-3 text-bad/70" />}
                        </Button>
                      </div>

                      {/* line 2: the numbers */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
                        <label className="flex items-center gap-1">
                          <span className="text-faint">{t("daily.gross")}</span>
                          <input
                            className={cn(CELL, "w-20")} inputMode="decimal"
                            disabled={r.excluded || b.status === "committed"}
                            value={r.grossGrams === null ? "" : (r.grossGrams / GRAMS_PER_QTL).toFixed(2)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { grossGrams: n === null ? null : Math.round(n * GRAMS_PER_QTL) });
                            }}
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <span className="text-faint">{t("daily.bags")}</span>
                          <input
                            className={cn(CELL, "w-14", r.katautiOverride === null && "text-faint")} inputMode="numeric"
                            disabled={r.excluded || b.status === "committed"}
                            placeholder={r.derivedKatautiUnits === null ? "" : String(r.derivedKatautiUnits)}
                            value={r.katautiOverride === null ? "" : String(r.katautiOverride)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { katautiOverride: n === null ? null : Math.round(n) });
                            }}
                          />
                        </label>
                        <span className="flex items-center gap-1">
                          <span className="text-faint">{t("daily.net")}</span>
                          <span className="num font-semibold text-ink">
                            {r.derivedNetGrams === null ? "—" : f.weight(r.derivedNetGrams)}
                          </span>
                          {r.netAgrees === true && (
                            <span title={t("scan.netAgreeHelp")}>
                              <Equal className="h-3 w-3 text-ok" />
                            </span>
                          )}
                          {r.ocr.netQtl != null && r.netAgrees === false && (
                            <span className="num text-[11px] text-warn" title={t("scan.sheetSaid")}>
                              ({t("scan.sheetSaid")} {r.ocr.netQtl.toFixed(2)})
                            </span>
                          )}
                        </span>
                        <label className="flex items-center gap-1">
                          <span className="text-faint">{t("daily.rate")}</span>
                          <input
                            className={cn(CELL, "w-20")} inputMode="decimal"
                            disabled={r.excluded || b.status === "committed" || !can("rate.edit")}
                            value={r.ratePaisePerQtl === null ? "" : (r.ratePaisePerQtl / 100).toFixed(2)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { ratePaisePerQtl: n === null ? null : Math.round(n * 100) });
                            }}
                          />
                        </label>
                        <span className="flex items-center gap-1">
                          <span className="text-faint">{t("daily.amount")}</span>
                          <span className="num font-semibold text-brand">
                            {r.derivedAmountPaise === null ? "—" : f.money(r.derivedAmountPaise)}
                          </span>
                        </span>
                      </div>

                      {/* suggestions for an unresolved name */}
                      {!r.excluded && !r.adatiId && !r.match && r.suggestions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Sparkles className="h-3 w-3 text-faint" />
                          {r.suggestions.map((s) => (
                            <button key={s.adatiId} type="button"
                              onClick={() => patchRow(r.id, { adatiId: s.adatiId, nameCorrected: true })}
                              className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] hover:border-brand hover:bg-brand/5">
                              <span lang="hi">{s.nameHi}</span>
                              <span className="num text-faint">{Math.round(s.confidence * 100)}%</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {!r.excluded && r.issues.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {r.issues.map((iss, k) => <IssueChip key={k} issue={iss} />)}
                        </div>
                      )}
                      {r.excluded && r.ocr.struckThrough && (
                        <p className="text-[11px] text-faint">{t("scan.struck")}</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {visible.length === 0 && (
              <EmptyState icon={<ScanLine className="h-7 w-7" />} title={t("common.noResults")} />
            )}
          </div>

          {summary && b.status !== "committed" && (
            <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 p-3 backdrop-blur">
              <div className="text-[12px] text-muted">
                <span className="num font-semibold text-ink">{summary.included}</span> {t("daily.rowCount", { n: "" }).trim()}
                {" · "}
                <span className="num font-semibold text-ink">{f.weight(summary.totalNetGrams, { unit: true })}</span>
                {" · "}
                <span className="num font-semibold text-brand">{f.money(summary.totalAmountPaise)}</span>
              </div>
              <div className="flex-1" />
              <Button
                variant="primary" size="lg"
                loading={commit.isPending}
                disabled={summary.blocking > 0 || !b.slipDate || !b.jinsId || summary.included === 0}
                icon={<Check className="h-4 w-4" />}
                onClick={() => { setErr(null); commit.mutate(); }}
              >
                {summary.blocking > 0
                  ? t("scan.commitBlocked", { n: summary.blocking })
                  : !b.slipDate ? t("scan.needDate")
                  : !b.jinsId ? t("scan.needJins")
                  : t("scan.commit")}
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
