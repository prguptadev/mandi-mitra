import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import { api, type Merchant, type Jins } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFYRangeToToday } from "@/lib/fyToday.ts";
import { useSort } from "@/lib/useSort.ts";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonTable } from "@/components/Skeletons.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useOwnCode } from "@/components/OwnFirm.tsx";
import { SheetViewer, type ScannedSheet } from "@/components/SheetViewer.tsx";
import { Button, Card, Field, Input, Select, Table, Th, Td, Badge, EmptyState } from "@/components/ui/index.tsx";
import { dmy } from "@/lib/utils.ts";

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "brand"> = {
  uploaded: "neutral", reading: "brand", review: "warn", committed: "ok", failed: "bad",
};

/* Every sheet that was uploaded or scanned, by day and mill, to find the
   paper again. A row opens its pictures; nothing here changes a sheet. */
export function SheetsPage() {
  const { t } = useI18n();
  const ownCode = useOwnCode();
  // the chosen financial year, up to today, until other dates are picked
  const { from, setFrom, to, setTo, isDefault, reset } = useFYRangeToToday();
  const [mill, setMill] = useState("");
  const [jins, setJins] = useState("");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState<ScannedSheet | null>(null);

  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jinsList = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const qs = new URLSearchParams({
    ...(from ? { from } : {}), ...(to ? { to } : {}), ...(mill ? { merchantId: mill } : {}),
    ...(jins ? { jinsId: jins } : {}), ...(status !== "all" ? { status } : {}),
  });
  const list = useQuery({
    queryKey: ["scans", "sheets", qs.toString()],
    queryFn: () => api.get<{ rows: ScannedSheet[]; truncated: boolean }>(`/scans/sheets?${qs}`),
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.rows ?? [];
  const millOf = (s: ScannedSheet) => s.millCode ?? ownCode;
  const sort = useSort(rows, {
    date: (s) => s.day, mill: millOf, jins: (s) => s.jinsCode, pages: (s) => s.pages.length,
    lines: (s) => s.lines, added: (s) => s.slipsAdded, status: (s) => t(`scan.status.${s.status}` as never),
  }, { storageKey: "scan-sheets" });
  const filtersOn = Boolean(mill || jins || status !== "all" || !isDefault);

  return (
    <>
      <PageHeader title={t("scanSheets.title")} sub={t("scanSheets.sub")} />
      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <Field label={t("scan.filterFrom")} className="w-[150px]">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="num h-8 text-[13px]" />
          </Field>
          <Field label={t("scan.filterTo")} className="w-[150px]">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="num h-8 text-[13px]" />
          </Field>
          <Field label={t("scan.filterMill")} className="min-w-[140px]">
            <Select value={mill} onChange={(e) => setMill(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {ownCode && <option value="own">{ownCode}</option>}
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
            </Select>
          </Field>
          <Field label={t("daily.jins")} className="min-w-[140px]">
            <Select value={jins} onChange={(e) => setJins(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code}</option>)}
            </Select>
          </Field>
          <Field label={t("scan.filterStatus")} className="min-w-[150px]">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 text-[13px]">
              <option value="all">{t("common.all")}</option>
              {(["committed", "review", "uploaded", "failed"] as const).map((s) => <option key={s} value={s}>{t(`scan.status.${s}`)}</option>)}
            </Select>
          </Field>
          {filtersOn && (
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />}
              onClick={() => { setMill(""); setJins(""); setStatus("all"); reset(); }}>
              {t("scan.clearFilters")}
            </Button>
          )}
        </div>

        {list.isPending ? <SkeletonTable rows={6} /> : list.isError ? <LoadError error={list.error} onRetry={() => void list.refetch()} /> : !rows.length ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title={t("scanSheets.empty")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th {...sort.th("date")}>{t("daily.date")}</Th>
                <Th {...sort.th("mill")}>{t("load.mill")}</Th>
                <Th {...sort.th("jins")}>{t("daily.jins")}</Th>
                <Th numeric {...sort.th("pages")}>{t("scanSheets.pages")}</Th>
                <Th numeric {...sort.th("lines")}>{t("scanSheets.lines")}</Th>
                <Th numeric {...sort.th("added")}>{t("scanSheets.added")}</Th>
                <Th {...sort.th("status")}>{t("scan.filterStatus")}</Th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((s) => (
                <tr key={s.id} tabIndex={0} onClick={() => setOpen(s)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(s); } }}
                  className="cursor-pointer transition-colors hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:outline-none">
                  <Td className="num whitespace-nowrap">
                    {s.slipDate ? dmy(s.slipDate) : <span className="text-muted" title={t("scanSheets.uploadedOn")}>{dmy(s.day)} *</span>}
                  </Td>
                  <Td><Badge className="num">{millOf(s)}</Badge></Td>
                  <Td className="text-muted">{s.jinsCode ?? "—"}</Td>
                  <Td numeric>{s.pages.length}</Td>
                  <Td numeric className="text-muted">{s.lines || "—"}</Td>
                  <Td numeric>{s.slipsAdded || "—"}</Td>
                  <Td><Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{t(`scan.status.${s.status}` as never)}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {list.data?.truncated && <p className="border-t border-line px-3 py-2 text-[11px] text-faint">{t("scanSheets.truncated", { n: rows.length })}</p>}
      </Card>
      {open && <SheetViewer sheets={[open]} onClose={() => setOpen(null)} />}
    </>
  );
}
