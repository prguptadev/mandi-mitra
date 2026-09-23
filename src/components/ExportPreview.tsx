import { cn } from "@/lib/utils.ts";
import type { ExportTable } from "@/lib/exportTable.ts";

/** The table exactly as it leaves: header, rows, and the total lines. */
export function ExportPreview({ table, max = 300, className }: { table: ExportTable; max?: number; className?: string }) {
  const cellClass = (i: number) => cn("whitespace-nowrap px-2 py-1", table.numeric[i] && "num text-right");
  return (
    <div className={cn("max-h-72 overflow-auto rounded-lg border border-line bg-surface", className)}>
      <table className="min-w-full text-[12px] text-ink">
        <thead className="sticky top-0 bg-raised text-[11px] uppercase tracking-wide text-muted">
          <tr>{table.header.map((h, i) => <th key={i} className={cn("px-2 py-1.5 text-left font-medium whitespace-nowrap", table.numeric[i] && "text-right")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.slice(0, max).map((r, ri) => (
            <tr key={ri} className="border-t border-line">{r.map((v, i) => <td key={i} className={cellClass(i)}>{String(v ?? "")}</td>)}</tr>
          ))}
        </tbody>
        <tfoot>
          {table.foot.map((r, ri) => (
            <tr key={ri} className="border-t-2 border-line font-semibold">{r.map((v, i) => <td key={i} className={cellClass(i)}>{String(v ?? "")}</td>)}</tr>
          ))}
        </tfoot>
      </table>
      {table.rows.length > max && <p className="px-2 py-1 text-[12px] text-faint">… {table.rows.length - max} more</p>}
    </div>
  );
}
