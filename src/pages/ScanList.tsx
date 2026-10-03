import { useEffect, useRef, useState } from "react";
import { useFYRange } from "@/lib/fy.tsx";
import { LoadError } from "@/components/LoadError.tsx";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Upload, ScanLine, FileText, Check, AlertTriangle, Clock, Eye, Play, X, KeyRound,
} from "lucide-react";
import { prepareImage } from "@/lib/prepareImage.ts";
import { api, ApiError, type ScanListRow, type Merchant, type Jins, type GeminiSettings } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { GeminiUsageBar } from "@/components/GeminiUsage.tsx";
import { ScannerPanel } from "@/components/ScannerPanel.tsx";
import { SkeletonList } from "@/components/Skeletons.tsx";
import {
  Button, Card, CardHeader, Select, Input, Badge, Alert, EmptyState, Field, Spinner,
} from "@/components/ui/index.tsx";
import { useOwnCode } from "@/components/OwnFirm.tsx";
import { cn, fmtDateTime, relTime } from "@/lib/utils.ts";

const todayISO = () => new Date().toLocaleDateString("en-CA");

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "brand"> = {
  uploaded: "neutral", reading: "brand", review: "warn", committed: "ok", failed: "bad",
};

export function ScanListPage() {
  const { t, pick, lang } = useI18n();
  const ownCode = useOwnCode();
  const qc = useQueryClient();
  const { can } = useSession();
  const [, navigate] = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState("all");
  // the chosen financial year, until other dates are picked
  const { from, setFrom, to, setTo } = useFYRange();
  const [merchantId, setMerchantId] = useState("");
  // sheets already added come 40 at a time; sheets still waiting always show, all of them
  const [limit, setLimit] = useState(40);
  const [upDate, setUpDate] = useState(todayISO);
  const [upMill, setUpMill] = useState("");
  const [upJins, setUpJins] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const gemini = useQuery({ queryKey: ["settings", "gemini"], queryFn: () => api.get<GeminiSettings>("/settings/gemini") });
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants") });
  const jinsList = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins") });
  const counts = useQuery({ queryKey: ["scans", "counts"], queryFn: () => api.get<Record<string, number>>("/scans/counts") });

  // preselect 1509 so a scan never arrives without a commodity
  useEffect(() => {
    if (!upJins && jinsList.data?.length) {
      setUpJins(jinsList.data.find((j) => j.code === "1509")?.id ?? jinsList.data[0].id);
    }
  }, [jinsList.data]);

  const list = useQuery({
    // poll while any scan is still being read, so the list never looks stuck
    refetchInterval: (q) =>
      (q?.state?.data ?? []).some((r) => r.status === "reading") ? 3000 : false,
    queryKey: ["scans", { status, from, to, merchantId, limit }],
    queryFn: () => api.get<ScanListRow[]>(`/scans?${new URLSearchParams({
      ...(status !== "all" ? { status } : {}),
      ...(from ? { from } : {}), ...(to ? { to } : {}),
      ...(merchantId ? { merchantId } : {}),
      limit: String(limit),
    })}`),
    placeholderData: (prev) => prev,
  });

  const upload = useMutation({
    /**
     * Takes File[], never a live FileList. A FileList is emptied the moment the
     * input is cleared, and this runs asynchronously — the caller must copy it
     * first or the upload arrives with no files at all.
     */
    mutationFn: async (files: File[]) => {
      if (!files.length) throw new ApiError(400, t("scan.noFilesPicked"), "no_file");
      /* Pages by their names, as numbers count: page-2 before page-10, and a
         phone's IMG_…_101500 before IMG_…_101530. A file dialog or a drag can
         hand the pages over in the order they were clicked, which put page 2
         in page 1's place before anyone looked. The order step still follows. */
      const inOrder = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      const fd = new FormData();
      for (const f of await Promise.all(inOrder.map(prepareImage))) fd.append("files", f);
      if (upDate) fd.append("slipDate", upDate);
      if (upMill) fd.append("merchantId", upMill);
      if (upJins) fd.append("jinsId", upJins);
      const res = await fetch("/api/scans", { method: "POST", body: fd, credentials: "same-origin" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, json?.error ?? "Upload failed", json?.code);
      return json as { id: string; pages: number; samePictures?: number };
    },
    onSuccess: async (r) => {
      setErr(null);
      await qc.invalidateQueries({ queryKey: ["scans"] });
      /* One page reads straight away. Several pages stop at the order step
         first, so the order is seen before a read is spent. A picture already
         held on another sheet is not read either until the warning about it
         has been seen: it is only a warning, and "Read" is one tap. Awaited
         (the read itself runs on): the review screen then opens on "reading",
         never on a "Read the sheet" button for a read already started. */
      if (gemini.data?.configured && r.pages === 1 && !r.samePictures) {
        await api.post(`/scans/${r.id}/run`, {}).catch(() => { /* the review screen reports it */ });
      }
      navigate(`/scan/${r.id}`);
    },
    onError: (e) => setErr(e instanceof ApiError && e.code === "heic" ? t("scan.heicRefused")
      : e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const busy = upload.isPending;
  const filtersOn = status !== "all" || from || to || merchantId;

  return (
    <>
      <PageHeader title={t("scan.title")} sub={t("scan.sub")} />

      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      {gemini.data && !gemini.data.configured && (
        <Alert tone="warn" className="mb-3">
          <span className="inline-flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5" />
            {t("scan.noKey")}
            {can("business.read") && <Button size="sm" variant="secondary" onClick={() => navigate("/settings")}>{t("nav.settings")}</Button>}
          </span>
        </Alert>
      )}

      <GeminiUsageBar className="mb-3" />

      {can("scan.create") && (
        <Card className="mb-4">
          <CardHeader title={t("scan.upload")} sub={t("scan.uploadSubJpg")} />
          <div className="space-y-3 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t("daily.date")}>
                <Input type="date" value={upDate} className="h-8 num text-[13px]"
                  onChange={(e) => setUpDate(e.target.value)} />
              </Field>
              <Field label={t("daily.mill")}>
                <Select value={upMill} className="h-8 text-[13px]" onChange={(e) => setUpMill(e.target.value)}>
                  <option value="">{t("daily.ownFirmPick", { code: ownCode })}</option>
                  {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code} — {pick(m.name, m.nameHi)}</option>)}
                </Select>
              </Field>
              <Field label={t("daily.jins")}>
                <Select value={upJins} className="h-8 text-[13px]" onChange={(e) => setUpJins(e.target.value)}>
                  <option value="">—</option>
                  {jinsList.data?.map((j) => <option key={j.id} value={j.id}>{j.code} — {pick(j.name, j.nameHi)}</option>)}
                </Select>
              </Field>
            </div>

            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragging(false);
                const dropped = Array.from(e.dataTransfer.files);
                if (dropped.length) upload.mutate(dropped);
              }}
              onClick={() => fileRef.current?.click()}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
                dragging ? "border-brand bg-brand/5" : "border-line hover:border-faint hover:bg-raised/40",
                busy && "pointer-events-none opacity-60",
              )}
            >
              {busy ? <Spinner className="h-6 w-6" /> : <Upload className="h-6 w-6 text-faint" />}
              <p className="text-[13px] font-medium text-ink">
                {upload.isPending ? t("scan.uploadingNow") : t("scan.dropHere")}
              </p>
              <p className="text-[11px] text-faint">{t("scan.uploadSubJpg")}</p>
              <input ref={fileRef} type="file" multiple hidden
                accept="image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf"
                onChange={(e) => {
                  // copy first: clearing the input empties the FileList
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (picked.length) upload.mutate(picked);
                }} />
            </div>
            <ScannerPanel slipDate={upDate} merchantId={upMill} jinsId={upJins} />
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <Field label={t("scan.filterStatus")} className="min-w-[150px]">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 text-[13px]">
              <option value="all">{t("common.all")}</option>
              {(["uploaded", "review", "committed", "failed"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`scan.status.${s}` as never)}{counts.data?.[s] ? ` (${counts.data[s]})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("scan.filterFrom")} className="w-[150px]">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 num text-[13px]" />
          </Field>
          <Field label={t("scan.filterTo")} className="w-[150px]">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 num text-[13px]" />
          </Field>
          <Field label={t("scan.filterMill")} className="min-w-[160px]">
            <Select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} className="h-8 text-[13px]">
              <option value="">{t("common.all")}</option>
              {mills.data?.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
            </Select>
          </Field>
          {filtersOn && (
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />}
              onClick={() => { setStatus("all"); setFrom(""); setTo(""); setMerchantId(""); }}>
              {t("scan.clearFilters")}
            </Button>
          )}
        </div>

        {list.isLoading ? (
          <div className="p-4"><SkeletonList rows={5} /></div>
        ) : list.isError ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data?.length ? (
          <EmptyState icon={<ScanLine className="h-8 w-8" />}
            title={filtersOn ? t("common.noResults") : t("scan.empty")}
            sub={filtersOn ? undefined : t("scan.emptySub")} />
        ) : (
          <div className="divide-y divide-line/70">
            {list.data.map((s) => (
              <div key={s.id} role="link" tabIndex={0}
                onClick={() => navigate(`/scan/${s.id}`)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/scan/${s.id}`); } }}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raised/50 focus-visible:bg-raised/50">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-raised">
                  {s.status === "committed" ? <Check className="h-4 w-4 text-ok" />
                    : s.status === "failed" ? <AlertTriangle className="h-4 w-4 text-bad" />
                    : s.status === "reading" ? <Spinner />
                    : <FileText className="h-4 w-4 text-faint" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="num text-[13px] font-medium text-ink">{s.slipDate ? s.slipDate.split("-").reverse().join("-") : "—"}</span>
                    {s.merchantCode && <Badge tone="neutral" className="num">{s.merchantCode}</Badge>}
                    <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{t(`scan.status.${s.status}` as never)}</Badge>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {t("scan.pages", { n: s.pages })}
                    {s.rowCount > 0 && ` · ${t("daily.rowCount", { n: s.rowCount })}`}
                    {s.model && ` · ${s.model}`}
                    {s.errorText && ` · ${s.errorText.slice(0, 60)}`}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[11px] text-faint">
                  <span className="block">{relTime(s.createdAt, lang)}</span>
                </span>
                {s.status === "uploaded" && can("scan.create") && (
                  /* the sheet opens first: its picture, and a warning when the same paper is already held, are seen before a read is spent */
                  <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />}
                    onClick={(e) => { e.stopPropagation(); navigate(`/scan/${s.id}`); }}>
                    {t("scan.read")}
                  </Button>
                )}
                {s.status === "review" && (
                  <Button size="sm" variant="primary" icon={<Eye className="h-3.5 w-3.5" />}
                    onClick={(e) => { e.stopPropagation(); navigate(`/scan/${s.id}`); }}>
                    {t("scan.review")}
                  </Button>
                )}
              </div>
            ))}
            {/* more of the sheets already added; the waiting ones are all above already */}
            {list.data.filter((s) => s.status === "committed").length >= limit && (
              <div className="p-3 text-center">
                <Button size="sm" variant="secondary" loading={list.isFetching} onClick={() => setLimit((n) => n + 40)}>{t("scan.showMore")}</Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
