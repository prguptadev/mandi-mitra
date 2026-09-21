import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Printer, ScanLine, Play, Plus, RefreshCw } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Alert, Badge, Button, Field, Select, Spinner } from "@/components/ui/index.tsx";

/* Scan straight from the scanner connected to this computer (the Windows
   app). One press = one page: the first page starts a sheet, the next ones
   add to it, then "Read now". Hidden where no scanner can be reached. */

const LS = "mandi.scanner";
const saved = (): { deviceId?: string; dpi?: number; color?: boolean } => {
  try { return JSON.parse(localStorage.getItem(LS) ?? "{}"); } catch { return {}; }
};

export function ScannerPanel({ slipDate, merchantId, jinsId }: { slipDate: string; merchantId: string; jinsId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const status = useQuery({ queryKey: ["scanner"], queryFn: () => api.get<{ available: boolean }>("/scanner"), staleTime: 300_000 });
  const devices = useQuery({
    queryKey: ["scanner", "devices"], enabled: Boolean(status.data?.available), staleTime: 60_000,
    queryFn: () => api.get<{ available: boolean; devices: { id: string; name: string }[] }>("/scanner/devices"),
  });
  const [opts, setOpts] = useState(() => ({ deviceId: saved().deviceId ?? "", dpi: saved().dpi ?? 300, color: saved().color ?? true }));
  const [sheet, setSheet] = useState<{ id: string; pages: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const keep = (next: typeof opts) => { setOpts(next); try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* ignore */ } };

  const scan = useMutation({
    mutationFn: () => api.post<{ id: string; pages: number }>("/scanner/scan", {
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}), dpi: opts.dpi, color: opts.color,
      ...(sheet ? { scanId: sheet.id } : { slipDate: slipDate || null, merchantId: merchantId || null, jinsId: jinsId || null }),
    }),
    onSuccess: async (r) => { setErr(null); setSheet(r); await qc.invalidateQueries({ queryKey: ["scans"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/scans/${id}/run`, {}),
    onSuccess: (_r, id) => navigate(`/scan/${id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  if (!status.data?.available) return null;
  const list = devices.data?.devices ?? [];

  return (
    <div className="space-y-3 rounded-xl border border-line bg-raised/30 p-3">
      <div className="flex items-center gap-2">
        <Printer className="h-4 w-4 text-brand" />
        <p className="text-[13px] font-semibold text-ink">{t("scanner.title")}</p>
        {devices.isFetching && <Spinner className="h-3.5 w-3.5" />}
        {/* plugged in, or joined the Wi-Fi, after the page opened */}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={devices.isFetching} icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => void devices.refetch()}>{t("scanner.lookAgain")}</Button>
      </div>
      {err && <Alert tone="bad">{err}</Alert>}
      {devices.isError && <Alert tone="bad">{devices.error instanceof ApiError ? devices.error.message : t("common.somethingWrong")}</Alert>}
      {devices.data && !list.length && !devices.isFetching && <Alert tone="warn">{t("scanner.none")}</Alert>}
      {list.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("scanner.device")}>
            <Select value={opts.deviceId} className="h-8 text-[13px]" onChange={(e) => keep({ ...opts, deviceId: e.target.value })}>
              {list.length > 1 && <option value="">{t("scanner.first")}</option>}
              {list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label={t("scanner.quality")}>
            <Select value={String(opts.dpi)} className="h-8 text-[13px]" onChange={(e) => keep({ ...opts, dpi: Number(e.target.value) })}>
              <option value="200">{t("scanner.dpi", { n: 200 })}</option>
              <option value="300">{t("scanner.dpiBest", { n: 300 })}</option>
              <option value="400">{t("scanner.dpi", { n: 400 })}</option>
            </Select>
          </Field>
          <Field label={t("scanner.colour")}>
            <Select value={opts.color ? "c" : "g"} className="h-8 text-[13px]" onChange={(e) => keep({ ...opts, color: e.target.value === "c" })}>
              <option value="c">{t("scanner.colourYes")}</option>
              <option value="g">{t("scanner.grey")}</option>
            </Select>
          </Field>
        </div>
      )}
      {list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={sheet ? "secondary" : "primary"} loading={scan.isPending} icon={sheet ? <Plus className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />}
            onClick={() => { setErr(null); scan.mutate(); }}>
            {scan.isPending ? t("scanner.scanning") : sheet ? t("scanner.next", { n: sheet.pages + 1 }) : t("scanner.scan")}
          </Button>
          {sheet && (
            <>
              <Badge tone="brand">{t("scanner.pages", { n: sheet.pages })}</Badge>
              <Button variant="primary" loading={read.isPending} disabled={scan.isPending} icon={<Play className="h-4 w-4" />}
                onClick={() => read.mutate(sheet.id)}>{t("scanner.readNow")}</Button>
              <Button variant="ghost" disabled={scan.isPending} onClick={() => navigate(`/scan/${sheet.id}`)}>{t("scanner.open")}</Button>
              <Button variant="ghost" disabled={scan.isPending} onClick={() => setSheet(null)}>{t("scanner.newSheet")}</Button>
            </>
          )}
        </div>
      )}
      {sheet && (
        <img src={`/api/scans/${sheet.id}/page/${sheet.pages - 1}`} alt="" className="max-h-56 rounded-lg border border-line bg-white object-contain" />
      )}
      <p className="text-[11px] leading-snug text-faint">{t("scanner.help")}</p>
    </div>
  );
}
