import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ZoomIn, ZoomOut, Maximize2, Check, AlertTriangle,
  ArrowRight, ArrowLeft, Trash2, RotateCcw, ScanLine, ChevronLeft, ChevronRight,
  PanelRightClose, PanelRightOpen, UserPlus, FileText, ArrowDownUp, Expand, Shrink,
} from "lucide-react";
import { api, ApiError, apiStatus, type ScanBatch, type PageCheck, type ScanRow, type Jins, type Merchant } from "@/lib/api.ts";
import { sayServer } from "@/lib/serverHi.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFormat } from "@/lib/format.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { ScanGrid, type Field as GridField, type ScanGridHandle } from "@/components/ScanGrid.tsx";
import { SplitPane } from "@/components/SplitPane.tsx";
import { GeminiUsageBar } from "@/components/GeminiUsage.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { TryModelsButton } from "@/components/GeminiModels.tsx";
import {
  Button, Card, CardHeader, Select, Input, Alert, Spinner, EmptyState,
} from "@/components/ui/index.tsx";
import { useOwnCode } from "@/components/OwnFirm.tsx";
import { cn } from "@/lib/utils.ts";

/** Where the picture should look: a page, and the line on it when the reader said where it is. */
type Focus = { page: number; y: number | null; nonce: number };

/* A page's picture by its place and its file name. The browser keeps
   pictures for an hour: asked for by place alone, a page moved in the order
   would show the picture cached for its old place beside its new lines. */
const pageSrc = (scanId: string, index: number, name: string) => `/api/scans/${scanId}/page/${index}?f=${encodeURIComponent(name)}`;

/**
 * Every page of the sheet, one after another in a single scroll, so the grid
 * beside it can be read top to bottom against the paper. Zoom applies to all.
 * The line in hand in the grid is followed: its page is brought into view,
 * and when the reader said where the line sits, the picture zooms in on it
 * and marks it.
 */
