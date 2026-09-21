import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ZoomIn, ZoomOut, Maximize2, Check, X, AlertTriangle, AlertCircle, Sparkles,
  ArrowRight, Trash2, RotateCcw, ScanLine, ChevronLeft, ChevronRight,
  PanelRightClose, PanelRightOpen, UserPlus, FileText,
} from "lucide-react";
import { api, ApiError, apiStatus, type ScanBatch, type PageCheck, type ScanRow, type ScanIssue, type Jins, type Merchant } from "@/lib/api.ts";
import { sayServer } from "@/lib/serverHi.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat, parseLooseNumber, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { ScanGrid, type Field as GridField } from "@/components/ScanGrid.tsx";
import { SplitPane } from "@/components/SplitPane.tsx";
import { GeminiUsageBar } from "@/components/GeminiUsage.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { TryModelsButton } from "@/components/GeminiModels.tsx";
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
              <PageImage src={`/api/scans/${scanId}/page/${i}`} alt={t("scan.page", { n: i + 1 })} zoom={zoom} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** One page's picture — or, for a sheet scanned on another computer, why it is not here. */
function PageImage({ src, alt, zoom }: { src: string; alt: string; zoom: number }) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <p className="rounded border border-dashed border-line bg-surface p-4 text-center text-[12px] text-muted">{t("scan.imageElsewhere")}</p>;
  }
  return (
    <img src={src} alt={alt} style={{ width: `${zoom * 100}%` }} loading="lazy" onError={() => setMissing(true)}
      className="mx-auto rounded border border-line bg-white" />
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

const dmyIso = (iso: string) => iso.split("-").reverse().join("-");

export function ScanReviewPage({ scanId }: { scanId: string }) {
  const { t, pick, lang } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const ask = useConfirm();
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
      api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"]; pageChecks?: PageCheck[] }>(`/scans/${scanId}/rows`, payload),
    onSuccess: (resp, vars) => {
      setErr(null); // a save that went through clears the last failure
      /* Write the server's answer straight into the cache. Clearing the draft
         and waiting for a refetch left a window where the old rows showed, and
         a click in that window was built on stale data. */
      qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? {
        ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks ?? old.pageChecks,
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
    mutationFn: async (model?: string) => {
      const body = model ? { model } : {};
      try {
        return await api.post(`/scans/${scanId}/run`, body);
      } catch (e) {
        // the server asks whenever a read would replace rows (and the edits on them)
        if (e instanceof ApiError && e.code === "confirm_reread") {
          if (!(await ask({ title: t("scan.rereadTitle"), message: t("scan.confirmReread"), confirmLabel: t("scan.readAgain"), danger: true }))) return null;
          return api.post(`/scans/${scanId}/run`, { ...body, force: true });
        }
        throw e;
      }
    },
    onSuccess: async () => { setDraft(null); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "images_elsewhere" ? t("scan.readElsewhere") : e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        if (latest.current) await save.mutateAsync({ rows: latest.current });
      }
      return api.post<{ created: number; learnedAliases: number; slipDate: string }>(`/scans/${scanId}/commit`);
    },
    onSuccess: async (r) => { setDone({ created: r.created, learned: r.learnedAliases, date: r.slipDate }); await qc.invalidateQueries(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const createSuppliers = useMutation({
    mutationFn: async () => {
      // the last edits first, or the server works from rows a moment old
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        if (latest.current) await save.mutateAsync({ rows: latest.current });
      }
      return api.post<{ created: number; linked: number }>(`/scans/${scanId}/create-suppliers`);
    },
    onSuccess: async (r) => {
      setDraft(null); setErr(null);
      setNotice(t("scan.suppliersCreated", { created: r.created, linked: r.linked }));
      await qc.invalidateQueries({ queryKey: ["scan", scanId] });
      await qc.invalidateQueries({ queryKey: ["adati"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  /** "I checked this page against the paper": its rows line by line, its date, or its total. */
  const pageConfirm = useMutation({
    mutationFn: (o: { page: number; what: "rows" | "date" | "total"; on: boolean }) =>
      api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"]; pageChecks: PageCheck[] }>(`/scans/${scanId}/page-confirm`, o),
    onSuccess: (resp) => {
      qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? { ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks } : old);
      setDraft(null);
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

  // leaving the screen within the 400 ms keeps the last edit: it is sent, not dropped
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      if (latest.current) void api.put(`/scans/${scanId}/rows`, { rows: latest.current }).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    if (apiStatus(batch.error) === 404 && !whereis.isFetched) void whereis.refetch();
  }, [batch.error, whereis.isFetched]);

  /** Before the sheet goes onto the daily list: everything that will be saved, to check against the paper. */
  const confirmCommit = async () => {
    const b0 = batch.data;
    if (!b0 || !summary) return;
    const live = rows.filter((r) => !r.excluded);
    const mill = mills.data?.find((m) => m.id === b0.merchantId);
    const jins = jinsList.data?.find((j) => j.id === b0.jinsId);
    const count = (code: string) => live.filter((r) => r.issues.some((i) => i.code === code)).length;
    const noRate = live.filter((r) => !r.ratePaisePerQtl).length;
    const ok = await ask({
      title: t("scan.confirmCommitTitle"),
      message: t("scan.confirmCommitSub"),
      rows: [
        { label: t("daily.date"), value: b0.slipDate ? dmyIso(b0.slipDate) : "—" },
        { label: t("daily.mill"), value: mill ? `${mill.code} — ${pick(mill.name, mill.nameHi)}` : t("daily.noMill") },
        { label: t("daily.jins"), value: jins ? pick(jins.name, jins.nameHi) : "—" },
        { label: t("scan.confirmLines"), value: t("scan.confirmLinesOf", { n: live.length, pages: b0.pages.length, left: rows.length - live.length }) },
        { label: t("daily.gross"), value: f.weight(live.reduce((x, r) => x + (r.grossGrams ?? 0), 0), { unit: true }) },
        { label: t("daily.net"), value: f.weight(summary.totalNetGrams, { unit: true }), big: true },
        { label: t("daily.amount"), value: f.money(summary.totalAmountPaise), big: true },
      ],
      warnings: [
        count("rst_exists") ? t("scan.warnRstExists", { n: count("rst_exists") }) : "",
        count("rst_dupe") ? t("scan.warnRstDupe", { n: count("rst_dupe") }) : "",
        noRate ? t("scan.warnNoRate", { n: noRate }) : "",
        !mill ? t("scan.warnNoMill") : "",
      ],
      confirmLabel: t("scan.confirmCommitGo"),
    });
    if (ok) commit.mutate();
  };

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
          title={t("scan.committed", { n: done.created, date: dmyIso(done.date) })}
          sub={done.learned > 0 ? t("scan.learned", { n: done.learned }) : undefined}
          action={<Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate(`/daily?date=${done.date}`)}>{t("scan.openDaily")}</Button>} />
      </Card>
    );
  }

  if (b.status === "uploaded" && b.pages.length > 1) {
    return (
      <>
        <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")} />
        {b.warningText && <Alert tone="warn" className="mb-3">{sayServer(b.warningText, lang)}</Alert>}
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
              <p className="max-w-sm rounded-lg border border-warn/40 bg-warn-soft px-3 py-1.5 text-[12px] text-warn">{sayServer(b.warningText, lang)}</p>
            )}
            {/* "reading", but no read is running here: it stopped, or runs on another computer */}
            {!b.running && (
              <div className="mt-2 max-w-sm space-y-2">
                <p className="text-[12px] text-warn">{t("scan.notRunningHere")}</p>
                {can("scan.create") && (
                  <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={run.isPending}
                    onClick={() => { setErr(null); run.mutate(undefined); }}>{t("scan.readAgain")}</Button>
                )}
              </div>
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

      {summary && !locked && !reading && b.status === "review" && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 p-3">
          <div className="text-[12px] text-muted">
            <span className="num font-semibold text-ink">{summary.included}</span> {t("scan.rowsWord")}
            {" · "}<span className="num font-semibold text-ink">{f.weight(summary.totalNetGrams, { unit: true })}</span>
            {" · "}<span className="num font-semibold text-brand">{f.money(summary.totalAmountPaise)}</span>
          </div>
          {missingNames > 0 && can("adati.write") && (
            <Button variant="secondary" loading={createSuppliers.isPending} icon={<UserPlus className="h-3.5 w-3.5" />}
              onClick={async () => {
                setErr(null);
                const names = [...new Set(rows.filter((r) => !r.excluded && !r.chosen && !r.match && r.suggestions.length === 0 && r.adatiRawText.trim()).map((r) => r.adatiRawText.trim()))];
                if (await ask({
                  title: t("scan.confirmNewSuppliersTitle", { n: names.length }),
                  message: <span lang="hi" className="text-[15px]">{names.join(" · ")}</span>,
                  warnings: [t("scan.confirmNewSuppliersWarn")],
                })) createSuppliers.mutate();
              }}>
              {t("scan.createMissing", { n: missingNames })}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" size="lg" loading={commit.isPending}
            disabled={summary.blocking > 0 || (summary.pagesBlocking ?? 0) > 0 || needDate || needJins || summary.included === 0 || save.isPending}
            icon={<Check className="h-4 w-4" />}
            onClick={() => { setErr(null); void confirmCommit(); }}>
            {needDate ? t("scan.needDate")
              : needJins ? t("scan.needJins")
              : (summary.pagesBlocking ?? 0) > 0 ? t("scan.checkPagesFirst", { n: summary.pagesBlocking ?? 0 })
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
        action={!reading && (
          <div className="flex flex-wrap items-center gap-2">
            {can("scan.create") && b.status !== "uploaded" && <TryModelsButton scanId={scanId} pages={b.pages.length} />}
            {!locked && (
              <>
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad" />}
                  onClick={async () => { if (await ask({ title: t("scan.confirmDelete"), danger: true, confirmLabel: t("confirm.yesDelete") })) remove.mutate(); }} title={t("common.delete")} aria-label={t("common.delete")} />
                <Button size="sm" variant="secondary" loading={run.isPending}
                  icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => run.mutate(undefined)}>
                  {t("scan.tryAgain")}
                </Button>
              </>
            )}
          </div>
        )} />

      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {notice && <Alert tone="ok" className="mb-3">{notice}</Alert>}
      {locked && <Alert tone="ok" className="mb-3">{t("scan.status.committed")}</Alert>}
      {b.warningText && !reading && (
        <Alert tone="warn" className="mb-3">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{sayServer(b.warningText, lang)}</span></span>
        </Alert>
      )}
      {b.errorText && (
        <Alert tone="bad" className="mb-3">
          <p className="font-semibold">{t("scan.failedTitle")}</p>
          <p className="mt-0.5 break-words leading-relaxed">{sayServer(b.errorText, lang)}</p>
          {/^Google rejected/.test(b.errorText) && can("business.read") && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => navigate("/settings")}>{t("nav.settings")}</Button>
          )}
        </Alert>
      )}

      {header}

      {(b.pageChecks ?? []).length > 0 && !locked && (
        <Alert tone={(b.pageChecks ?? []).some((pc) => !pc.confirmed) ? "warn" : "ok"} className="mb-3">
          <div className="space-y-2">
            {(b.pageChecks ?? []).map((pc) => {
              const what = pc.code === "page_rows" ? "rows" : pc.code === "page_date" ? "date" : "total";
              return (
                <div key={`${pc.page}-${pc.code}`} className="flex flex-wrap items-start gap-2">
                  {pc.confirmed ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  <span className={cn("min-w-0 flex-1", pc.confirmed && "text-muted")}>
                    {pc.code === "page_rows" ? t("scan.pageRows", { page: pc.page, sr: pc.params.sr, why: t(`scan.slidWhy.${pc.params.why}` as "scan.slidWhy.name_only") })
                      : pc.code === "page_total" ? t("scan.pageTotal", { page: pc.page, written: pc.params.written, net: pc.params.net, gross: pc.params.gross })
                      : t("scan.pageDate", { page: pc.page, written: dmyIso(String(pc.params.written)), scan: dmyIso(String(pc.params.scan)) })}
                  </span>
                  <Button size="sm" variant={pc.confirmed ? "ghost" : "secondary"} loading={pageConfirm.isPending && pageConfirm.variables?.page === pc.page && pageConfirm.variables?.what === what}
                    icon={pc.confirmed ? undefined : <Check className="h-3.5 w-3.5" />}
                    onClick={() => { setErr(null); pageConfirm.mutate({ page: pc.page, what, on: !pc.confirmed }); }}>
                    {pc.confirmed ? t("scan.undoChecked") : t(`scan.confirm.${what}`, { page: pc.page })}
                  </Button>
                </div>
              );
            })}
          </div>
        </Alert>
      )}

      {b.status === "uploaded" ? (
        <Card>
          <EmptyState icon={<ScanLine className="h-8 w-8" />} title={t("scan.status.uploaded")}
            sub={t("scan.pages", { n: b.pages.length })}
            action={<Button variant="primary" size="lg" loading={run.isPending} icon={<ScanLine className="h-4 w-4" />}
              onClick={() => run.mutate(undefined)}>{t("scan.read")}</Button>} />
        </Card>
      ) : showScan ? (
        <SplitPane storageKey="mandi.split.scanReview" title={t("scan.dragToResize")}
          className="lg:sticky lg:top-[4.25rem] lg:h-[calc(100vh-5rem)]"
          left={<div className="h-[45vh] lg:h-full lg:pr-0">
            <PageViewer scanId={scanId} pages={b.pages} onPage={(fn) => { scrollToPage.current = fn; }} />
          </div>}
          right={<div className="h-[70vh] lg:h-full">{grid}</div>} />
      ) : (
        <div className="lg:sticky lg:top-[4.25rem] lg:h-[calc(100vh-5rem)]">{grid}</div>
      )}
    </>
  );
}
