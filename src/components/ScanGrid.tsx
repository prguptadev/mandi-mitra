import { forwardRef, Fragment, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { FileText, Trash2, RotateCcw, Sparkles, Check, ArrowDown, ListChecks, List, AlertTriangle, AlertCircle, FileQuestion } from "lucide-react";
import type { PageCheck, ScanRow } from "@/lib/api.ts";
import { toHinglish } from "@server/lib/translit.ts";
import { rstWeight, kantaGrams } from "@server/lib/slipChecks.ts";
import { STRINGS } from "@/lib/strings.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat, GRAMS_PER_QTL } from "@/lib/format.tsx";
import { NumberInput } from "@/components/NumberInput.tsx";
import { SupplierPicker } from "@/components/SupplierPicker.tsx";
import { Button, Badge } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

export type Field = "rst" | "name" | "gross" | "katauti" | "rate" | "struck";

/** red = must fix before approving; amber = worth a look; null = fine. `key` is what the ✓ confirms. */
type Flag = { level: "bad" | "doubt"; why: string; confirmable?: boolean; key?: Field } | null;

const LOW = 0.75;
type T = (k: never, v?: Record<string, string | number>) => string;

/** A server issue in words: its own string when there is one, else the server's sentence. */
function issueText(t: T, code: string, message: string, params?: Record<string, string | number>) {
  return `issue.${code}` in STRINGS.en ? t(`issue.${code}` as never, params) : message;
}

/**
 * Why a cell deserves attention. Amber is worth a look. Red blocks approval:
 * a value that is plainly wrong must be fixed; a value that only looks wrong
 * (the sheet's net disagrees, a huge weight, an unusual rate) can be accepted
 * with the ✓ beside it. Typing a new value is not accepting it: the new value
 * is checked again like the one that was read.
 */
function flagFor(r: ScanRow, f: Field, t: T): Flag {
  const done = (r.confirmed ?? []).includes(f);
  const has = (code: string) => r.issues.some((i) => i.code === code);
  const issue = (code: string) => r.issues.find((i) => i.code === code);
  const conf = r.ocr.confidence ?? 1;

  if (f === "rst") {
    const missing = issue("rst_missing");
    if (missing) return missing.level === "error" ? { level: "bad", why: t("scan.why.rstMissing" as never), confirmable: true, key: "rst" } : null;
    if (done) return null;
    // the same slip number again is only ever a warning: a look, never a stop
    if (has("rst_exists")) return { level: "doubt", why: t("scan.why.rstSeen" as never, { rst: r.rstNo }), confirmable: true, key: "rst" };
    if (has("rst_dupe")) return { level: "doubt", why: t("scan.why.rstTwice" as never, { rst: r.rstNo }), confirmable: true, key: "rst" };
    const other = r.issues.find((i) => i.code.startsWith("rst_"));
    if (other) return { level: other.level === "error" ? "bad" : "doubt", why: issueText(t, other.code, other.message, other.params), confirmable: true, key: "rst" };
    if (conf < LOW) return { level: "doubt", why: t("scan.why.unsure" as never), confirmable: true, key: "rst" };
  }
  if (f === "name") {
    // struck out on the paper, but put back in: only a ✓ says it really belongs (asked first, whatever the name)
    if (has("struck_included")) return { level: "bad", why: t("issue.struck_included" as never), confirmable: true, key: "struck" };
    if (!r.chosen && !r.match) return r.adatiRawText.trim()
      ? (done ? null : { level: "doubt", why: t("scan.why.newSupplier" as never), confirmable: true, key: "name" })
      : { level: "bad", why: t("scan.fix.pickName" as never) };
    // this page may have slid (checked for the whole page, in the note above the table)
    const slid = r.issues.find((i) => i.code === "page_slid");
    if (slid) return { level: "bad", why: t("issue.page_slid" as never, slid.params as Record<string, string | number>) };
    const mark = r.issues.find((i) => ["sr_gap", "sr_repeat", "sr_back", "sr_top", "name_only", "figures_only"].includes(i.code));
    if (mark) return { level: "doubt", why: t(`issue.${mark.code}` as never, mark.params as Record<string, string | number>) };
    if (!done && !r.chosen && r.match?.via === "fuzzy")
      return { level: "doubt", why: t("issue.name_fuzzy" as never, { name: r.adatiRawText }), confirmable: true, key: "name" };
    const close = r.issues.find((i) => i.code === "name_close");
    if (!done && close) return { level: "doubt", why: t("issue.name_close" as never, close.params as Record<string, string | number>), confirmable: true, key: "name" };
  }
  if (f === "gross") {
    if (r.grossGrams === null) {
      const read = r.ocr.unreadable?.grossQtl;
      return { level: "bad", why: read ? t("scan.why.grossUnread" as never, { read }) : t("scan.fix.grossMissing" as never) };
    }
    if (has("net_nonpositive")) return { level: "bad", why: t("scan.fix.netNonPositive" as never) };
    // loose packets ("2+45"): the RST box against the net written beside it, in kg (or nothing read there)
    const loose = issue("loose_net") ?? issue("loose_weight") ?? issue("loose_unchecked");
    if (!done && loose) return { level: loose.level === "error" ? "bad" : "doubt", why: issueText(t, loose.code, loose.message, loose.params), confirmable: true, key: "gross" };
    if (!done && r.netAgrees === false)
      return { level: "bad", why: t("scan.why.netDiffers" as never, { net: (r.ocr.netQtl ?? 0).toFixed(2) }), confirmable: true, key: "gross" };
    if (!done && has("gross_large")) return { level: "bad", why: t("issue.gross_large" as never), confirmable: true, key: "gross" };
    const unchecked = r.issues.find((i) => i.code === "net_unchecked");
    if (!done && unchecked) return { level: unchecked.level === "error" ? "bad" : "doubt", why: t("issue.net_unchecked" as never), confirmable: true, key: "gross" };
    const rounded = r.issues.find((i) => i.code === "gross_rounded");
    if (!done && rounded) return { level: "doubt", why: t("scan.why.grossRounded" as never, rounded.params as Record<string, string | number>), confirmable: true, key: "gross" };
    if (!done && has("gross_small")) return { level: "doubt", why: t("issue.gross_small" as never), confirmable: true, key: "gross" };
    if (!done && conf < LOW) return { level: "doubt", why: t("scan.why.unsure" as never), confirmable: true, key: "gross" };
  }
  if (f === "katauti") {
    if (!done && has("katauti_mismatch") && r.katautiOverride === null)
      return { level: "doubt", why: t("issue.katauti_mismatch" as never, { sheet: r.ocr.katauti ?? "", calculated: r.derivedKatautiUnits ?? "" }), confirmable: true, key: "katauti" };
  }
  if (f === "rate") {
    const missing = issue("rate_missing");
    // a rate written but not read as a number is typed: it cannot be put off with a ✓
    const read = r.ocr.unreadable?.rate;
    if (missing && read) return { level: "bad", why: t("scan.why.rateUnread" as never, { read }) };
    if (missing && !done) {
      return { level: missing.level === "error" ? "bad" : "doubt", why: t("scan.why.rateMissing" as never), confirmable: true, key: "rate" };
    }
    if (has("rate_negative")) return { level: "bad", why: t("issue.rate_negative" as never) };
    if (!done && has("rate_range")) {
      const p = r.issues.find((i) => i.code === "rate_range")?.params;
      const low = p && (r.ratePaisePerQtl ?? 0) < Number(p.floor) * 100;
      return { level: "bad", why: p ? t((low ? "scan.why.rateLow" : "scan.why.rateHigh") as never, { floor: p.floor, ceil: p.ceil }) : t("issue.rate_range" as never), confirmable: true, key: "rate" };
    }
    // unlike the day's other rates: a 1 read as a 7 looks like this
    const day = issue("rate_day");
    if (!done && day) {
      return { level: "doubt", why: t((day.params?.low ? "scan.why.rateDayLow" : "scan.why.rateDayHigh") as never, { median: day.params?.median ?? "" }), confirmable: true, key: "rate" };
    }
    if (!done && conf < LOW) return { level: "doubt", why: t("scan.why.unsure" as never), confirmable: true, key: "rate" };
  }
  return null;
}

const FIELDS: Field[] = ["rst", "name", "gross", "katauti", "rate"];
const LABEL: Record<Field, string> = { rst: "scan.slipCol", name: "daily.supplier", gross: "daily.gross", katauti: "daily.katautiWt", rate: "daily.rate", struck: "scan.struck" };

/**
 * Each line is one of three: green (nothing to do), amber (one thing to look
 * at, said in words) or red (cannot be added until it is fixed). The words
 * are the same ones the boxes carry; a red line with no box to point at
 * (the server holds it back) says why in the server's words.
 */
export type LineState = { tone: "ok" | "look" | "fix"; flags: { field: Field; flag: NonNullable<Flag> }[]; extra: string[] };
export function lineState(r: ScanRow, t: T): LineState {
  if (r.excluded) return { tone: "ok", flags: [], extra: [] };
  const flags = FIELDS.map((field) => ({ field, flag: flagFor(r, field, t) })).filter((x): x is { field: Field; flag: NonNullable<Flag> } => x.flag !== null);
  const red = flags.some((x) => x.flag.level === "bad");
  const extra = r.blocking && !red
    ? r.issues.filter((i) => i.level === "error").map((i) => issueText(t, i.code, i.message, i.params))
    : [];
  return { tone: red || r.blocking ? "fix" : flags.length ? "look" : "ok", flags, extra };
}

const CELL = "h-7 w-full rounded border bg-surface px-1.5 text-[12px] num text-right focus:border-brand disabled:opacity-60";

/* Border colour carries the signal: orange means "worth a look", and goes the
   moment the operator edits the cell; red means "cannot approve until fixed". */
function cellClass(flag: Flag) {
  if (!flag) return "border-line";
  return flag.level === "bad" ? "border-bad border-2 bg-bad-soft/30" : "border-warn border-2";
}

/** One click: "I have checked this value, it is right as read." */
function Accept({ flag, onAccept, label }: { flag: Flag; onAccept: () => void; label: string }) {
  if (!flag || !flag.confirmable) return null;
  return (
    <button type="button" onClick={onAccept} title={label} aria-label={label} tabIndex={-1}
      className="absolute -right-1 -top-1.5 grid h-4 w-4 place-items-center rounded-full border border-line bg-surface text-ok shadow-sm hover:bg-ok hover:text-white">
      <Check className="h-2.5 w-2.5" strokeWidth={3} />
    </button>
  );
}

/* Weight and rate boxes take digits, Devanagari digits, one decimal point
   and thousands commas — nothing else, typed or pasted. A refused key or
   paste leaves the box as it was and says why, instead of quietly keeping
   the digits of "34S0" as 340. */
const NUMERIC = /^[\d०-९.,\s]*$/;
const points = (s: string) => (s.match(/\./g) ?? []).length;

export interface ScanGridHandle {
  /** Moves to the next line to check after the one in hand (or the first), and puts the cursor in it. */
  next: () => void;
}

export const ScanGrid = forwardRef<ScanGridHandle, {
  rows: ScanRow[];
  pageCount: number;
  locked: boolean;
  canRate: boolean;
  /** `confirm` names the field(s) the operator has now dealt with. */
  onPatch: (id: string, patch: Partial<ScanRow>, confirm?: Field | Field[], now?: boolean) => void;
  onPageClick?: (page: number) => void;
  /** The line in hand: the picture beside the grid follows it. */
  selectedId?: string | null;
  onSelect?: (row: ScanRow) => void;
  /** Questions about whole pages; each is shown at the head of its page, where it is answered. */
  pageChecks?: PageCheck[];
  renderCheck?: (pc: PageCheck) => ReactNode;
}>(function ScanGrid({ rows, pageCount, locked, canRate, onPatch, onPageClick, selectedId, onSelect, pageChecks = [], renderCheck }, ref) {
  const { t } = useI18n();
  const f = useFormat();
  const [editingName, setEditingName] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const refusedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // a page question stays inside the visible width when the table is wider than its pane
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tt = t as unknown as T;
  const multi = pageCount > 1;

  // a line's state is kept with the line itself: one typed box works out that line again, not all
  const stateCache = useMemo(() => new WeakMap<ScanRow, LineState>(), [tt]);
  const states = useMemo(() => new Map(rows.map((r) => {
    let st = stateCache.get(r);
    if (!st) { st = lineState(r, tt); stateCache.set(r, st); }
    return [r.id, st];
  })), [rows, stateCache]);
  const toCheck = rows.filter((r) => states.get(r.id)!.tone !== "ok");
  const mustFix = toCheck.filter((r) => states.get(r.id)!.tone === "fix").length;
  const openChecks = locked ? [] : pageChecks.filter((pc) => !pc.confirmed);
  // the lines to look at first; every line once there is nothing left to look at
  const [only, setOnly] = useState(true);
  // a sheet already added shows every line it was added with
  const showOnly = !locked && only && toCheck.length + openChecks.length > 0;
  /* A line fixed while "only lines to check" is on stays in view until the
     next one is taken up, so the cursor is never pulled out from under it. */
  const [kept, setKept] = useState<string | null>(null);
  // a line left out as crossed out stays in view while its page asks whether it really is
  const struckAsked = (r: ScanRow) => r.excluded && r.ocr.struckThrough === true
    && openChecks.some((pc) => pc.code === "page_struck" && pc.page === (r.page ?? 1));
  const visible = showOnly ? rows.filter((r) => states.get(r.id)!.tone !== "ok" || r.id === kept || r.id === selectedId || struckAsked(r)) : rows;
  const pages = [...new Set([...rows.map((r) => r.page ?? 1), ...pageChecks.map((pc) => pc.page)])].sort((a, b) => a - b);

  const focusRow = (id: string) => {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    setKept(id);
    onSelect?.(r);
    // the first box that needs a look; else the weight
    const st = states.get(id);
    const want = st?.flags.find((x) => x.field !== "name")?.field ?? (st?.flags.some((x) => x.field === "name") ? "name" : "gross");
    requestAnimationFrame(() => {
      const el = box.current?.querySelector<HTMLElement>(`[data-row="${id}"][data-cell="${want}"]`)
        ?? box.current?.querySelector<HTMLElement>(`[data-row="${id}"][data-cell="gross"]`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  };
  const nextAfter = (fromId?: string | null) => {
    const list = rows.filter((r) => states.get(r.id)!.tone !== "ok" && r.id !== fromId);
    if (!list.length) {
      // no line left to look at: the first page question still open
      const q = box.current?.querySelector<HTMLElement>("[data-check-open] button:last-of-type");
      q?.scrollIntoView({ block: "nearest" });
      q?.focus();
      return;
    }
    const at = fromId ? rows.findIndex((r) => r.id === fromId) : -1;
    const after = list.find((r) => rows.findIndex((x) => x.id === r.id) > at) ?? list[0];
    focusRow(after.id);
  };
  useImperativeHandle(ref, () => ({ next: () => nextAfter(selectedId) }), [rows, states, selectedId]);

  /* The screen opens on the first line to check, in the paper's order, with
     the picture on it: the same order Enter then goes through, top to bottom. */
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || locked || !rows.length) return;
    opened.current = true;
    const first = rows.find((r) => states.get(r.id)!.tone !== "ok");
    if (first) onSelect?.(first);
  }, [rows.length, locked]);

  const refuse = useCallback((key: string) => {
    setRefused(key);
    if (refusedTimer.current) clearTimeout(refusedTimer.current);
    refusedTimer.current = setTimeout(() => setRefused(null), 1800);
  }, []);
  const guard = useCallback((key: string) => ({
    onBeforeInput: (e: React.FormEvent<HTMLInputElement>) => {
      const data = (e as unknown as { data?: string | null }).data;
      if (data == null) return;
      const el = e.currentTarget;
      const next = el.value.slice(0, el.selectionStart ?? el.value.length) + data + el.value.slice(el.selectionEnd ?? el.value.length);
      if (!NUMERIC.test(data) || points(next) > 1) { e.preventDefault(); refuse(key); }
    },
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      const data = e.clipboardData.getData("text");
      const el = e.currentTarget;
      const next = el.value.slice(0, el.selectionStart ?? el.value.length) + data + el.value.slice(el.selectionEnd ?? el.value.length);
      if (!NUMERIC.test(data) || points(next) > 1) { e.preventDefault(); refuse(key); }
    },
    // text dragged in from elsewhere is held to the same rule as typing
    onDrop: (e: React.DragEvent<HTMLInputElement>) => {
      const data = e.dataTransfer.getData("text");
      if (!NUMERIC.test(data) || points(e.currentTarget.value + data) > 1) { e.preventDefault(); refuse(key); }
    },
  }), [refuse]);

  /** Accepts every value on the line that may be accepted as read. */
  const acceptLine = (r: ScanRow) => {
    // a rate is accepted only by someone who may set rates, as its own ✓ is
    const keys = [...new Set((states.get(r.id)?.flags ?? []).filter((x) => x.flag.confirmable && (x.field !== "rate" || canRate)).map((x) => x.flag.key ?? x.field))];
    if (keys.length) onPatch(r.id, {}, keys);
  };

  /* Enter takes the next line to check; Ctrl+Enter says "this whole line is
     right as read" and takes the next one; arrows move up and down a column. */
  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const id = el.dataset.row;
    const cell = el.dataset.cell;
    if (!id || !cell || cell === "name") return;
    if (e.key === "Enter") {
      e.preventDefault();
      const r = rows.find((x) => x.id === id);
      if (r && (e.ctrlKey || e.metaKey)) acceptLine(r);
      el.blur();
      nextAfter(id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const i = visible.findIndex((x) => x.id === id);
      const to = visible[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      onSelect?.(to);
      box.current?.querySelector<HTMLElement>(`[data-row="${to.id}"][data-cell="${cell}"]`)?.focus();
    }
  };

  /* The lines call back through these, always reaching what this render holds. */
  const latestCb = useRef({ onPatch, onSelect, acceptLine });
  latestCb.current = { onPatch, onSelect, acceptLine };
  const lineCtx = useMemo<LineCtx>(() => ({
    t, tt, f, guard, editName: setEditingName,
    patch: (id, patch, confirm, now) => latestCb.current.onPatch(id, patch, confirm, now),
    select: (r) => latestCb.current.onSelect?.(r),
    acceptLine: (r) => latestCb.current.acceptLine(r),
  }), [t, tt, f, guard]);

  const shown = (r: ScanRow, i: number) => {
    // the printed SR NO; else the line's place on its own page, never its place in the whole sheet
    if (r.ocr.srNo != null) return r.ocr.srNo;
    const page = r.page ?? 1;
    return rows.slice(0, i + 1).filter((x) => (x.page ?? 1) === page).length;
  };

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col">
      {!locked && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-2.5 py-1.5 text-[12px]">
          {toCheck.length + openChecks.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-ok"><Check className="h-3.5 w-3.5" /> {t("scan.allFine")}</span>
          ) : (
            <>
              {toCheck.length > 0 && (
                <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                  <AlertTriangle className="h-3.5 w-3.5 text-warn" /> {t("scan.toCheck", { n: toCheck.length })}
                </span>
              )}
              {mustFix > 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-bad"><AlertCircle className="h-3.5 w-3.5" /> {t("scan.mustFix", { n: mustFix })}</span>
              )}
              {openChecks.length > 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-bad"><FileQuestion className="h-3.5 w-3.5" /> {t("scan.pageQuestions", { n: openChecks.length })}</span>
              )}
              <Button size="sm" variant="primary" className="h-7" icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={() => nextAfter(selectedId)}>
                {t("scan.nextToCheck")}
              </Button>
            </>
          )}
          <span className="flex-1" />
          {toCheck.length + openChecks.length > 0 && (
            <div className="inline-flex overflow-hidden rounded-md border border-line">
              <button type="button" onClick={() => setOnly(true)}
                className={cn("inline-flex items-center gap-1 px-2 py-1", showOnly ? "bg-brand/10 font-semibold text-brand" : "text-muted hover:bg-raised")}>
                <ListChecks className="h-3.5 w-3.5" /> {t("scan.showToCheck")}
              </button>
              <button type="button" onClick={() => setOnly(false)}
                className={cn("inline-flex items-center gap-1 border-l border-line px-2 py-1", !showOnly ? "bg-brand/10 font-semibold text-brand" : "text-muted hover:bg-raised")}>
                <List className="h-3.5 w-3.5" /> {t("scan.showAll", { n: rows.length })}
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto" onKeyDown={onKey}>
        {/* a floor on the width: a narrow pane scrolls sideways instead of
            squeezing "19.20" down to "19"; at 1366 px with the picture beside
            it (the default split), the whole line fits. How sure the reader
            was is in the line number's tooltip: an unsure value is already
            amber, in words, so it needs no column of its own. */}
        <table className="w-full min-w-[800px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-raised/80">
              {([
                [t("scan.srCol"), "w-10", false], [t("scan.slipCol"), "w-20", false], [t("daily.supplier"), "min-w-[180px]", false],
                [t("daily.gross"), "w-20", true], [t("daily.bags"), "w-14", true], [t("daily.katautiWt"), "w-14", true],
                // room for a whole rate as typed, "3500.00", beside its ✓
                [t("daily.net"), "w-20", true], [`${t("daily.rate")}${f.symbol ? " " + f.symbol : ""}`, "w-24", true],
                [`${t("daily.amount")}${f.symbol ? " " + f.symbol : ""}`, "w-24", true], ["", "w-8", false],
              ] as const).map(([label, w, num], k) => (
                <th key={k} className={cn(
                  "sticky top-0 z-20 border-b border-line bg-raised px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted",
                  num ? "text-right" : "text-left", w,
                )}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pages.map((page) => {
              const pageRows = rows.filter((x) => (x.page ?? 1) === page);
              const pageToCheck = pageRows.filter((x) => states.get(x.id)!.tone !== "ok").length;
              // in "lines to check", only the questions still open; in "all lines", the answered ones too
              const checks = locked ? [] : pageChecks.filter((pc) => pc.page === page && (!showOnly || !pc.confirmed));
              const lines = visible.filter((x) => (x.page ?? 1) === page);
              if (!lines.length && !checks.length) return null;
              return (
                <Fragment key={`p${page}`}>
                  {(multi || checks.length > 0) && (
                    <tr>
                      <td colSpan={10} className="border-b border-line bg-raised/70 px-2 py-1">
                        <button type="button" onClick={() => onPageClick?.(page)}
                          className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-brand">
                          <FileText className="h-3 w-3" />
                          {t("scan.page", { n: page })}
                          <span className="font-normal normal-case text-faint">
                            · {t("scan.rowsOnPage", { n: pageRows.length })}
                            {pageToCheck > 0 && !locked && <> · {t("scan.toCheck", { n: pageToCheck })}</>}
                          </span>
                        </button>
                      </td>
                    </tr>
                  )}
                  {/* whole-page questions, answered here, at the head of their page */}
                  {checks.map((pc) => (
                    <tr key={`${pc.page}-${pc.code}`} {...(pc.confirmed ? {} : { "data-check-open": "" })}>
                      <td colSpan={10} className={cn("border-b border-line/70 px-2 py-1.5 text-[12.5px] leading-snug",
                        pc.confirmed ? "bg-surface text-muted" : "bg-warn-soft text-warn")}>
                        <div className="sticky left-2" style={paneWidth ? { maxWidth: paneWidth - 24 } : undefined}>
                          {renderCheck?.(pc)}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {lines.map((r) => (
                    <GridLine key={r.id} r={r} no={shown(r, rows.indexOf(r))} st={states.get(r.id)!}
                      sel={selectedId === r.id} editing={editingName === r.id}
                      refused={refused?.startsWith(`${r.id}:`) ? refused : null}
                      locked={locked} canRate={canRate} lc={lineCtx} />
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );

});

/** What every line of the grid draws with: one object while the language and number style stay. */
interface LineCtx {
  t: ReturnType<typeof useI18n>["t"];
  tt: T;
  f: ReturnType<typeof useFormat>;
  patch: (id: string, patch: Partial<ScanRow>, confirm?: Field | Field[], now?: boolean) => void;
  select: (r: ScanRow) => void;
  acceptLine: (r: ScanRow) => void;
  editName: (id: string | null) => void;
  guard: (key: string) => {
    onBeforeInput: (e: React.FormEvent<HTMLInputElement>) => void;
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
    onDrop: (e: React.DragEvent<HTMLInputElement>) => void;
  };
}

/** One line of the sheet (and its notes). Drawn again only when that line, or whether it is
 *  the one in hand, changes: typing in one box does not draw the whole sheet again. */
const GridLine = memo(function GridLine({ r, no, st, sel, editing, refused, locked, canRate, lc }: {
  r: ScanRow; no: number; st: LineState; sel: boolean; editing: boolean; refused: string | null;
  locked: boolean; canRate: boolean; lc: LineCtx;
}) {
  const { t, tt, f } = lc;
  const dead = r.excluded || locked;
  const name = r.chosen ?? r.match;
  // a sheet already added is quiet: nothing on it is asked any more
  const fl = locked ? { rst: null, name: null, gross: null, katauti: null, rate: null } : {
    rst: flagFor(r, "rst", tt),
    name: flagFor(r, "name", tt), gross: flagFor(r, "gross", tt),
    katauti: flagFor(r, "katauti", tt), rate: flagFor(r, "rate", tt),
  };

  return (
    <Fragment key={r.id}>
      <tr data-line={r.id}
        onMouseDown={() => { if (!sel) lc.select(r); }}
        onFocusCapture={() => { if (!sel) lc.select(r); }}
        className={cn("transition-colors hover:bg-raised/30", r.excluded && "bg-raised/50 opacity-55", sel && "bg-brand/5")}>
        <td className={cn("relative num border-b border-line/70 py-1 pl-2.5 pr-1 text-[11px]",
          r.issues.some((x) => x.code.startsWith("sr_") || x.code === "name_only" || x.code === "figures_only") ? "font-bold text-bad" : "text-faint")}
          title={r.ocr.confidence == null ? t("scan.srNoHint") : `${t("scan.srNoHint")} · ${t("scan.confHint", { n: Math.round(r.ocr.confidence * 100) })}`}>
          {/* the line's colour: green nothing to do, amber a look, red a fix */}
          <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1",
            r.excluded ? "bg-line" : locked ? "bg-ok/70" : st.tone === "fix" ? "bg-bad" : st.tone === "look" ? "bg-warn" : "bg-ok/70")} />
          {no}
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <div className="relative">
            <input value={r.rstNo} disabled={dead} placeholder="RST" title={fl.rst?.why}
              data-row={r.id} data-cell="rst"
              onChange={(e) => {
                const rstNo = e.target.value.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d))).replace(/\s+/g, "");
                // as on the daily list: a weight from loose packets ("2+45") follows the RST, or goes (the kanta read comes back)
                lc.patch(r.id, { rstNo, grossGrams: rstWeight(r.rstNo, rstNo, r.grossGrams, kantaGrams(r.ocr.grossQtl)) });
              }}
              className={cn(CELL, "text-left", cellClass(fl.rst))} />
            {!dead && <Accept flag={fl.rst} label={t("scan.acceptValue")} onAccept={() => lc.patch(r.id, {}, "rst")} />}
          </div>
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <div className="relative">
            {name && !editing ? (
              /* click the name itself to change it — no separate clear button */
              <button type="button" disabled={dead} title={fl.name?.why ?? t("scan.clickToChange")}
                data-row={r.id} data-cell="name"
                onClick={() => lc.editName(r.id)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded border px-1.5 py-0.5 text-left transition-colors",
                  fl.name ? cellClass(fl.name) : "border-transparent hover:border-line hover:bg-surface",
                )}>
                <span className="min-w-0 flex-1">
                  <span lang="hi" className="block truncate text-[14px] leading-tight text-ink">{name.nameHi}</span>
                  <span className="block truncate text-[10px] leading-tight text-faint">
                    {name.nameHinglish}
                    {r.ocr.adatiName && r.ocr.adatiName !== name.nameHi && (
                      <span lang="hi"> · {t("scan.ocrSaid")}: {r.ocr.adatiName}</span>
                    )}
                    {r.ocr.village && <span lang="hi"> · {t("scan.village")}: {r.ocr.village}</span>}
                  </span>
                </span>
                {r.chosen
                  ? <Badge tone="brand" className="shrink-0"><Check className="h-2.5 w-2.5" /></Badge>
                  : r.match && <Badge tone={r.match.via === "fuzzy" ? "warn" : "ok"} className="shrink-0">
                      {t(`scan.matchedBy.${r.match.via}` as never)}
                    </Badge>}
              </button>
            ) : (
              <div className={cn("rounded", fl.name && !name && cellClass(fl.name))}>
                <SupplierPicker
                  value={r.adatiId}
                  selectedLabel={name ? { nameHi: name.nameHi, nameHinglish: name.nameHinglish } : null}
                  disabled={dead}
                  invalid={!name && !r.adatiRawText.trim()}
                  autoFocus={editing}
                  /* what the reader made of the handwriting is already in the box:
                     fix a letter and press Enter, no retyping, no dialog */
                  initialText={name?.nameHi ?? r.adatiRawText}
                  placeholder={r.adatiRawText ? `${r.adatiRawText} · ${toHinglish(r.adatiRawText)}${r.ocr.village ? ` (${r.ocr.village})` : ""}` : t("scan.pickName")}
                  onChange={(v) => { if (v) { lc.patch(r.id, { adatiId: v, nameCorrected: true }, "name"); lc.editName(null); } }}
                  onCommitText={(text) => { lc.patch(r.id, { typedName: text, nameCorrected: true }, "name", true); lc.editName(null); }}
                  onBlurEmpty={() => lc.editName(null)}
                />
              </div>
            )}
            {!dead && <Accept flag={fl.name} label={t("scan.acceptRow")} onAccept={() => lc.patch(r.id, {}, fl.name?.key ?? "name")} />}
          </div>
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <div className="relative">
            <NumberInput disabled={dead} title={refused === `${r.id}:gross` ? t("scan.numbersOnly") : fl.gross?.why} decimals={2}
              data-row={r.id} data-cell="gross" {...lc.guard(`${r.id}:gross`)}
              className={cn(CELL, cellClass(fl.gross), refused === `${r.id}:gross` && "ring-2 ring-bad")}
              value={r.grossGrams === null ? null : r.grossGrams / GRAMS_PER_QTL}
              onValueChange={(n) => lc.patch(r.id, { grossGrams: n === null ? null : Math.round(n * GRAMS_PER_QTL) })} />
            {!dead && <Accept flag={fl.gross} label={t("scan.acceptValue")} onAccept={() => lc.patch(r.id, {}, "gross")} />}
            {refused === `${r.id}:gross` && <p className="mt-0.5 text-right text-[10px] font-medium text-bad">{t("scan.numbersOnly")}</p>}
            {r.grossGrams === null && r.ocr.unreadable?.grossQtl && (
              <p className="mt-0.5 truncate text-right text-[10px] text-bad" title={r.ocr.unreadable.grossQtl}>“{r.ocr.unreadable.grossQtl}”</p>
            )}
            {!dead && fl.gross && r.grossSuggestGrams != null && (
              <button type="button" title={t("scan.useSuggest", { v: (r.grossSuggestGrams / GRAMS_PER_QTL).toFixed(2) })}
                className="mt-0.5 block w-full rounded bg-brand/10 px-1 text-right text-[10px] font-medium text-brand hover:bg-brand/20"
                onClick={() => lc.patch(r.id, { grossGrams: r.grossSuggestGrams! })}>
                → {(r.grossSuggestGrams / GRAMS_PER_QTL).toFixed(2)}
              </button>
            )}
          </div>
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <div className="relative">
            <NumberInput integer disabled={dead} title={fl.katauti?.why}
              data-row={r.id} data-cell="katauti" {...lc.guard(`${r.id}:katauti`)}
              className={cn(CELL, cellClass(fl.katauti), r.katautiOverride === null && !fl.katauti && "text-faint", refused === `${r.id}:katauti` && "ring-2 ring-bad")}
              placeholder={r.derivedKatautiUnits === null ? "" : String(r.derivedKatautiUnits)}
              value={r.katautiOverride}
              onValueChange={(n) => lc.patch(r.id, { katautiOverride: n })} />
            {!dead && <Accept flag={fl.katauti} label={t("scan.acceptValue")} onAccept={() => lc.patch(r.id, {}, "katauti")} />}
          </div>
        </td>

        <td className="num border-b border-line/70 px-2 py-1 text-right text-faint">
          {r.derivedNetGrams === null || r.grossGrams === null ? "—" : f.weight(r.grossGrams - r.derivedNetGrams)}
        </td>

        {/* net is always gross − katauti, so the parcha arithmetic holds;
            fix a wrong net at its source, the gross */}
        <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold">
          {r.derivedNetGrams === null ? "—" : f.weight(r.derivedNetGrams)}
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <div className="relative">
            <NumberInput disabled={dead || !canRate} title={refused === `${r.id}:rate` ? t("scan.numbersOnly") : fl.rate?.why} decimals={2}
              data-row={r.id} data-cell="rate" {...lc.guard(`${r.id}:rate`)}
              className={cn(CELL, cellClass(fl.rate), refused === `${r.id}:rate` && "ring-2 ring-bad")}
              value={r.ratePaisePerQtl === null ? null : r.ratePaisePerQtl / 100}
              onValueChange={(n) => lc.patch(r.id, { ratePaisePerQtl: n === null ? null : Math.round(n * 100) })} />
            {!dead && canRate && <Accept flag={fl.rate} label={t("scan.acceptValue")} onAccept={() => lc.patch(r.id, {}, "rate")} />}
            {refused === `${r.id}:rate` && <p className="mt-0.5 text-right text-[10px] font-medium text-bad">{t("scan.numbersOnly")}</p>}
            {!r.ratePaisePerQtl && r.ocr.unreadable?.rate && (
              <p className="mt-0.5 truncate text-right text-[10px] text-bad" title={r.ocr.unreadable.rate}>“{r.ocr.unreadable.rate}”</p>
            )}
          </div>
        </td>

        <td className="num border-b border-line/70 px-2 py-1 text-right font-semibold text-brand">
          {r.derivedAmountPaise === null ? "—" : f.amount(r.derivedAmountPaise)}
        </td>

        <td className="border-b border-line/70 px-1 py-1">
          <Button size="icon" variant="ghost" className="h-6 w-6" disabled={locked}
            title={r.excluded ? t("scan.include") : t("scan.exclude")}
            onClick={() => lc.patch(r.id, { excluded: !r.excluded })}>
            {r.excluded ? <RotateCcw className="h-3 w-3" /> : <Trash2 className="h-3 w-3 text-bad/70" />}
          </Button>
        </td>
      </tr>

      {/* what to look at on this line, in words, and one tap when it is all right as read */}
      {!locked && !r.excluded && st.tone !== "ok" && (
        <tr className={cn(sel && "bg-brand/5")}>
          <td className="relative border-b border-line/70">
            <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", st.tone === "fix" ? "bg-bad" : "bg-warn")} />
          </td>
          <td colSpan={9} className="border-b border-line/70 px-1 pb-1.5 pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] leading-snug">
              {st.flags.map(({ field, flag }) => (
                <span key={field} className={cn("inline-flex items-start gap-1", flag.level === "bad" ? "text-bad" : "text-warn")}>
                  {flag.level === "bad" ? <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
                  <span><span className="font-semibold">{t(LABEL[field] as never)}:</span> {flag.why}</span>
                </span>
              ))}
              {st.extra.map((x, k) => (
                <span key={`x${k}`} className="inline-flex items-start gap-1 text-bad"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />{x}</span>
              ))}
              {st.flags.some((x) => x.flag.confirmable && (x.field !== "rate" || canRate)) && (
                <button type="button" onClick={() => lc.acceptLine(r)} title={t("scan.acceptAllHint")}
                  className="inline-flex items-center gap-1 rounded border border-ok/50 bg-ok-soft px-1.5 py-0.5 text-[11px] font-medium text-ok hover:bg-ok hover:text-white">
                  <Check className="h-3 w-3" strokeWidth={3} /> {t("scan.acceptAll")}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}

      {/* the three closest, one tap each; only while nothing is chosen */}
      {!r.excluded && !r.chosen && !r.match && r.suggestions.length > 0 && (
        <tr>
          <td className="border-b border-line/70" />
          <td className="border-b border-line/70" />
          <td colSpan={8} className="border-b border-line/70 px-1 pb-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Sparkles className="h-2.5 w-2.5 shrink-0 text-faint" />
              {r.suggestions.slice(0, 3).map((sg) => (
                <button key={sg.adatiId} type="button" disabled={dead}
                  onClick={() => lc.patch(r.id, { adatiId: sg.adatiId, nameCorrected: true }, "name")}
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
});