function PageViewer({ scanId, pages, focus }: {
  scanId: string;
  pages: ScanBatch["pages"];
  focus: Focus | null;
}) {
  const { t } = useI18n();
  const [zoom, setZoomNow] = useState(1);
  // a zoom chosen by hand is kept: following a line never undoes it
  const byHand = useRef(false);
  const setZoom = (z: number | ((v: number) => number)) => { byHand.current = true; setZoomNow(z); };
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  const latest = useRef(0);
  useEffect(() => {
    if (!focus) return;
    latest.current = focus.nonce;
    const go = () => {
      if (latest.current !== focus.nonce) return; // another line was taken up meanwhile
      const wrap = refs.current[focus.page - 1];
      const sc = scroller.current;
      if (!wrap || !sc) return;
      /* A picture still loading has no height yet, and the pages above it
         push it down when they arrive: wait for them, or the mark lands on
         the wrong line. */
      const waiting = refs.current.slice(0, focus.page).flatMap((w) => [...(w?.querySelectorAll("img") ?? [])]).filter((x) => !x.complete);
      if (waiting.length) {
        void Promise.all(waiting.map((x) => new Promise((res) => { x.addEventListener("load", res, { once: true }); x.addEventListener("error", res, { once: true }); }))).then(go);
        return;
      }
      const img = wrap.querySelector("img");
      const box = sc.getBoundingClientRect();
      if (focus.y != null && img) {
        const r = img.getBoundingClientRect();
        const top = sc.scrollTop + (r.top - box.top) + (focus.y / 1000) * r.height;
        // the name and the weights are on the left of the line
        sc.scrollTo({ top: Math.max(0, top - sc.clientHeight / 2), left: 0, behavior: "smooth" });
      } else {
        sc.scrollTo({ top: sc.scrollTop + (wrap.getBoundingClientRect().top - box.top) - 4, behavior: "smooth" });
      }
    };
    if (focus.y != null && zoom < 1.75 && !byHand.current) {
      setZoomNow(1.75);
      // after the bigger picture is laid out
      requestAnimationFrame(() => requestAnimationFrame(go));
    } else go();
  }, [focus?.nonce]);

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
      <div ref={scroller} className="relative flex-1 space-y-3 overflow-auto bg-raised/40 p-2">
        {pages.map((p, i) => (
          <div key={`${p.name}-${i}`} ref={(el) => { refs.current[i] = el; }}>
            <p className={cn("mb-1 flex items-center gap-1.5 text-[11px] font-semibold",
              focus?.page === i + 1 ? "text-brand" : "text-muted")}>
              <FileText className="h-3 w-3" /> {t("scan.page", { n: i + 1 })}
            </p>
            {p.mimeType === "application/pdf" ? (
              <iframe title={p.name} src={pageSrc(scanId, i, p.name)}
                className="h-[70vh] w-full rounded border border-line bg-white" />
            ) : (
              <PageImage src={pageSrc(scanId, i, p.name)} alt={t("scan.page", { n: i + 1 })} zoom={zoom}
                heic={/hei[cf]/i.test(p.mimeType)} line={focus?.page === i + 1 ? focus.y : null} />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** One page's picture — or, when it cannot be shown here, why not. The line in hand is marked on it. */
function PageImage({ src, alt, zoom, heic, line }: { src: string; alt: string; zoom: number; heic: boolean; line: number | null }) {
  const { t } = useI18n();
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <p className="rounded border border-dashed border-line bg-surface p-4 text-center text-[12px] text-muted">{heic ? t("scan.imageHeic") : t("scan.imageElsewhere")}</p>;
  }
  return (
    <div className="relative mx-auto" style={{ width: `${zoom * 100}%` }}>
      <img src={src} alt={alt} onError={() => setMissing(true)}
        className="block w-full rounded border border-line bg-white" />
      {line != null && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 h-[3.2%] -translate-y-1/2 rounded-sm border-y-2 border-brand bg-brand/15"
          style={{ top: `${line / 10}%` }} />
      )}
    </div>
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
      <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
                <img src={pageSrc(scanId, pageIndex, p.name)} alt="" loading="lazy"
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
type SaveResp = { rows: ScanRow[]; summary: ScanBatch["summary"]; pageChecks?: PageCheck[]; rev?: string; suppliersCreated?: { id: string; nameHi: string; nameHinglish: string }[] };
type SavePayload = { rows: ScanRow[]; slipDate?: string | null; merchantId?: string | null; jinsId?: string | null };

const dmyIso = (iso: string) => iso.split("-").reverse().join("-");

/** One page check in plain words, with the one or two things that can be done about it. */
function PageCheckLine({ pc, busy, onConfirm, onUse, onReread, onOrder, onShow }: {
  pc: PageCheck; busy: boolean;
  onConfirm: (on: boolean) => void;
  /** page_mill / page_jins: take what the header says. */
  onUse: () => void;
  /** page_cut, page_count, page_total: read this one page again. */
  onReread: () => void;
  /** page_order: put the pages in the order their line numbers run. */
  onOrder: () => void;
  onShow: () => void;
}) {
  const { t } = useI18n();
  const p = pc.params;
  const span = p.first != null ? t("scan.pc.span", { first: p.first, last: p.last }) : "";
  const text = pc.code === "page_rows" ? t("scan.pageRows", { page: pc.page, sr: p.sr, why: t(`scan.slidWhy.${p.why}` as "scan.slidWhy.name_only") })
    : pc.code === "page_total" ? (p.allNet != null
      ? t("scan.pc.totalAll", { page: pc.page, written: p.written, net: p.net, gross: p.gross, allNet: p.allNet, allGross: p.allGross })
      : t("scan.pageTotal", { page: pc.page, written: p.written, net: p.net, gross: p.gross }))
    : pc.code === "page_date" ? (p.why === "none" ? t("scan.pc.dateNone", { scan: dmyIso(String(p.scan)) })
      : p.why === "unread" ? t("scan.pc.dateUnread", { raw: p.raw, scan: dmyIso(String(p.scan)) })
      : t("scan.pageDate", { page: pc.page, written: dmyIso(String(p.written)), scan: dmyIso(String(p.scan)) }))
    : pc.code === "page_cut" ? t("scan.pc.cut", { page: pc.page, n: p.n, span })
    : pc.code === "page_count" ? t("scan.pc.count", { page: pc.page, n: p.n, span })
    : pc.code === "page_struck" ? t("scan.pc.struck", { page: pc.page, lines: p.lines, n: p.n })
    : pc.code === "page_mill" ? t("scan.pc.mill", { written: p.written, label: p.label, filed: p.filed })
    : pc.code === "page_jins" ? t("scan.pc.jins", { written: p.written, label: p.label, filed: p.filed })
    : pc.code === "page_order" ? t("scan.pc.order", { first: p.firstPage, order: p.order })
    : t("scan.pc.norate", { page: pc.page, n: p.n });
  const what = pc.code.slice("page_".length);
  const okLabel = pc.code === "page_rows" ? t("scan.confirm.rows", { page: pc.page })
    : pc.code === "page_date" ? (p.why === "differs" ? t("scan.confirm.date") : t("scan.pcOk.date", { scan: dmyIso(String(p.scan)) }))
    : pc.code === "page_total" ? t("scan.confirm.total")
    : pc.code === "page_count" ? t("scan.pcOk.count", { n: p.n })
    : pc.code === "page_mill" || pc.code === "page_jins" ? t("scan.pcOk.keep", { filed: p.filed })
    : t(`scan.pcOk.${what}` as "scan.pcOk.cut");

  return (
    <div className="flex flex-wrap items-start gap-2">
      {pc.confirmed ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
      <button type="button" onClick={onShow} className={cn("min-w-0 flex-1 text-left", pc.confirmed && "text-muted")}>{text}</button>
      {pc.confirmed ? (
        <Button size="sm" variant="ghost" loading={busy} onClick={() => onConfirm(false)}>{t("scan.undoChecked")}</Button>
      ) : (
        <span className="flex flex-wrap gap-1.5">
          {(pc.code === "page_mill" || pc.code === "page_jins") && (
            <Button size="sm" variant="primary" loading={busy} onClick={onUse}>{t("scan.pc.use", { label: p.label })}</Button>
          )}
          {(pc.code === "page_cut" || pc.code === "page_count" || (pc.code === "page_total" && p.allNet == null)) && (
            <Button size="sm" variant="primary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReread}>{t("scan.pc.readPage", { page: pc.page })}</Button>
          )}
          {pc.code === "page_order" && (
            <Button size="sm" variant="primary" loading={busy} icon={<ArrowDownUp className="h-3.5 w-3.5" />} onClick={onOrder}>{t("scan.pc.orderGo")}</Button>
          )}
          <Button size="sm" variant="secondary" loading={busy} icon={<Check className="h-3.5 w-3.5" />} onClick={() => onConfirm(true)}>{okLabel}</Button>
        </span>
      )}
    </div>
  );
}

/* One sheet per screen: going from one sheet straight to another (the "same
   picture" warning links to it) starts afresh, never with the first sheet's
   edits, version or line in hand. */
export function ScanReviewPage({ scanId }: { scanId: string }) {
  return <ScanReviewScreen key={scanId} scanId={scanId} />;
}

function ScanReviewScreen({ scanId }: { scanId: string }) {
  const { t, pick, lang } = useI18n();
  const ownCode = useOwnCode();
  const f = useFormat();
  const qc = useQueryClient();
  const { can } = useSession();
  const ask = useConfirm();
  const [, navigate] = useLocation();

  const [draft, setDraft] = useState<ScanRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [done, setDone] = useState<{ created: number; learned: number; date: string; parchas: { parchaNo: string; truckNo: string | null }[] } | null>(null);
  const [showScan, setShowScan] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const grid = useRef<ScanGridHandle>(null);

  /* Any action that fails says why in the operator's words; when the sheet
     was changed on another screen meanwhile, the newer sheet is loaded too. */
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === "stale_rows") void qc.invalidateQueries({ queryKey: ["scan", scanId] });
    setErr(e instanceof ApiError
      ? e.code === "stale_rows" ? t("scan.staleRows") : e.code === "images_elsewhere" ? t("scan.readElsewhere") : e.message
      : t("common.somethingWrong"));
  };

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

  /* Every save carries the version of the sheet this screen last saw, and
     saves go one after another: a second screen's older copy can then never
     quietly put back what was corrected here (the server refuses it). */
  const rev = useRef<string | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef<ScanRow[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useMutation({
    mutationFn: (payload: SavePayload) => {
      const run = chain.current.catch(() => undefined).then(async () => {
        const resp = await api.put<SaveResp>(`/scans/${scanId}/rows`, { ...payload, rev: rev.current });
        rev.current = resp.rev;
        /* The server's answer straight into the cache. Clearing the draft and
           waiting for a refetch left a window where the old rows showed, and a
           click in that window was built on stale data. */
        qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? {
          ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks ?? old.pageChecks, rev: resp.rev,
          ...(payload.slipDate !== undefined ? { slipDate: payload.slipDate ?? null } : {}),
          ...(payload.merchantId !== undefined ? { merchantId: payload.merchantId ?? null } : {}),
          ...(payload.jinsId !== undefined ? { jinsId: payload.jinsId ?? null } : {}),
        } : old);
        return resp;
      });
      chain.current = run;
      return run;
    },
    onSuccess: (resp, vars) => {
      setErr(null); // a save that went through clears the last failure
      if (resp.suppliersCreated?.length) {
        const names = resp.suppliersCreated.map((s) => pick(s.nameHinglish, s.nameHi)).join(", ");
        setNotice(t("scan.nameMade", { names }));
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), 6000);
        void qc.invalidateQueries({ queryKey: ["adati"] });
      }
      // only drop the draft if nothing newer was typed while this was saving
      if (latest.current === vars.rows) setDraft(null);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "stale_rows") {
        // someone else's change is on the server: load it, and say so plainly
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        latest.current = null;
        setDraft(null);
        rev.current = "stale";
        setErr(t("scan.staleRows"));
        void qc.invalidateQueries({ queryKey: ["scan", scanId] });
        return;
      }
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
    },
  });
  /* The version of the rows on screen, whenever no edit of this screen is on
     its way. Looked at again once the edit has gone (or was refused), not
     only when a load brings a new version: a load that came in while an edit
     was pending, then a refusal, must not leave every later save refused. */
  useEffect(() => {
    if (batch.data?.rev && !draft && !save.isPending) rev.current = batch.data.rev;
  }, [batch.data?.rev, draft, save.isPending]);

  /** The edits typed in the last moments go to the server first; then its answer is the truth. */
  const flush = async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      if (latest.current) await save.mutateAsync({ rows: latest.current });
    }
    await chain.current.catch(() => undefined);
    return qc.getQueryData<ScanBatch>(["scan", scanId]) ?? null;
  };

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
    onError: fail,
  });

  /** One page read again: only its lines are replaced, the other pages and their changes stay. */
  const readPage = useMutation({
    mutationFn: async (page: number) => {
      if (!(await ask({ title: t("scan.rereadPageTitle", { page }), message: t("scan.rereadPageSub"), confirmLabel: t("scan.pc.readPage", { page }) }))) return null;
      await flush();
      return api.post(`/scans/${scanId}/run`, { page });
    },
    onSuccess: async (r) => { if (r) { setDraft(null); await qc.invalidateQueries({ queryKey: ["scan", scanId] }); } },
    onError: fail,
  });

  /** The pages put in the order their line numbers run; each page's lines and picture move together. */
  const putInOrder = useMutation({
    mutationFn: async (pagesInOrder: number[]) => {
      await flush();
      return api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"]; pageChecks: PageCheck[]; pages: ScanBatch["pages"]; rev: string }>(
        `/scans/${scanId}/order`, { order: pagesInOrder.map((p) => p - 1), rev: rev.current });
    },
    onSuccess: (resp) => {
      rev.current = resp.rev;
      qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? { ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks, pages: resp.pages, rev: resp.rev } : old);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["scan", scanId] });
    },
    onError: fail,
  });

  const commit = useMutation({
    mutationFn: async () => {
      await flush();
      /* The version the "are you sure" box was built from: a change made on
         another screen since is shown first, never added unseen. */
      return api.post<{ created: number; learnedAliases: number; slipDate: string; approvedParchas?: { parchaNo: string; truckNo: string | null }[] }>(
        `/scans/${scanId}/commit`, { rev: rev.current });
    },
    onSuccess: async (r) => {
      setDone({ created: r.created, learned: r.learnedAliases, date: r.slipDate, parchas: r.approvedParchas ?? [] });
      await qc.invalidateQueries();
    },
    onError: fail,
  });

  const createSuppliers = useMutation({
    mutationFn: async () => {
      // the last edits first, or the server works from rows a moment old
      await flush();
      const r = await api.post<{ created: number; linked: number; rev?: string }>(`/scans/${scanId}/create-suppliers`);
      if (r.rev) rev.current = r.rev;
      return r;
    },
    onSuccess: async (r) => {
      setDraft(null); setErr(null);
      setNotice(t("scan.suppliersCreated", { created: r.created, linked: r.linked }));
      await qc.invalidateQueries({ queryKey: ["scan", scanId] });
      await qc.invalidateQueries({ queryKey: ["adati"] });
    },
    onError: fail,
  });

  /** "I checked this page against the paper": its rows, its date, its total, its lines… */
  const pageConfirm = useMutation({
    mutationFn: async (o: { page: number; what: string; on: boolean }) => {
      await flush();
      return api.put<{ rows: ScanRow[]; summary: ScanBatch["summary"]; pageChecks: PageCheck[] }>(`/scans/${scanId}/page-confirm`, o);
    },
    onSuccess: (resp) => {
      qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? { ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks } : old);
      setDraft(null);
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/scans/${scanId}`),
    onSuccess: () => navigate("/scan"),
  });

  /** Local edit now, a debounced round-trip so every check is recomputed on the server. */
  const patchRow = (id: string, patch: Partial<ScanRow>, confirm?: Field | Field[], now = false) => {
    const accepted = confirm === undefined ? [] : Array.isArray(confirm) ? confirm : [confirm];
    const next = rows.map((r) => {
      if (r.id !== id) return r;
      const confirmed = [...new Set([...(r.confirmed ?? []), ...accepted])];
      return { ...r, ...patch, confirmed };
    });
    setDraft(next);
    latest.current = next;
    if (timer.current) clearTimeout(timer.current);
    // a typed name is saved at once: it makes the supplier, and the row comes back naming it
    timer.current = setTimeout(() => { timer.current = null; save.mutate({ rows: next }); }, now ? 0 : 400);
  };

  /* Leaving the screen within the 400 ms keeps the last edit: it is sent
     after any save still on its way, and the answer goes into the cache, so
     the sheet opened again shows that edit and its version. */
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      const last = latest.current;
      if (last) {
        void chain.current.catch(() => undefined)
          .then(() => api.put<SaveResp>(`/scans/${scanId}/rows`, { rows: last, rev: rev.current }))
          .then((resp) => qc.setQueryData<ScanBatch>(["scan", scanId], (old) => old ? {
            ...old, rows: resp.rows, summary: resp.summary, pageChecks: resp.pageChecks ?? old.pageChecks, rev: resp.rev,
          } : old))
          .catch(() => undefined);
      }
    }
  }, []);
  useEffect(() => {
    if (apiStatus(batch.error) === 404 && !whereis.isFetched) void whereis.refetch();
  }, [batch.error, whereis.isFetched]);

  const select = (r: ScanRow) => {
    setSelectedId(r.id);
    if (showScan) setFocus({ page: r.page ?? 1, y: r.ocr.lineY ?? null, nonce: Date.now() });
  };
  const showPage = (page: number) => { setShowScan(true); setFocus({ page, y: null, nonce: Date.now() }); };

  /* The whole monitor for checking a sheet: the window's title bar and the
     taskbar go too. Esc, or the same button, brings them back. */
  const [full, setFull] = useState(() => typeof document !== "undefined" && Boolean(document.fullscreenElement));
  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      // leaving the sheet leaves full screen too: the other pages keep the normal window
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  /** A page check, answered where it is shown: at the head of its page in the grid. */
  const renderCheck = (pc: PageCheck) => {
    const what = pc.code.slice("page_".length);
    return (
      <PageCheckLine pc={pc}
        busy={(pageConfirm.isPending && pageConfirm.variables?.page === pc.page && pageConfirm.variables?.what === what)
          || save.isPending || (pc.code === "page_order" && putInOrder.isPending)}
        onConfirm={(on) => { setErr(null); pageConfirm.mutate({ page: pc.page, what, on }); }}
        onUse={() => save.mutate(pc.code === "page_mill"
          ? { rows, merchantId: String(pc.params.id) || null }
          : { rows, jinsId: String(pc.params.id) || null })}
        onReread={() => { setErr(null); readPage.mutate(pc.page); }}
        onOrder={() => { setErr(null); putInOrder.mutate(String(pc.params.order).split(",").map((x) => Number(x.trim()))); }}
        onShow={() => showPage(pc.page)} />
    );
  };

  /**
   * Before the sheet goes onto the daily list: everything that will be saved,
   * to check against the paper. The last edits are saved first and the box is
   * built from the server's answer, so it never shows figures from before them.
   */
  const confirmCommit = async () => {
    let fresh: ScanBatch | null;
    try { fresh = await flush(); } catch { return; }
    const b0 = fresh ?? batch.data;
    const sum = b0?.summary;
    if (!b0 || !sum || sum.blocking > 0 || (sum.pagesBlocking ?? 0) > 0) return;
    const all = b0.rows;
    const live = all.filter((r) => !r.excluded);
    const left = all.filter((r) => r.excluded);
    const mill = mills.data?.find((m) => m.id === b0.merchantId);
    const jins = jinsList.data?.find((j) => j.id === b0.jinsId);
    const count = (code: string) => live.filter((r) => r.issues.some((i) => i.code === code)).length;
    const noRate = live.filter((r) => !r.ratePaisePerQtl).length;
    const noRst = live.filter((r) => !r.rstNo).length;
    // the same paper already added from another sheet: said once more, still only a warning
    const addedTwice = (b0.samePictures ?? []).filter((s) => s.status === "committed");
    const ok = await ask({
      title: t("scan.confirmCommitTitle"),
      message: t("scan.confirmCommitSub"),
      rows: [
        { label: t("daily.date"), value: b0.slipDate ? dmyIso(b0.slipDate) : "—" },
        { label: t("daily.mill"), value: mill ? `${mill.code} — ${pick(mill.name, mill.nameHi)}` : ownCode },
        { label: t("daily.jins"), value: jins ? pick(jins.name, jins.nameHi) : "—" },
        { label: t("scan.confirmLines"), value: t("scan.confirmLinesOf", { n: live.length, pages: b0.pages.length, left: left.length }) },
        { label: t("daily.gross"), value: f.weight(live.reduce((x, r) => x + (r.grossGrams ?? 0), 0), { unit: true }) },
        { label: t("daily.net"), value: f.weight(sum.totalNetGrams, { unit: true }), big: true },
        { label: t("daily.amount"), value: f.money(sum.totalAmountPaise), big: true },
      ],
      warnings: [
        addedTwice.length ? t("scan.warnSamePicture", { dates: [...new Set(addedTwice.map((s) => (s.slipDate ? dmyIso(s.slipDate) : "—")))].join(", ") }) : "",
        (() => { const n = live.filter((r) => !(r.adatiId ?? r.match?.adatiId) && r.adatiRawText.trim()).length; return n ? t("scan.warnNewSuppliers", { n }) : ""; })(),
        count("rst_exists") ? t("scan.warnRstExists", { n: count("rst_exists") }) : "",
        count("rst_dupe") ? t("scan.warnRstDupe", { n: count("rst_dupe") }) : "",
        count("rst_other_day") ? t("scan.warnRstOtherDay", { n: count("rst_other_day") }) : "",
        noRst ? t("scan.warnNoRst", { n: noRst }) : "",
        noRate ? t("scan.warnNoRate", { n: noRate }) : "",
        count("rate_day") ? t("scan.warnRateDay", { n: count("rate_day") }) : "",
        left.length ? t("scan.warnLeftOut", { n: left.length, list: left.map((r) => r.rstNo ? `RST ${r.rstNo}` : `SR ${r.ocr.srNo ?? "?"}`).join(", ") }) : "",
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
      <Card className="mx-auto mt-6 max-w-lg">
        <EmptyState icon={<Check className="h-8 w-8 text-ok" />}
          title={t("scan.committed", { n: done.created, date: dmyIso(done.date) })}
          sub={done.learned > 0 ? t("scan.learned", { n: done.learned }) : undefined}
          action={<div className="space-y-3">
            {/* the day's average moved: a parcha already approved on it keeps its old figures */}
            {done.parchas.length > 0 && (
              <Alert tone="warn">{t("daily.parchaStale", { nos: done.parchas.map((p) => `#${p.parchaNo}${p.truckNo ? ` (${p.truckNo})` : ""}`).join(", ") })}</Alert>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" icon={<ArrowRight className="h-4 w-4" />} onClick={() => navigate(`/daily?date=${done.date}`)}>{t("scan.openDaily")}</Button>
              <Button onClick={() => navigate("/scan")}>{t("scan.title")}</Button>
            </div>
          </div>} />
      </Card>
    );
  }

  /** The same paper uploaded on another sheet: which page, where it already is, and a way to look. Only a warning. */
  function samePictureAlert(same: NonNullable<ScanBatch["samePictures"]>) {
    if (!same.length) return null;
    // said in one running line, so the lines and the picture keep the room
    return (
      <Alert tone="warn">
        <span className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {same.map((s) => (
              <span key={`${s.page}-${s.scanId}-${s.otherPage}`}>
                {t("scan.samePicture", {
                  page: s.page, otherPage: s.otherPage, date: s.slipDate ? dmyIso(s.slipDate) : "—",
                  status: t(`scan.status.${s.status}` as never) || s.status,
                })}{" "}
                <button type="button" className="font-medium underline underline-offset-2 hover:text-ink" onClick={() => navigate(`/scan/${s.scanId}`)}>
                  {t("scan.openThatSheet")}
                </button>{" · "}
              </span>
            ))}
            <span className="text-[11.5px] opacity-90">{t("scan.samePictureOnly")}</span>
          </span>
        </span>
      </Alert>
    );
  }

  if (b.status === "uploaded" && b.pages.length > 1) {
    return (
      <>
        <PageHeader title={t("scan.review")} sub={t("scan.reviewSub")} />
        {b.samePictures?.length ? <div className="mb-3">{samePictureAlert(b.samePictures)}</div> : null}
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
  const checks = b.pageChecks ?? [];
  const twice = locked ? null : samePictureAlert(b.samePictures ?? []);

  /* What the reader saw at the head and foot of the pages, beside the three
     boxes it should agree with. */
  const saw = (b.header ?? []).flatMap((h) => [
    h.date ? `${t("daily.date")} ${h.date}` : "",
    h.millName ? `${t("daily.mill")} ${h.millName}` : "",
    h.jins ? `${t("daily.jins")} ${h.jins}` : "",
    h.total != null ? `${t("scan.totalWord")} ${h.total}${(b.header ?? []).length > 1 ? ` (${t("scan.page", { n: h.page })})` : ""}` : "",
  ]).filter(Boolean);

  // one bar: what the sheet is, and what can be done with it
  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5">
      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => navigate("/scan")} title={t("scan.title")} aria-label={t("scan.title")}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <h1 className="mr-1 text-[15px] font-semibold tracking-tight text-ink">{t("scan.review")}</h1>
      <Input type="date" value={b.slipDate ?? ""} disabled={locked} title={t("daily.date")} aria-label={t("daily.date")}
        className={cn("h-8 w-[150px] num text-[13px]", needDate && "border-bad bg-bad-soft/40")}
        onChange={(e) => save.mutate({ rows, slipDate: e.target.value || null })} />
      <Select value={b.merchantId ?? ""} disabled={locked} className="h-8 w-auto min-w-[150px] max-w-[240px] text-[13px]" title={t("daily.mill")} aria-label={t("daily.mill")}
        onChange={(e) => save.mutate({ rows, merchantId: e.target.value || null })}>
        <option value="">{t("daily.ownFirmPick", { code: ownCode })}</option>
        {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
      </Select>
      <Select value={b.jinsId ?? ""} disabled={locked} title={t("daily.jins")} aria-label={t("daily.jins")}
        className={cn("h-8 w-auto min-w-[130px] max-w-[200px] text-[13px]", needJins && "border-bad bg-bad-soft/40")}
        onChange={(e) => save.mutate({ rows, jinsId: e.target.value || null })}>
        <option value="">—</option>
        {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
      </Select>
      {/* takes what room is left on the line and is cut short there, so the bar stays one line at 1366 px */}
      {saw.length > 0 ? (
        <span className="min-w-[60px] flex-1 basis-0 truncate text-[11px] text-faint" title={saw.join(" · ")}>
          {t("scan.headerRead")}: <span lang="hi">{saw.join(" · ")}</span>
        </span>
      ) : <div className="flex-1" />}
      {save.isPending && <Spinner />}
      {/* trying other models spends reads: the owner's tool, not the munshi's, and never on a sheet already added */}
      {!reading && !locked && can("settings.write") && b.status !== "uploaded" && <TryModelsButton scanId={scanId} pages={b.pages.length} />}
      {!reading && !locked && (
        <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad" />}
          onClick={async () => { if (await ask({ title: t("scan.confirmDelete"), danger: true, confirmLabel: t("confirm.yesDelete") })) remove.mutate(); }} title={t("common.delete")} aria-label={t("common.delete")} />
      )}
      {/* a sheet not read yet shows its picture by itself: nothing to hide, nothing to fill the screen with */}
      {b.status !== "uploaded" && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setShowScan((v) => !v)}
            icon={showScan ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}>
            <span className="hidden sm:inline">{showScan ? t("scan.hideScan") : t("scan.showScan")}</span>
          </Button>
          <Button size="sm" variant={full ? "secondary" : "ghost"} onClick={toggleFull} title={full ? t("scan.exitFullScreen") : t("scan.fullScreen")}
            aria-label={full ? t("scan.exitFullScreen") : t("scan.fullScreen")}
            icon={full ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}>
            <span className="hidden 2xl:inline">{full ? t("scan.exitFullScreen") : t("scan.fullScreen")}</span>
          </Button>
        </>
      )}
    </div>
  );

  const gridCard = (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        {reading ? (
          /* rows appear only once every page is read, in page order */
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-24 text-center">
            <Spinner className="h-7 w-7 text-brand" />
            <p className="text-sm font-semibold text-ink">
              {b.rereadPage ? t("scan.readingPageAgain", { n: b.rereadPage })
                : t("scan.readingPage", { n: Math.min(b.pagesDone + 1, b.pages.length), total: b.pages.length })}
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
          <EmptyState icon={<ScanLine className="h-7 w-7" />} title={t("common.noResults")} />
        ) : (
          <ScanGrid ref={grid} rows={rows} pageCount={b.pages.length} locked={locked || reading}
            canRate={can("rate.edit")} onPatch={patchRow}
            selectedId={selectedId} onSelect={select}
            onPageClick={showPage} pageChecks={checks} renderCheck={renderCheck} />
        )}
      </div>

      {summary && !locked && !reading && b.status === "review" && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-surface/95 px-3 py-2">
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
          {/* added only when nothing is red: amber lines are a look, never a stop */}
          <Button variant="primary" size="lg" loading={commit.isPending}
            disabled={summary.blocking > 0 || (summary.pagesBlocking ?? 0) > 0 || needDate || needJins || summary.included === 0}
            icon={<Check className="h-4 w-4" />}
            onClick={() => { setErr(null); void confirmCommit(); }}>
            {needDate ? t("scan.needDate")
              : needJins ? t("scan.needJins")
              : (summary.pagesBlocking ?? 0) > 0 ? t("scan.checkPagesFirst", { n: summary.pagesBlocking ?? 0 })
              : summary.blocking > 0 ? t("scan.fixRedLines", { n: summary.blocking })
              : t("scan.commit")}
          </Button>
        </div>
      )}
    </Card>
  );

  return (
    <div className="flex flex-col gap-2 lg:h-[calc(100vh-4.5rem)]">
      {toolbar}

      <div className="shrink-0 space-y-2 empty:hidden lg:max-h-[30vh] lg:overflow-y-auto">
        {err && <Alert tone="bad">{err}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {locked && <Alert tone="ok">{t("scan.status.committed")}</Alert>}
        {twice}
        {b.warningText && !reading && (
          <Alert tone="warn">
            <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{sayServer(b.warningText, lang)}</span></span>
          </Alert>
        )}
        {b.errorText && (
          <Alert tone="bad">
            <p className="font-semibold">{t("scan.failedTitle")}</p>
            <p className="mt-0.5 break-words leading-relaxed">{sayServer(b.errorText, lang)}</p>
            <div className="mt-2 flex flex-wrap gap-2 empty:hidden">
              {b.status === "failed" && can("scan.create") && (
                <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={run.isPending}
                  onClick={() => { setErr(null); run.mutate(undefined); }}>{t("scan.readAgain")}</Button>
              )}
              {/^Google rejected/.test(b.errorText) && can("business.read") && (
                <Button size="sm" variant="secondary" onClick={() => navigate("/settings?tab=scan")}>{t("nav.settings")}</Button>
              )}
            </div>
          </Alert>
        )}
      </div>

      {b.status === "uploaded" ? (
        <Card className="flex flex-col items-center gap-3 p-4">
          {can("scan.create") && (
            <Button variant="primary" size="lg" loading={run.isPending} icon={<ScanLine className="h-4 w-4" />}
              onClick={() => run.mutate(undefined)}>{t("scan.read")}</Button>
          )}
          {b.pages.map((p, i) => (
            <div key={`${p.name}-${i}`} className="w-full max-w-3xl">
              {p.mimeType === "application/pdf" ? (
                <iframe title={p.name} src={pageSrc(scanId, i, p.name)} className="h-[70vh] w-full rounded border border-line bg-white" />
              ) : (
                <PageImage src={pageSrc(scanId, i, p.name)} alt={t("scan.page", { n: i + 1 })} zoom={1} heic={/hei[cf]/i.test(p.mimeType)} line={null} />
              )}
            </div>
          ))}
        </Card>
      ) : showScan ? (
        <SplitPane storageKey="mandi.split.scanReview" title={t("scan.dragToResize")} initial={0.36} min={0.2} max={0.65}
          className="lg:min-h-0 lg:flex-1"
          left={<div className="h-[45vh] lg:h-full">
            <PageViewer scanId={scanId} pages={b.pages} focus={focus} />
          </div>}
          right={<div className="h-[75vh] lg:h-full">{gridCard}</div>} />
      ) : (
        <div className="h-[75vh] lg:h-auto lg:min-h-0 lg:flex-1">{gridCard}</div>
      )}
    </div>
  );
}
