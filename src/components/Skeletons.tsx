/* Loading wireframes. Each one mirrors the real layout it stands in for, so the
   page does not jump when data lands. */
import { cn } from "@/lib/utils.ts";

const Bar = ({ className }: { className?: string }) => <div className={cn("skeleton h-3.5", className)} />;

export function SkeletonTable({ rows = 8, cols }: { rows?: number; cols?: { w: string; numeric?: boolean }[] }) {
  const c = cols ?? [{ w: "w-40" }, { w: "w-28" }, { w: "w-20", numeric: true }, { w: "w-16", numeric: true }, { w: "w-14" }];
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-line bg-raised/60">
        {c.map((col, i) => (
          <div key={i} className={cn("flex-1", col.numeric && "flex justify-end")}>
            <Bar className={cn("h-2.5 opacity-70", col.w)} />
          </div>
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-3 px-3 py-3 border-b border-line/60"
          style={{ opacity: Math.max(0.35, 1 - r * 0.07) }}>
          {c.map((col, i) => (
            <div key={i} className={cn("flex-1", col.numeric && "flex justify-end")}>
              <Bar className={col.w} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonStats({ n = 4 }: { n?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-busy="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-xl border border-line bg-surface p-4">
          <Bar className="h-2.5 w-20 mb-3" />
          <Bar className="h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonForm({ fields = 6 }: { fields?: number }) {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Bar className="h-2.5 w-24" />
          <div className="skeleton h-9.5 w-full" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line/60" role="status" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 py-3" style={{ opacity: Math.max(0.35, 1 - i * 0.09) }}>
          <div className="skeleton h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Bar className="w-1/3" />
            <Bar className="h-2.5 w-2/3 opacity-70" />
          </div>
          <Bar className="h-2.5 w-16 mt-1" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonPage() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <div className="space-y-2">
        <Bar className="h-6 w-48" />
        <Bar className="h-3 w-72 opacity-70" />
      </div>
      <SkeletonStats />
      <div className="rounded-xl border border-line bg-surface overflow-hidden">
        <SkeletonTable />
      </div>
    </div>
  );
}

export function SkeletonShell() {
  return (
    <div className="flex h-full" role="status" aria-busy="true">
      <div className="hidden lg:flex w-60 shrink-0 flex-col gap-1 border-r border-line bg-surface p-3">
        <div className="skeleton h-10 w-full mb-4 rounded-lg" />
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="skeleton h-8 w-full rounded-lg" style={{ opacity: Math.max(0.3, 1 - i * 0.08) }} />
        ))}
      </div>
      <div className="flex-1 p-6"><SkeletonPage /></div>
    </div>
  );
}
