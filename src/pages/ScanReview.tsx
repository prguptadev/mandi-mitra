import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ZoomIn, ZoomOut, Maximize2, Check, X, AlertTriangle, AlertCircle, Sparkles,
  ArrowRight, Trash2, RotateCcw, ScanLine, ChevronLeft, ChevronRight, Equal,
  PanelRightClose, PanelRightOpen, UserPlus,
} from "lucide-react";
import { api, ApiError, apiStatus, type ScanBatch, type ScanRow, type ScanIssue, type Jins, type Merchant } from "@/lib/api.ts";
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

export function ScanReviewPage({ scanId }: { scanId: string }) {
  const { t, pick } = useI18n();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const [, navigate] = useLocation();

  const [draft, setDraft] = useState<ScanRow[] | null>(null);
  const [showScan, setShowScan] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; learned: number; date: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    /* The read runs on the server, detached from any request. Polling means
       switching tabs, opening the daily list, or reloading the page loses
       nothing — come back and the rows are simply there. */
    refetchInterval: (q) => (q?.state?.data?.status === "reading" ? 2000 : false),
    refetchOnWindowFocus: true,
    // a 404 will not become a 200 by asking again, and retrying it leaves the
    // screen in backoff — no data, no error — for several seconds
    retry: (count, err) => apiStatus(err) !== 404 && count < 2,
  });
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
    onSuccess: async () => {
      setDraft(null);
      // the server picks it up from here; polling shows it landing
      await qc.invalidateQueries({ queryKey: ["scan", scanId] });
    },
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

  /** Local edit, then a debounced round-trip so every check is recomputed server-side. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchRow = (id: string, patch: Partial<ScanRow>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate({ rows: next }), 500);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (apiStatus(batch.error) === 404 && !whereis.isFetched) void whereis.refetch();
  }, [batch.error, whereis.isFetched]);

  /** Every row stays on screen and editable until it is approved. */
  const visible = rows;

  /* A number that no longer matches what was read — whether corrected on
     purpose or knocked by a stray keystroke — should say so and offer the
     original back. A silent change to a weight is how money goes missing. */
  const grossEdited = (r: ScanRow) =>
    r.ocr.grossQtl != null && r.grossGrams !== null &&
    Math.abs(r.grossGrams - Math.round(r.ocr.grossQtl * GRAMS_PER_QTL)) > 0;
  const rateEdited = (r: ScanRow) =>
    r.ocr.rate != null && r.ratePaisePerQtl !== null &&
    Math.abs(r.ratePaisePerQtl - Math.round(r.ocr.rate * 100)) > 0;

  /** Distinct names with nothing close in the master — genuinely new suppliers.
   *  Rows with a suggestion are left for the operator to pick, never created. */
  const missingNames = new Set(
    rows.filter((r) => !r.excluded && !r.adatiId && !r.chosen && !r.match
      && r.suggestions.length === 0 && r.adatiRawText.trim())
      .map((r) => r.adatiRawText.trim()),
  ).size;

  /* isPending, not isLoading: isLoading is `isPending && isFetching`, so it
     drops to false during retry backoff while there is still no data and no
     error — which previously fell through to the failure screen. */
  if (batch.isPending) {
    return (<><PageHeader title={t("scan.review")} /><Card><SkeletonTable rows={8} /></Card></>);
  }

  /* A scan belongs to one business. Switching business while this page is open,
     or opening a stale link, lands here — say so instead of blanking out. */
  if (batch.isError || !batch.data) {
    const notFound = apiStatus(batch.error) === 404;
    const elsewhere = whereis.data?.found ? whereis.data : null;
    return (
      <>
        <PageHeader title={t("scan.review")} />
        <Card className="mx-auto max-w-lg">
          <EmptyState
            icon={<ScanLine className="h-8 w-8" />}
            title={notFound ? t("scan.notFound") : t("common.somethingWrong")}
            sub={
              elsewhere ? t("scan.foundInBusiness", { name: elsewhere.name ?? elsewhere.shortCode ?? "" })
              : notFound ? t("scan.notFoundSub")
              : (batch.error instanceof Error ? batch.error.message : undefined)
            }
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {elsewhere ? (
                  <Button variant="primary" loading={goThere.isPending}
                    onClick={() => goThere.mutate(elsewhere.businessId!)}>
                    {t("scan.switchAndOpen", { name: elsewhere.shortCode ?? "" })}
                  </Button>
                ) : notFound ? (
                  <Button variant="secondary" loading={whereis.isFetching}
                    onClick={() => whereis.refetch()}>{t("scan.findIt")}</Button>
                ) : (
                  <Button onClick={() => batch.refetch()}>{t("common.retry")}</Button>
                )}
                <Button onClick={() => navigate("/scan")}>{t("scan.title")}</Button>
              </div>
            }
          />
        </Card>
      </>
    );
  }
  const b = batch.data;

  if (b.status === "reading") {
    return (
      <>
        <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")} />
        <div className="grid gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.35fr)]">
          <div className="h-[45vh] lg:h-[calc(100vh-8rem)]"><PageViewer scanId={scanId} pages={b.pages} /></div>
          <Card>
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
              <Spinner className="h-7 w-7 text-brand" />
              <p className="text-sm font-semibold text-ink">{t("scan.reading")}</p>
              <p className="max-w-sm text-[13px] leading-relaxed text-muted">{t("scan.readingSub")}</p>
              <p className="text-[12px] text-faint">{t("scan.pages", { n: b.pages.length })}</p>
            </div>
            <div className="border-t border-line p-3">
              <SkeletonTable rows={6} cols={[{ w: "w-14" }, { w: "w-40" }, { w: "w-16", numeric: true }, { w: "w-16", numeric: true }, { w: "w-20", numeric: true }]} />
            </div>
          </Card>
        </div>
      </>
    );
  }

  if (b.status === "uploaded") {
    return (
      <>
        <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")} />
        {b.warningText && <Alert tone="warn" className="mb-3">{b.warningText}</Alert>}
        <div className="grid gap-3 lg:grid-cols-[minmax(320px,1fr)_minmax(0,1.35fr)]">
          <div className="h-[45vh] lg:h-[calc(100vh-8rem)]"><PageViewer scanId={scanId} pages={b.pages} /></div>
          <Card>
            <EmptyState
              icon={<ScanLine className="h-8 w-8" />}
              title={t("scan.status.uploaded")}
              sub={t("scan.pages", { n: b.pages.length })}
              action={
                <Button variant="primary" size="lg" loading={run.isPending}
                  icon={<ScanLine className="h-4 w-4" />} onClick={() => run.mutate(undefined)}>
                  {t("scan.read")}
                </Button>
              }
            />
          </Card>
        </div>
      </>
    );
  }

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
      {notice && <Alert tone="ok" className="mb-3">{notice}</Alert>}
      {b.status === "committed" && <Alert tone="ok" className="mb-3">{t("scan.status.committed")}</Alert>}
      {b.warningText && (
        <Alert tone="warn" className="mb-3">
          <span className="inline-flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {b.warningText}
          </span>
        </Alert>
      )}
      {b.errorText && (
        <Alert tone="bad" className="mb-3">
          <p className="font-semibold">{t("scan.failedTitle")}</p>
          <p className="mt-0.5 break-words leading-relaxed">{b.errorText}</p>
          {/^Google rejected/.test(b.errorText) && (
            <Button size="sm" variant="secondary" className="mt-2"
              onClick={() => navigate("/settings")}>{t("nav.settings")}</Button>
          )}
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

      <div className={cn("grid gap-3", showScan && "xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,2fr)]")}>
        {showScan && (
          <div className="h-[45vh] xl:sticky xl:top-4 xl:h-[calc(100vh-8rem)]">
            <PageViewer scanId={scanId} pages={b.pages} />
          </div>
        )}

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
            <p className="text-[13px] font-medium text-ink">{t("scan.extracted")}</p>
            <div className="flex-1" />
            {save.isPending && <Spinner />}
            <Button size="sm" variant="ghost" onClick={() => setShowScan((v) => !v)}
              icon={showScan ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}>
              <span className="hidden sm:inline">{showScan ? t("scan.hideScan") : t("scan.showScan")}</span>
            </Button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-raised/80">
                  {([
                    ["rowNo", "w-9", false], ["rst", "w-16", false], ["adati", "min-w-[190px]", false],
                    ["gross", "w-24", true], ["katauti", "w-16", true], ["deduction", "w-20", true],
                    ["net", "w-24", true], ["rate", "w-24", true], ["amount", "w-28", true],
                    ["conf", "w-14", true], ["act", "w-10", false],
                  ] as const).map(([key, w, numeric]) => (
                    <th key={key} className={cn(
                      "border-b border-line px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted",
                      numeric ? "text-right" : "text-left", w,
                    )}>
                      {key === "rowNo" ? t("scan.rowNo")
                        : key === "rst" ? t("daily.rst")
                        : key === "adati" ? t("daily.supplier")
                        : key === "gross" ? t("daily.gross")
                        : key === "katauti" ? t("daily.bags")
                        : key === "deduction" ? t("daily.katautiWt")
                        : key === "net" ? t("daily.net")
                        : key === "rate" ? <>{t("daily.rate")}{f.symbol && <span className="ml-0.5 font-normal normal-case text-faint">{f.symbol}</span>}</>
                        : key === "amount" ? <>{t("daily.amount")}{f.symbol && <span className="ml-0.5 font-normal normal-case text-faint">{f.symbol}</span>}</>
                        : key === "conf" ? t("scan.conf")
                        : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => {
                  const locked = r.excluded || b.status === "committed";
                  // hand-picked or auto-matched, the name shows the same way
                  const name = r.chosen ?? r.match;
                  return (
                    <Fragment key={r.id}>
                      <tr className={cn(
                        "transition-colors hover:bg-raised/30",
                        r.excluded && "bg-raised/50 opacity-55",
                      )}>
                        <td className="num border-b border-line/70 px-2 py-1 text-[11px] text-faint">{i + 1}</td>

                        <td className="border-b border-line/70 px-1 py-1">
                          <input value={r.rstNo} disabled={locked} placeholder="RST"
                            onChange={(e) => patchRow(r.id, { rstNo: e.target.value })}
                            className={cn(CELL, "text-left")} />
                        </td>

                        <td className="border-b border-line/70 px-1 py-1">
                          {name ? (
                            <div className="flex items-center gap-1.5">
                              <span className="min-w-0 flex-1">
                                <span lang="hi" className="block truncate text-[14px] text-ink">{name.nameHi}</span>
                                <span className="block truncate text-[10px] text-faint">
                                  {name.nameHinglish}
                                  {r.ocr.adatiName && r.ocr.adatiName !== name.nameHi && (
                                    <span lang="hi"> · {t("scan.ocrSaid")}: {r.ocr.adatiName}</span>
                                  )}
                                </span>
                              </span>
                              {r.chosen ? (
                                <Badge tone="brand" className="shrink-0">{t("scan.pickedByYou")}</Badge>
                              ) : r.match && (
                                <Badge tone={r.match.via === "fuzzy" ? "warn" : "ok"} className="shrink-0">
                                  {t(`scan.matchedBy.${r.match.via}` as never)}
                                </Badge>
                              )}
                              {!locked && (
                                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0"
                                  onClick={() => patchRow(r.id, { adatiId: null, nameCorrected: true })}>
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          ) : (
                            <SupplierPicker value={r.adatiId} disabled={locked}
                              invalid={!locked}
                              placeholder={r.adatiRawText || t("scan.pickName")}
                              onChange={(v) => patchRow(r.id, { adatiId: v, nameCorrected: true })} />
                          )}
                        </td>

                        <td className="border-b border-line/70 px-1 py-1">
                          <input inputMode="decimal" disabled={locked}
                            className={cn(CELL, grossEdited(r) && "border-warn text-warn")}
                            value={r.grossGrams === null ? "" : (r.grossGrams / GRAMS_PER_QTL).toFixed(2)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { grossGrams: n === null ? null : Math.round(n * GRAMS_PER_QTL) });
                            }} />
                          {grossEdited(r) && (
                            <button type="button" title={t("scan.restoreRead")}
                              onClick={() => patchRow(r.id, { grossGrams: Math.round(r.ocr.grossQtl! * GRAMS_PER_QTL) })}
                              className="num mt-0.5 block w-full text-right text-[10px] text-warn hover:underline">
                              {t("scan.wasRead")} {r.ocr.grossQtl!.toFixed(2)}
                            </button>
                          )}
                        </td>

                        <td className="border-b border-line/70 px-1 py-1">
                          <input inputMode="numeric" disabled={locked}
                            className={cn(CELL, r.katautiOverride === null && "text-faint")}
                            placeholder={r.derivedKatautiUnits === null ? "" : String(r.derivedKatautiUnits)}
                            value={r.katautiOverride === null ? "" : String(r.katautiOverride)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { katautiOverride: n === null ? null : Math.round(n) });
                            }} />
                        </td>

                        <td className="num border-b border-line/70 px-2 py-1 text-right text-faint">
                          {r.derivedNetGrams === null || r.grossGrams === null ? "—" : f.weight(r.grossGrams - r.derivedNetGrams)}
                        </td>

                        <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold">
                          <span className="inline-flex items-center justify-end gap-1">
                            {r.derivedNetGrams === null ? "—" : f.weight(r.derivedNetGrams)}
                            {r.netAgrees === true && <span title={t("scan.netAgreeHelp")}><Equal className="h-3 w-3 text-ok" /></span>}
                            {r.netAgrees === false && r.ocr.netQtl != null && (
                              <span className="num text-[10px] font-normal text-warn" title={t("scan.sheetSaid")}>
                                ({r.ocr.netQtl.toFixed(2)})
                              </span>
                            )}
                          </span>
                        </td>

                        <td className="border-b border-line/70 px-1 py-1">
                          <input inputMode="decimal" disabled={locked || !can("rate.edit")} className={CELL}
                            value={r.ratePaisePerQtl === null ? "" : (r.ratePaisePerQtl / 100).toFixed(2)}
                            onChange={(e) => {
                              const n = parseLooseNumber(e.target.value);
                              patchRow(r.id, { ratePaisePerQtl: n === null ? null : Math.round(n * 100) });
                            }} />
                        </td>

                        <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold text-brand">
                          {r.derivedAmountPaise === null ? "—" : f.amount(r.derivedAmountPaise)}
                        </td>

                        <td className="num border-b border-line/70 px-2 py-1 text-right">
                          {r.ocr.confidence == null ? "—" : (
                            <Badge tone={r.ocr.confidence >= 0.8 ? "ok" : r.ocr.confidence >= 0.6 ? "warn" : "bad"} className="num">
                              {Math.round(r.ocr.confidence * 100)}
                            </Badge>
                          )}
                        </td>

                        <td className="border-b border-line/70 px-1 py-1">
                          <Button size="icon" variant="ghost" className="h-6 w-6"
                            title={r.excluded ? t("scan.include") : t("scan.exclude")}
                            disabled={b.status === "committed"}
                            onClick={() => patchRow(r.id, { excluded: !r.excluded })}>
                            {r.excluded ? <RotateCcw className="h-3 w-3" /> : <Trash2 className="h-3 w-3 text-bad/70" />}
                          </Button>
                        </td>
                      </tr>

                      {/* only offers, never verdicts: one tap fills the supplier in */}
                      {!r.excluded && !r.chosen && !r.match && r.suggestions.length > 0 && (
                        <tr>
                          <td className="border-b border-line/70" />
                          <td className="border-b border-line/70" />
                          <td colSpan={9} className="border-b border-line/70 px-1 pb-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Sparkles className="h-2.5 w-2.5 shrink-0 text-faint" />
                              {r.suggestions.map((sg) => (
                                <button key={sg.adatiId} type="button"
                                  onClick={() => patchRow(r.id, { adatiId: sg.adatiId, nameCorrected: true })}
                                  className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] hover:border-brand hover:bg-brand/5">
                                  <span lang="hi">{sg.nameHi}</span>
                                  <span className="num text-faint">{Math.round(sg.confidence * 100)}%</span>
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>

              {summary && summary.included > 0 && (
                <tfoot>
                  <tr className="bg-raised font-semibold">
                    <td colSpan={3} className="px-2 py-2 text-right text-[12px] uppercase tracking-wide text-muted">
                      {t("daily.totals")}
                    </td>
                    <td className="num px-2 py-2 text-right">
                      {f.weight(rows.filter((r) => !r.excluded).reduce((s, r) => s + (r.grossGrams ?? 0), 0))}
                    </td>
                    <td className="num px-2 py-2 text-right">
                      {f.int(rows.filter((r) => !r.excluded).reduce((s, r) => s + (r.derivedKatautiUnits ?? 0), 0))}
                    </td>
                    <td />
                    <td className="num px-2 py-2 text-right text-[14px]">{f.weight(summary.totalNetGrams)}</td>
                    <td />
                    <td className="num px-2 py-2 text-right text-[14px] text-brand">{f.amount(summary.totalAmountPaise)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {visible.length === 0 && (
            <EmptyState icon={<ScanLine className="h-7 w-7" />} title={t("common.noResults")} />
          )}

          {summary && b.status !== "committed" && (
            <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 p-3 backdrop-blur">
              <div className="text-[12px] text-muted">
                <span className="num font-semibold text-ink">{summary.included}</span>{" "}{t("scan.rowsWord")}
                {" · "}
                <span className="num font-semibold text-ink">{f.weight(summary.totalNetGrams, { unit: true })}</span>
                {" · "}
                <span className="num font-semibold text-brand">{f.money(summary.totalAmountPaise)}</span>
              </div>
              {summary.blocking > 0 && missingNames > 0 && can("adati.write") && (
                <Button variant="secondary" loading={createSuppliers.isPending}
                  icon={<UserPlus className="h-3.5 w-3.5" />}
                  onClick={() => { setErr(null); createSuppliers.mutate(); }}>
                  {t("scan.createMissing", { n: missingNames })}
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="primary" size="lg" loading={commit.isPending}
                disabled={summary.blocking > 0 || !b.slipDate || !b.jinsId || summary.included === 0}
                icon={<Check className="h-4 w-4" />}
                onClick={() => { setErr(null); commit.mutate(); }}>
                {summary.blocking > 0 ? t("scan.needSuppliers", { n: summary.blocking })
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
