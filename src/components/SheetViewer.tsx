import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useI18n } from "@/lib/i18n.tsx";
import { useOwnCode } from "@/components/OwnFirm.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { Button, Spinner } from "@/components/ui/index.tsx";
import { cn, dmy } from "@/lib/utils.ts";

/** A scanned sheet as /scans/sheets and /scans/for-slip give it. No mill is the firm's own sheet. */
export interface ScannedSheet {
  id: string; status: string; slipDate: string | null; day: string;
  merchantId: string | null; millCode: string | null; jinsId: string | null; jinsCode: string | null;
  lines: number; slipsAdded: number; createdAt: number;
  pages: { index: number; name: string; mimeType: string }[];
}

/* The picture the review screen shows, by place and file name (see ScanReview). */
const pageSrc = (scanId: string, index: number, name: string) => `/api/scans/${scanId}/page/${index}?f=${encodeURIComponent(name)}`;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 6;
const PAD = 12;

/**
 * One scanned sheet (or the day's sheets one after another) on top of the
 * screen: its pages, zoom in / out / fit, previous / next page, close.
 * Keys: Esc closes, + and − zoom, 0 fits, ← and → change page.
 */
export function SheetViewer({ sheets, loading, error, onRetry, note, onClose }: {
  sheets: ScannedSheet[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void;
  /** One short line under the title, e.g. why these sheets are shown. */
  note?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ownCode = useOwnCode();
  const pages = useMemo(() => (sheets ?? []).flatMap((s, si) => s.pages.map((p) => ({ s, si, p }))), [sheets]);
  const [at, setAt] = useState(0);
  const cur = pages[Math.min(at, Math.max(0, pages.length - 1))];
  const pdf = cur?.p.mimeType === "application/pdf";
  // 1 = the whole page in view; more is bigger than that
  const [zoom, setZoomNow] = useState(1);
  const box = useRef<HTMLDivElement | null>(null);
  const keepCentre = useRef<{ x: number; y: number } | null>(null);
  const setZoom = (next: (z: number) => number) => {
    const el = box.current;
    if (el) keepCentre.current = { x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight };
    setZoomNow((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next(z) * 100) / 100)));
  };
  const zoomIn = () => setZoom((z) => z * 1.25);
  const zoomOut = () => setZoom((z) => z / 1.25);
  const fit = () => setZoom(() => 1);
  const go = (d: number) => setAt((i) => Math.max(0, Math.min(pages.length - 1, i + d)));

  // the spot in the middle stays in the middle while zooming
  useLayoutEffect(() => {
    const el = box.current;
    const c = keepCentre.current;
    keepCentre.current = null;
    if (!el || !c) return;
    el.scrollLeft = c.x * el.scrollWidth - el.clientWidth / 2;
    el.scrollTop = c.y * el.scrollHeight - el.clientHeight / 2;
  }, [zoom]);
  // a new page starts at its top
  useEffect(() => { box.current?.scrollTo({ top: 0, left: 0 }); }, [at]);

  // the picture area's size, for "the whole page in view"; it comes and goes with loading and PDF pages
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const boxRef = useCallback((el: HTMLDivElement | null) => { box.current = el; setBoxEl(el); }, []);
  useLayoutEffect(() => {
    if (!boxEl) return;
    const measure = () => setSize({ w: boxEl.clientWidth, h: boxEl.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(boxEl);
    return () => ro.disconnect();
  }, [boxEl]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      else if (e.key === "+" || e.key === "=") zoomIn();
      else if (e.key === "-" || e.key === "_") zoomOut();
      else if (e.key === "0") fit();
      else if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pages.length]);

  // a zoomed page is moved by dragging it, as on paper
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);

  const s = cur?.s;
  const title = s ? [dmy(s.slipDate ?? s.day), s.millCode ?? ownCode, s.jinsCode].filter(Boolean).join(" · ") : t("viewer.title");
  const pageNo = cur ? cur.p.index + 1 : 0;
  const line = s ? [
    t(`scan.status.${s.status}` as never),
    t("viewer.pageOf", { n: pageNo, of: s.pages.length }),
    ...((sheets?.length ?? 0) > 1 ? [t("viewer.sheetOf", { n: cur!.si + 1, of: sheets!.length })] : []),
    ...(note ? [note] : []),
  ].join(" · ") : null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex p-2 sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      {/* a sheet takes the screen; "none" or a failure is a small box */}
      <div ref={panel} tabIndex={-1} className={cn("relative z-10 flex w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop outline-none focus-visible:rounded-2xl focus-visible:outline-none",
        cur || loading ? "mx-auto h-full max-w-6xl" : "m-auto max-w-md")}>
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          <div className="mr-auto min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-ink">{title}</h2>
            {line && <p className="truncate text-[11px] text-muted">{line}</p>}
          </div>
          {cur && (
            <>
              <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("scan.zoomOut")} (−)`} disabled={pdf || zoom <= ZOOM_MIN} onClick={zoomOut}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="num w-11 text-center text-[11px] text-muted">{pdf ? "" : `${Math.round(zoom * 100)}%`}</span>
              <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("scan.zoomIn")} (+)`} disabled={pdf || zoom >= ZOOM_MAX} onClick={zoomIn}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("scan.fit")} (0)`} disabled={pdf} onClick={fit}>
                <Maximize2 className="h-4 w-4" />
              </Button>
              {pages.length > 1 && (
                <>
                  <span className="mx-1 h-5 w-px bg-line" />
                  <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("viewer.prev")} (←)`} disabled={at <= 0} onClick={() => go(-1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="num text-[11px] text-muted">{Math.min(at, pages.length - 1) + 1}/{pages.length}</span>
                  <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("viewer.next")} (→)`} disabled={at >= pages.length - 1} onClick={() => go(1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </>
              )}
              <span className="mx-1 h-5 w-px bg-line" />
            </>
          )}
          <Button size="icon" variant="ghost" className="h-8 w-8" title={`${t("common.close")} (Esc)`} aria-label={t("common.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {loading ? (
          <div className="grid flex-1 place-items-center"><Spinner className="h-6 w-6" /></div>
        ) : error ? (
          <div className="p-2"><LoadError error={error} onRetry={() => onRetry?.()} /></div>
        ) : !cur ? (
          <p className="px-4 py-6 text-center text-[14px] text-muted">{t("viewer.none")}</p>
        ) : pdf ? (
          <iframe key={cur.s.id + cur.p.name} title={title} src={pageSrc(cur.s.id, cur.p.index, cur.p.name)} className="min-h-0 flex-1 bg-white" />
        ) : (
          <div ref={boxRef} className={cn("min-h-0 flex-1 overflow-auto bg-raised/40", zoom > 1 && "cursor-grab active:cursor-grabbing")}
            onPointerDown={(e) => {
              const el = box.current;
              if (e.button !== 0 || !el) return;
              drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop };
              el.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const el = box.current;
              if (!d || !el) return;
              el.scrollLeft = d.l - (e.clientX - d.x);
              el.scrollTop = d.t - (e.clientY - d.y);
            }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}>
            <Picture key={cur.s.id + cur.p.name} src={pageSrc(cur.s.id, cur.p.index, cur.p.name)} alt={t("scan.page", { n: pageNo })}
              heic={/hei[cf]/i.test(cur.p.mimeType)} zoom={zoom} box={size} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** One page's picture, the whole of it in view at zoom 1 — or, when it cannot be shown here, why not. */
function Picture({ src, alt, heic, zoom, box }: { src: string; alt: string; heic: boolean; zoom: number; box: { w: number; h: number } }) {
  const { t } = useI18n();
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [missing, setMissing] = useState(false);
  if (missing) {
    return <p className="m-6 rounded border border-dashed border-line bg-surface p-4 text-center text-[13px] text-muted">{heic ? t("scan.imageHeic") : t("scan.imageElsewhere")}</p>;
  }
  // the room left after the padding and the picture's 1px border all round
  const room = { w: box.w - PAD * 2 - 4, h: box.h - PAD * 2 - 4 };
  const fitWidth = natural && room.w > 0 && room.h > 0 ? Math.floor(Math.min(room.w, (room.h * natural.w) / natural.h)) : 0;
  // until the picture's own size is known it is kept out of the way, so the area never jumps to its full size
  const style: CSSProperties = !natural ? { position: "absolute", visibility: "hidden", width: 1 }
    : fitWidth ? { width: Math.round(fitWidth * zoom), maxWidth: "none" } : { maxWidth: "100%" };
  return (
    // grows with the picture, so every part of a zoomed page can be scrolled to; centred while it is smaller
    <div className="relative flex min-h-full min-w-full w-max items-center justify-center" style={{ padding: PAD }}>
      {!natural && <Spinner className="h-6 w-6" />}
      <img src={src} alt={alt} draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
        onError={() => setMissing(true)}
        className="block select-none rounded border border-line bg-white shadow-sm" style={style} />
    </div>
  );
}
