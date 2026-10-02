import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

/*
 * A long table draws only the rows near the screen. The rows above and below
 * are blank space of the same height, so the page scrolls, sorts, searches and
 * adds up exactly as before; only rows far off screen are not drawn yet. A weak
 * computer then lays out some 80 rows instead of 2,000 each time the list
 * opens, changes or is scrolled.
 *
 *  - Lists shorter than `from` rows are drawn whole, exactly as before.
 *  - Printing draws every row.
 *  - Alternate-row colouring keeps its pattern: the first drawn row stays on
 *    the odd/even step it has in the whole list.
 *
 *   const w = useRowWindow(list);
 *   <tbody ref={w.bodyRef}>
 *     <RowSpacer at="top" height={w.topHeight} cols={8} />
 *     {w.rows.map((r, j) => <tr key={r.id}>… row w.start + j …</tr>)}
 *     <RowSpacer at="bottom" height={w.bottomHeight} cols={8} />
 *   </tbody>
 *
 * Each item must be exactly one <tr>, and the tbody must hold nothing else.
 */

const FIRST = 60;
const GUESS = 40;

/** The box that scrolls this table: a list's own box, else the page's main area. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.querySelector("main");
}

export function useRowWindow<T>(list: readonly T[], opts: { from?: number; overscan?: number } = {}) {
  const from = opts.from ?? 300;
  const overscan = opts.overscan ?? 20;
  const count = list.length;
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [printing, setPrinting] = useState(false);
  const on = count >= from && !printing;
  const [range, setRange] = useState({ start: 0, end: FIRST });

  /* Heights of the rows drawn so far (by place in this list); the average stands in for the rest. */
  const heights = useRef<number[]>([]);
  const avg = useRef(GUESS);
  const seen = useRef(list);
  if (seen.current !== list) { seen.current = list; heights.current = []; }
  const h = (i: number) => heights.current[i] ?? avg.current;
  const sum = (a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += h(i); return s; };

  const start = on ? Math.min(range.start, Math.max(0, count - 1)) : 0;
  const end = on ? Math.min(Math.max(range.end, start + 1), count) : count;

  // which rows are on screen now, from where the table sits in its scrolling box
  const update = useRef(() => {});
  update.current = () => {
    const body = bodyRef.current;
    if (!body || !on) return;
    const box = scrollerOf(body);
    const view = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = body.getBoundingClientRect().top;
    const fromY = Math.max(0, view.top - top);
    const toY = Math.max(0, view.bottom - top);
    let y = 0;
    let i = 0;
    while (i < count && y + h(i) <= fromY) { y += h(i); i++; }
    let j = i;
    while (j < count && y < toY) { y += h(j); j++; }
    let s = Math.max(0, i - overscan);
    let e = Math.min(count, Math.max(j + overscan, s + FIRST));
    // a row being typed in stays drawn however far the list scrolls from it: its box saves on leaving
    const a = document.activeElement;
    if (a && a !== body && body.contains(a)) {
      const drawn = (Array.from(body.children) as HTMLElement[]).filter((el) => el.dataset.spacer === undefined);
      const k = drawn.findIndex((el) => el.contains(a));
      if (k >= 0) { s = Math.min(s, start + k); e = Math.max(e, start + k + 1); }
    }
    // one spacer row above: an odd first row keeps every row on its own odd/even step
    if (s > 0 && s % 2 === 0) s -= 1;
    setRange((r) => (r.start === s && r.end === e ? r : { start: s, end: e }));
  };

  // measure what was drawn; the spacers take the measured sizes at once
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !on) return;
    let k = start;
    let total = 0;
    let n = 0;
    for (const el of Array.from(body.children) as HTMLElement[]) {
      if (el.dataset.spacer !== undefined) continue;
      const hh = el.getBoundingClientRect().height;
      if (hh > 0) { heights.current[k] = hh; total += hh; n++; }
      k++;
    }
    if (n) avg.current = total / n;
    const topEl = body.querySelector<HTMLElement>(":scope > [data-spacer=top]");
    const botEl = body.querySelector<HTMLElement>(":scope > [data-spacer=bottom]");
    if (topEl) topEl.style.height = `${sum(0, start)}px`;
    if (botEl) botEl.style.height = `${sum(end, count)}px`;
    // rows taller or shorter than guessed move what is on screen: look again before it is painted
    update.current();
  }, [on, list, start, end]);

  useEffect(() => {
    if (!on) return;
    const body = bodyRef.current;
    if (!body) return;
    const box = scrollerOf(body);
    let raf = 0;
    const onMove = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; update.current(); }); };
    (box ?? window).addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    update.current();
    return () => {
      (box ?? window).removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [on, list]);

  // a printout has every row on it
  const long = count >= from;
  useEffect(() => {
    if (!long) return;
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, [long]);

  const rows = useMemo(() => (start === 0 && end === count ? list : list.slice(start, end)), [list, start, end, count]);
  return {
    bodyRef, start, end, rows,
    topHeight: on && start > 0 ? sum(0, start) : 0,
    bottomHeight: on && end < count ? sum(end, count) : 0,
  };
}

/** Blank space standing in for rows not drawn; nothing at all when there are none. */
export function RowSpacer({ at, height, cols }: { at: "top" | "bottom"; height: number; cols: number }) {
  if (height <= 0) return null;
  return (
    <tr aria-hidden data-spacer={at} style={{ height, background: "transparent" }}>
      <td colSpan={cols} style={{ padding: 0, border: 0 }} />
    </tr>
  );
}
