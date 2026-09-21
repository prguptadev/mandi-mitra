import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils.ts";

/**
 * Two panes side by side with a handle to drag between them. The split is
 * remembered on this device only (localStorage), so each desk keeps its own —
 * a wide monitor and a laptop want different splits.
 *
 * Below the `lg` breakpoint the panes stack and the handle disappears.
 */
export function SplitPane({
  storageKey, left, right, initial = 0.38, min = 0.2, max = 0.7, className, title,
}: {
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
  /** Fraction of the width given to the left pane. */
  initial?: number;
  min?: number;
  max?: number;
  className?: string;
  title?: string;
}) {
  const [frac, setFrac] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    } catch { /* storage unavailable */ }
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const onMove = useCallback((clientX: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = Math.min(max, Math.max(min, (clientX - r.left) / r.width));
    setFrac(next);
  }, [min, max]);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onMove(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onMove]);

  // persist once the drag ends, not on every pixel
  useEffect(() => {
    if (dragging) return;
    try { localStorage.setItem(storageKey, String(frac)); } catch { /* ignore */ }
  }, [dragging, frac, storageKey]);

  return (
    <div ref={box} className={cn("flex flex-col gap-3 lg:flex-row lg:gap-0", className)}>
      <div className="min-w-0 lg:shrink-0" style={{ flexBasis: `${frac * 100}%` }}>{left}</div>

      <div
        role="separator" aria-orientation="vertical" tabIndex={0} title={title}
        aria-valuenow={Math.round(frac * 100)} aria-valuemin={min * 100} aria-valuemax={max * 100}
        onPointerDown={(e) => { e.preventDefault(); setDragging(true); }}
        onDoubleClick={() => setFrac(initial)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setFrac((f) => Math.max(min, f - 0.02));
          if (e.key === "ArrowRight") setFrac((f) => Math.min(max, f + 0.02));
        }}
        className={cn(
          "group relative hidden w-3 shrink-0 cursor-col-resize items-center justify-center lg:flex",
          "focus-visible:outline-none",
        )}
      >
        <div className={cn(
          "h-full w-px transition-colors",
          dragging ? "bg-brand" : "bg-line group-hover:bg-brand/60 group-focus-visible:bg-brand",
        )} />
        <div className={cn(
          "absolute top-1/2 grid h-10 w-3 -translate-y-1/2 place-items-center rounded-full border bg-surface shadow-sm transition-colors",
          dragging ? "border-brand text-brand" : "border-line text-faint group-hover:border-brand/60 group-hover:text-brand",
        )}>
          <GripVertical className="h-3 w-3" />
        </div>
      </div>

      <div className="min-w-0 flex-1">{right}</div>
    </div>
  );
}
