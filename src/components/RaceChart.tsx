import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFormat } from "@/lib/format.tsx";
import { useI18n } from "@/lib/i18n.tsx";
import { dmy } from "@server/lib/parchaLabels.ts";

/* Received vs loaded, both cumulative, on a real time axis. The shaded gap
   between the lines is the stock in hand; where the loaded line climbs above
   the received line, more went out than came in — drawn in red, because that
   is the "loaded 1000, received 800" case the owner wants to catch. */

export interface RacePoint { date: string; in: number; out: number; cumIn: number; cumOut: number }

const IN = "hsl(var(--brand))";
const OUT = "hsl(212 80% 52%)";
const BAD = "hsl(var(--bad))";

const dayNo = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  // the real width before the first paint: the chart is drawn once at its size, not at 600 and then again
  useLayoutEffect(() => {
    if (ref.current) setW(Math.max(240, Math.floor(ref.current.getBoundingClientRect().width)));
  }, []);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export function RaceChart({ points, height = 200 }: { points: RacePoint[]; height?: number }) {
  const f = useFormat();
  const { t } = useI18n();
  const { ref, w } = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (!points.length) {
    return <div ref={ref} className="grid h-[120px] place-items-center text-[12px] text-faint">{t("dash.noMovement")}</div>;
  }

  const pad = { l: 56, r: 14, t: 10, b: 24 };
  const iw = w - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  // the axis starts the day before the first movement, where both totals stood
  const first = points[0];
  const start = { date: "", in: 0, out: 0, cumIn: first.cumIn - first.in, cumOut: first.cumOut - first.out };
  const d0 = dayNo(first.date) - 1;
  // …and runs a day past the last one, so every day's step has width
  const d1 = dayNo(points[points.length - 1].date) + 1;
  const span = Math.max(1, d1 - d0);
  // round tick values (1, 2, 2.5, 5 × 10ⁿ quintals) so the axis reads easily
  const rawMax = Math.max(1, ...points.map((p) => Math.max(p.cumIn, p.cumOut)), start.cumIn, start.cumOut) / 100_000;
  const rawMin = Math.min(0, ...points.map((p) => Math.min(p.cumIn, p.cumOut))) / 100_000;
  const stepQ = (() => {
    const rough = (rawMax - rawMin) / 4;
    const mag = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-9)));
    return [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= rough) ?? 10 * mag;
  })();
  const max = Math.ceil(rawMax / stepQ) * stepQ * 100_000;
  const min = Math.floor(rawMin / stepQ) * stepQ * 100_000;
  const xDay = (n: number) => pad.l + ((n - d0) / span) * iw;
  const x = (iso: string) => xDay(dayNo(iso));
  const xMid = (iso: string) => xDay(dayNo(iso) + 0.5);
  const y = (g: number) => pad.t + ih - ((g - min) / (max - min || 1)) * ih;

  // step lines: a running total holds until the next day it changes
  const stepVerts = (get: (p: RacePoint) => number): [number, number][] => {
    const v: [number, number][] = [[xDay(d0), y(get(start))]];
    points.forEach((p, i) => {
      v.push([x(p.date), y(get(i ? points[i - 1] : start))]);
      v.push([x(p.date), y(get(p))]);
    });
    v.push([xDay(d1), y(get(points[points.length - 1]))]);
    return v;
  };
  const inV = stepVerts((p) => p.cumIn);
  const outV = stepVerts((p) => p.cumOut);
  const toPath = (v: [number, number][]) => v.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join("");
  const inPath = toPath(inV);
  const outPath = toPath(outV);
  // the gap between the lines, day by day: green is stock in hand, red is loaded ahead of receipts
  const gaps = [
    { a: xDay(d0), b: points.length ? x(points[0].date) : xDay(d1), p: start },
    ...points.map((p, i) => ({ a: x(p.date), b: i + 1 < points.length ? x(points[i + 1].date) : xDay(d1), p })),
  ].filter((g) => g.p.cumIn !== g.p.cumOut && g.b > g.a);
  // each day's band is a rectangle; the days of one colour make one path
  const bandPath = (ahead: boolean) => gaps.filter((g) => (g.p.cumOut > g.p.cumIn) === ahead).map((g) => {
    const top = Math.min(y(g.p.cumIn), y(g.p.cumOut));
    const bottom = top + Math.abs(y(g.p.cumIn) - y(g.p.cumOut));
    return `M${g.a},${top}H${g.b}V${bottom}H${g.a}Z`;
  }).join("");
  const inHand = bandPath(false);
  const loadedAhead = bandPath(true);

  const ticksY: number[] = [];
  for (let g = min; g <= max + 1; g += stepQ * 100_000) ticksY.push(g);
  const tickDates = points.length <= 6 ? points.map((p) => p.date)
    : [0, 0.25, 0.5, 0.75, 1].map((k) => points[Math.round(k * (points.length - 1))].date).filter((d, i, a) => a.indexOf(d) === i);
  const ahead = points.filter((p) => p.cumOut > p.cumIn);
  const hp = hover != null ? points[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = 0, bd = Infinity;
    points.forEach((p, i) => { const dd = Math.abs(xMid(p.date) - mx); if (dd < bd) { bd = dd; best = i; } });
    setHover(best);
  };

  return (
    <div ref={ref} className="relative w-full">
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
        {ticksY.map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={y(g)} y2={y(g)} stroke="hsl(var(--line))" strokeDasharray={g === 0 ? undefined : "3 3"} />
            <text x={pad.l - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill="hsl(var(--faint))">{f.int(Math.round(g / 100_000))}</text>
          </g>
        ))}
        {tickDates.map((d) => (
          <text key={d} x={xMid(d)} y={height - 6} textAnchor="middle" fontSize="10" fill="hsl(var(--faint))">{dmy(d).slice(0, 5)}</text>
        ))}
        {/* the day-by-day bands, one shape per colour (a season is hundreds of days, on 25 cards) */}
        {inHand && <path d={inHand} fill={IN} opacity={0.1} />}
        {loadedAhead && <path d={loadedAhead} fill={BAD} opacity={0.14} />}
        <path d={inPath} fill="none" stroke={IN} strokeWidth={2} />
        <path d={outPath} fill="none" stroke={OUT} strokeWidth={2} />
        {ahead.map((p) => <circle key={p.date} cx={xMid(p.date)} cy={y(p.cumOut)} r={3.5} fill={BAD} />)}
        {hp && (
          <g>
            <line x1={xMid(hp.date)} x2={xMid(hp.date)} y1={pad.t} y2={pad.t + ih} stroke="hsl(var(--faint))" strokeDasharray="2 2" />
            <circle cx={xMid(hp.date)} cy={y(hp.cumIn)} r={3.5} fill={IN} />
            <circle cx={xMid(hp.date)} cy={y(hp.cumOut)} r={3.5} fill={OUT} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-pop"
          style={{ left: Math.min(Math.max(xMid(hp.date) + 10, 0), w - 190) }}>
          <p className="font-semibold text-ink">{dmy(hp.date)}</p>
          <p style={{ color: IN }}>{t("dash.received")}: <b className="num">{f.weight(hp.cumIn)}</b>{hp.in ? <span className="text-faint"> (+{f.weight(hp.in)})</span> : null}</p>
          <p style={{ color: OUT }}>{t("dash.loaded")}: <b className="num">{f.weight(hp.cumOut)}</b>{hp.out ? <span className="text-faint"> (+{f.weight(hp.out)})</span> : null}</p>
          <p className={hp.cumOut > hp.cumIn ? "font-semibold text-bad" : "text-muted"}>
            {hp.cumOut > hp.cumIn ? t("dash.aheadBy", { q: f.weight(hp.cumOut - hp.cumIn) }) : t("dash.inHand", { q: f.weight(hp.cumIn - hp.cumOut) })}
          </p>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-14 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: IN }} />{t("dash.received")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: OUT }} />{t("dash.loaded")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm" style={{ background: IN, opacity: 0.15 }} />{t("dash.stockBand")}</span>
        {ahead.length > 0 && <span className="inline-flex items-center gap-1.5 text-bad"><span className="h-2 w-2 rounded-full" style={{ background: BAD }} />{t("dash.aheadDot")}</span>}
        <span className="text-faint">{t("dash.qtlAxis")}</span>
      </div>
    </div>
  );
}
