import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ZoomIn, ZoomOut, Maximize2, Check, X, AlertTriangle, AlertCircle, Sparkles,
  ArrowRight, Trash2, RotateCcw, ScanLine, ChevronLeft, ChevronRight,
  PanelRightClose, PanelRightOpen, UserPlus, FileText,
} from "lucide-react";
import { api, ApiError, apiStatus, type ScanBatch, type ScanRow, type ScanIssue, type Jins, type Merchant } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, parseLooseNumber, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { ScanGrid, type Field as GridField } from "@/components/ScanGrid.tsx";
import { SplitPane } from "@/components/SplitPane.tsx";
import { GeminiUsageBar } from "@/components/GeminiUsage.tsx";
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

/**
 * Every page of the sheet, one after another in a single scroll, so the grid
 * beside it can be read top to bottom against the paper. Zoom applies to all.
 */
function PageViewer({ scanId, pages, onPage }: {
  scanId: string;
  pages: ScanBatch["pages"];
  /** Scroll a given page into view; the grid's page headers call this. */
  onPage?: (fn: (page: number) => void) => void;
}) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    onPage?.((page) => refs.current[page - 1]?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [onPage]);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <span className="text-[12px] text-muted">{t("scan.pages", { n: pages.length })}</span>
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
      <div className="flex-1 space-y-3 overflow-auto bg-raised/40 p-2">
        {pages.map((p, i) => (
          <div key={`${p.name}-${i}`} ref={(el) => { refs.current[i] = el; }}>
            <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <FileText className="h-3 w-3" /> {t("scan.page", { n: i + 1 })}
            </p>
            {p.mimeType === "application/pdf" ? (
              <iframe title={p.name} src={`/api/scans/${scanId}/page/${i}`}
                className="h-[70vh] w-full rounded border border-line bg-white" />
            ) : (
              <img src={`/api/scans/${scanId}/page/${i}`} alt={t("scan.page", { n: i + 1 })}
                style={{ width: `${zoom * 100}%` }} loading="lazy"
                className="mx-auto rounded border border-line bg-white" />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Before reading: put the pages in the order they belong. */
function PageOrderer({ scanId, pages, onRead, reading }: {
  scanId: string; pages: ScanBatch["pages"]; onRead: () => void; reading: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [order, setOrder] = useState(() => pages.map((_, i) => i));
  const [err, setErr] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (o: number[]) => api.put(`/scans/${scanId}/order`, { order: o }),
    onSuccess: async () => { setOrder(pages.map((_, i) => i)); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    setOrder(next);
  };
  const changed = order.some((v, i) => v !== i);

  return (
    <Card>
      <CardHeader title={t("scan.orderTitle")} sub={t("scan.orderSub")} />
      {err && <Alert tone="bad" className="m-3">{err}</Alert>}
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {order.map((pageIndex, pos) => {
          const p = pages[pageIndex];
          return (
            <div key={pageIndex} className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-1.5 border-b border-line bg-raised/50 px-2.5 py-1.5">
                <span className="num grid h-7 min-w-7 place-items-center rounded-md bg-brand px-1.5 text-[14px] font-bold text-brand-ink">
                  {pos + 1}
                </span>
                <span className="text-[12px] font-medium text-ink">{t("scan.page", { n: pos + 1 })}</span>
                <span className="flex-1" />
                <Button size="sm" variant="secondary" className="h-7" disabled={pos === 0}
                  onClick={() => move(pos, pos - 1)} icon={<ChevronLeft className="h-3.5 w-3.5" />}>
                  {t("scan.moveUp")}
                </Button>
                <Button size="sm" variant="secondary" className="h-7" disabled={pos === order.length - 1}
                  onClick={() => move(pos, pos + 1)}>
                  {t("scan.moveDown")} <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              {p.mimeType === "application/pdf" ? (
                <div className="grid h-[55vh] place-items-center text-[12px] text-faint">PDF</div>
              ) : (
                <img src={`/api/scans/${scanId}/page/${pageIndex}`} alt="" loading="lazy"
                  className="h-[55vh] w-full bg-raised object-contain" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
        <p className="text-[12px] text-muted">{t("scan.orderHint")} · <span className="font-medium text-ink">{t("gemini.willUse", { n: pages.length })}</span></p>
        <div className="flex-1" />
        {changed && (
          <Button onClick={() => setOrder(pages.map((_, i) => i))}>{t("common.cancel")}</Button>
        )}
        <Button variant="primary" size="lg" loading={save.isPending || reading}
          icon={<ScanLine className="h-4 w-4" />}
          onClick={async () => {
            setErr(null);
            if (changed) await save.mutateAsync(order);
            onRead();
          }}>
          {t("scan.readInOrder")}
        </Button>
      </div>
    </Card>
  );
}

type Field = GridField;

export function ScanReviewPage({ scanId }: { scanId: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const [, navigate] = useLocation();

  const [draft, setDraft] = useState<ScanRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; learned: number; date: string } | null>(null);
  const [showScan, setShowScan] = useState(true);
  const scrollToPage = useRef<((page: number) => void) | null>(null);

  /* A scan belongs to one business. Rather than a dead end, find out which of
     the user's businesses holds it and offer to go there. */
  const whereis = useQuery({
    queryKey: ["scan", scanId, "whereis"],
    queryFn: () => api.get<{ found: boolean; businessId?: string; name?: string; shortCode?: string }>(`/scans/${scanId}/whereis`),
    enabled: false,
    retry: false,
  });
  const goThere = useMutation({
    mutationFn: (businessId: string) => api.post("/auth/switch-business", { businessId }),
    onSuccess: async () => { await qc.invalidateQueries(); },
  });

  const batch = useQuery({
    queryKey: ["scan", scanId],
    queryFn: () => api.get<ScanBatch>(`/scans/${scanId}`),
    /* The read runs on the server, detached from any request, and pages land
       one at a time. Polling shows each page as it arrives, and means leaving
       this screen loses nothing. */
    refetchInterval: (q) => (q?.state?.data?.status === "reading" ? 1500 : false),
    refetchOnWindowFocus: true,
    retry: (count, e) => apiStatus(e) !== 404 && count < 2,
  });
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jinsList = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });

  const rows = draft ?? batch.data?.rows ?? [];
  const summary = batch.data?.summary ?? null;

  const save = useMutation({
    mutationFn: (payload: { rows: ScanRow[]; slipDate?: string | null; merchantId?: string | null; jinsId?: string | null }) =>
      api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"] }>(`/scans/${scanId}/rows`, payload),
    onSuccess: (resp, vars) => {
      /* Write the server's answer straight into the cache. Clearing the draft
         and waiting for a refetch left a window where the old rows showed, and
         a click in that window was built on stale data. */
      qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? {
        ...old, rows: resp.rows, summary: resp.summary,
        ...(vars.slipDate !== undefined ? { slipDate: vars.slipDate ?? null } : {}),
        ...(vars.merchantId !== undefined ? { merchantId: vars.merchantId ?? null } : {}),
        ...(vars.jinsId !== undefined ? { jinsId: vars.jinsId ?? null } : {}),
      } : old);
      // only drop the draft if nothing newer was typed while this was saving
      if (latest.current === vars.rows) setDraft(null);
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const run = useMutation({
    mutationFn: (model?: string) => api.post(`/scans/${scanId}/run`, model ? { model } : {}),
    onSuccess: async () => { setDraft(null); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const commit = useMutation({
    mutationFn: () => api.post<{ created: number; learnedAliases: number; slipDate: string }>(`/scans/${scanId}/commit`),
    onSuccess: async (r) => { setDone({ created: r.created, learned: r.learnedAliases, date: r.slipDate }); await qc.invalidateQueries(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const createSuppliers = useMutation({
    mutationFn: () => api.post<{ created: number; linked: number }>(`/scans/${scanId}/create-suppliers`),
    onSuccess: async (r) => {
      setDraft(null); setErr(null);
      setNotice(t("scan.suppliersCreated", { created: r.created, linked: r.linked }));
      await qc.invalidateQueries({ queryKey: ["scan", scanId] });
      await qc.invalidateQueries({ queryKey: ["adati"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/scans/${scanId}`),
    onSuccess: () => navigate("/scan"),
  });

  /** Local edit now, a debounced round-trip so every check is recomputed on the server. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<ScanRow[] | null>(null);
  const patchRow = (id: string, patch: Partial<ScanRow>, confirm?: Field) => {
    const next = rows.map((r) => {
      if (r.id !== id) return r;
      const confirmed = confirm && !(r.confirmed ?? []).includes(confirm)
        ? [...(r.confirmed ?? []), confirm] : (r.confirmed ?? []);
      return { ...r, ...patch, confirmed };
    });
    setDraft(next);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate({ rows: next }), 400);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (apiStatus(batch.error) === 404 && !whereis.isFetched) void whereis.refetch();
  }, [batch.error, whereis.isFetched]);

  /** Names with nothing close in the master — genuinely new suppliers. */
  const missingNames = new Set(
    rows.filter((r) => !r.excluded && !r.chosen && !r.match && r.suggestions.length === 0 && r.adatiRawText.trim())
      .map((r) => r.adatiRawText.trim()),
  ).size;

  /* isPending, not isLoading: isLoading is `isPending && isFetching`, so it
     drops to false during retry backoff while there is still no data and no
     error — which previously fell through to the failure screen. */
  if (batch.isPending) {
    return (<><PageHeader title={t("scan.review")} /><Card><SkeletonTable rows={8} /></Card></>);
  }

  if (batch.isError || !batch.data) {
    const notFound = apiStatus(batch.error) === 404;
    const elsewhere = whereis.data?.found ? whereis.data : null;
    return (
      <>
        <PageHeader title={t("scan.review")} />
        <Card className="mx-auto max-w-lg">
          <EmptyState icon={<ScanLine className="h-8 w-8" />}
            title={notFound ? t("scan.notFound") : t("common.somethingWrong")}
            sub={elsewhere ? t("scan.foundInBusiness", { name: elsewhere.name ?? elsewhere.shortCode ?? "" })
              : notFound ? t("scan.notFoundSub")
              : (batch.error instanceof Error ? batch.error.message : undefined)}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {elsewhere ? (
                  <Button variant="primary" loading={goThere.isPending} onClick={() => goThere.mutate(elsewhere.businessId!)}>
                    {t("scan.switchAndOpen", { name: elsewhere.shortCode ?? "" })}
                  </Button>
                ) : notFound ? (
                  <Button variant="secondary" loading={whereis.isFetching} onClick={() => whereis.refetch()}>{t("scan.findIt")}</Button>
                ) : (
                  <Button onClick={() => batch.refetch()}>{t("common.retry")}</Button>
                )}
                <Button onClick={() => navigate("/scan")}>{t("scan.title")}</Button>
              </div>
            } />
        </Card>
      </>
    );
  }
  const b = batch.data;

  if (done) {
    return (
      <Card className="mx-auto max-w-lg">
        <EmptyState icon={<Check className="h-8 w-8 text-ok" />}
          title={t("scan.committed", { n: done.created, date: done.date })}
          sub={done.learned > 0 ? t("scan.learned", { n: done.learned }) : undefined}
          action={<Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate("/daily")}>{t("scan.openDaily")}</Button>} />
      </Card>
    );
  }

  if (b.status === "uploaded" && b.pages.length > 1) {
    return (
      <>
        <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")} />
        {b.warningText && <Alert tone="warn" className="mb-3">{b.warningText}</Alert>}
        {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
        <GeminiUsageBar className="mb-3" />
        <PageOrderer scanId={scanId} pages={b.pages} reading={run.isPending} onRead={() => run.mutate(undefined)} />
      </>
    );
  }

  const reading = b.status === "reading";
  const locked = b.status === "committed";
  const needDate = !b.slipDate;
  const needJins = !b.jinsId;

  const header = (
    <Card className="mb-3">
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Field label={t("daily.date")} className="w-[160px]">
          <Input type="date" value={b.slipDate ?? ""} disabled={locked}
            className={cn("h-8 num text-[13px]", needDate && "border-bad bg-bad-soft/40")}
            onChange={(e) => save.mutate({ rows, slipDate: e.target.value || null })} />
        </Field>
        <Field label={t("daily.mill")} className="min-w-[180px]">
          <Select value={b.merchantId ?? ""} disabled={locked} className="h-8 text-[13px]"
            onChange={(e) => save.mutate({ rows, merchantId: e.target.value || null })}>
            <option value="">{t("daily.noMill")}</option>
            {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
          </Select>
        </Field>
        <Field label={t("daily.jins")} className="min-w-[180px]">
          <Select value={b.jinsId ?? ""} disabled={locked}
            className={cn("h-8 text-[13px]", needJins && "border-bad bg-bad-soft/40")}
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
  );

  const grid = (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
        <p className="text-[13px] font-medium text-ink">{t("scan.extracted")}</p>
        <div className="flex-1" />
        {save.isPending && <Spinner />}
        <Button size="sm" variant="ghost" onClick={() => setShowScan((v) => !v)}
          icon={showScan ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}>
          <span className="hidden sm:inline">{showScan ? t("scan.hideScan") : t("scan.showScan")}</span>
        </Button>
      </div>


      <div className="min-h-0 flex-1 overflow-auto">
        {reading ? (
          /* rows appear only once every page is read, in page order */
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
            <Spinner className="h-7 w-7 text-brand" />
            <p className="text-sm font-semibold text-ink">
              {t("scan.readingPage", { n: Math.min(b.pagesDone + 1, b.pages.length), total: b.pages.length })}
            </p>
            <p className="max-w-sm text-[13px] text-muted">{t("scan.readingSub")}</p>
            {b.warningText && (
              <p className="max-w-sm rounded-lg border border-warn/40 bg-warn-soft px-3 py-1.5 text-[12px] text-warn">{b.warningText}</p>
            )}
          </div>
        ) : rows.length === 0 ? (
          reading ? <div className="p-3"><SkeletonTable rows={8} cols={[{ w: "w-14" }, { w: "w-40" }, { w: "w-16", numeric: true }, { w: "w-16", numeric: true }, { w: "w-20", numeric: true }]} /></div>
            : <EmptyState icon={<ScanLine className="h-7 w-7" />} title={t("common.noResults")} />
        ) : (
          <ScanGrid rows={rows} pageCount={b.pages.length} locked={locked || reading}
            canRate={can("rate.edit")} onPatch={patchRow}
            onPageClick={(p) => { setShowScan(true); scrollToPage.current?.(p); }} />
        )}
      </div>

      {summary && !locked && !reading && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 p-3">
          <div className="text-[12px] text-muted">
            <span className="num font-semibold text-ink">{summary.included}</span> {t("scan.rowsWord")}
            {" · "}<span className="num font-semibold text-ink">{f.weight(summary.totalNetGrams, { unit: true })}</span>
            {" · "}<span className="num font-semibold text-brand">{f.money(summary.totalAmountPaise)}</span>
          </div>
          {missingNames > 0 && can("adati.write") && (
            <Button variant="secondary" loading={createSuppliers.isPending} icon={<UserPlus className="h-3.5 w-3.5" />}
              onClick={() => { setErr(null); createSuppliers.mutate(); }}>
              {t("scan.createMissing", { n: missingNames })}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" size="lg" loading={commit.isPending}
            disabled={summary.blocking > 0 || needDate || needJins || summary.included === 0}
            icon={<Check className="h-4 w-4" />}
            onClick={() => { setErr(null); commit.mutate(); }}>
            {needDate ? t("scan.needDate")
              : needJins ? t("scan.needJins")
              : summary.blocking > 0 ? t("scan.fixRedStars", { n: summary.blocking })
              : t("scan.commit")}
          </Button>
        </div>
      )}
    </Card>
  );

  return (
    <>
      <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")}
        action={!locked && !reading && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad" />}
              onClick={() => { if (confirm(t("scan.confirmDelete"))) remove.mutate(); }} />
            <Button size="sm" variant="secondary" loading={run.isPending}
              icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => run.mutate(undefined)}>
              {t("scan.tryAgain")}
            </Button>
          </div>
        )} />

      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {notice && <Alert tone="ok" className="mb-3">{notice}</Alert>}
      {locked && <Alert tone="ok" className="mb-3">{t("scan.status.committed")}</Alert>}
      {b.warningText && !reading && (
        <Alert tone="warn" className="mb-3">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{b.warningText}</span></span>
        </Alert>
      )}
      {b.errorText && (
        <Alert tone="bad" className="mb-3">
          <p className="font-semibold">{t("scan.failedTitle")}</p>
          <p className="mt-0.5 break-words leading-relaxed">{b.errorText}</p>
          {/^Google rejected/.test(b.errorText) && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => navigate("/settings")}>{t("nav.settings")}</Button>
          )}
        </Alert>
      )}

      {header}

      {b.status === "uploaded" ? (
        <Card>
          <EmptyState icon={<ScanLine className="h-8 w-8" />} title={t("scan.status.uploaded")}
            sub={t("scan.pages", { n: b.pages.length })}
            action={<Button variant="primary" size="lg" loading={run.isPending} icon={<ScanLine className="h-4 w-4" />}
              onClick={() => run.mutate(undefined)}>{t("scan.read")}</Button>} />
        </Card>
      ) : showScan ? (
        <SplitPane storageKey="mandi.split.scanReview" title={t("scan.dragToResize")}
          className="lg:h-[calc(100vh-15rem)]"
          left={<div className="h-[45vh] lg:h-full lg:pr-0">
            <PageViewer scanId={scanId} pages={b.pages} onPage={(fn) => { scrollToPage.current = fn; }} />
          </div>}
          right={<div className="h-[70vh] lg:h-full">{grid}</div>} />
      ) : (
        <div className="lg:h-[calc(100vh-15rem)]">{grid}</div>
      )}
    </>
  );
}
