import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Printer, ScanLine, Play, Plus, RefreshCw, Stethoscope, Copy, Check } from "lucide-react";
import { api, ApiError, apiStatus } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Field, Select, Spinner } from "@/components/ui/index.tsx";

/* Scan straight from the scanner connected to this computer (the Windows
   app). One press = one page: the first page starts a sheet, the next ones
   add to it, then "Read now". Hidden where no scanner can be reached. */

const LS = "mandi.scanner";
const saved = (): { deviceId?: string; dpi?: number; color?: boolean } => {
  try { return JSON.parse(localStorage.getItem(LS) ?? "{}"); } catch { return {}; }
};

type Sheet = { id: string; pages: number };
/* The sheet being built. A scan runs on the server and outlives this panel, so
   the sheet is kept per business and user (in the query cache, and in
   sessionStorage for a reload), not in the panel: coming back mid-scan shows
   the same sheet, and a page that lands while away still joins it. */
const sheetSS = (who: string) => `mandi.scanner.sheet.${who}`;
const storedSheet = (who: string): Sheet | null => {
  try { return JSON.parse(sessionStorage.getItem(sheetSS(who)) ?? "null"); } catch { return null; }
};

export function ScannerPanel({ slipDate, merchantId, jinsId }: { slipDate: string; merchantId: string; jinsId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { me } = useSession();
  const [, navigate] = useLocation();
  /* busy: a scan running on the server, which outlives this screen — coming
     back mid-scan asks again, and asks every 1.5 s until the page is in. */
  const status = useQuery({
    queryKey: ["scanner"], queryFn: () => api.get<{ available: boolean; busy: { since: number; sheetId: string | null } | null }>("/scanner"),
    refetchOnMount: "always", refetchInterval: (q) => (q.state.data?.busy ? 1500 : false),
  });
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const details = useQuery({
    queryKey: ["scanner", "details"], enabled: false, staleTime: 0, retry: false,
    queryFn: () => api.get<{ available: boolean; details: string }>("/scanner/details"),
  });
  const devices = useQuery({
    queryKey: ["scanner", "devices"], enabled: Boolean(status.data?.available), staleTime: 60_000,
    queryFn: () => api.get<{ available: boolean; devices: { id: string; name: string }[] }>("/scanner/devices"),
  });
  const [opts, setOpts] = useState(() => ({ deviceId: saved().deviceId ?? "", dpi: saved().dpi ?? 300, color: saved().color ?? true }));
  const who = `${me?.activeBusinessId ?? ""}.${me?.user.id ?? ""}`;
  const sheet = useQuery({ queryKey: ["scanner-sheet", who], queryFn: () => storedSheet(who), initialData: () => storedSheet(who), staleTime: Infinity }).data ?? null;
  const setSheet = (s: Sheet | null) => {
    qc.setQueryData(["scanner-sheet", who], s);
    try { if (s) sessionStorage.setItem(sheetSS(who), JSON.stringify(s)); else sessionStorage.removeItem(sheetSS(who)); } catch { /* this sitting only */ }
  };
  const [err, setErr] = useState<string | null>(null);
  const keep = (next: typeof opts) => { setOpts(next); try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* ignore */ } };

  const scan = useMutation({
    mutationFn: () => api.post<Sheet>("/scanner/scan", {
      ...(opts.deviceId ? { deviceId: opts.deviceId } : {}), dpi: opts.dpi, color: opts.color,
      ...(sheet ? { scanId: sheet.id } : { slipDate: slipDate || null, merchantId: merchantId || null, jinsId: jinsId || null }),
    }),
    // these run even if the screen was left mid-scan: the page joins the kept sheet
    onSuccess: async (r) => { setErr(null); setSheet(r); await qc.invalidateQueries({ queryKey: ["scans"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
    onSettled: () => qc.invalidateQueries({ queryKey: ["scanner"], exact: true }),
  });
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/scans/${id}/run`, {}),
    // a sheet being read takes no more pages: the next press starts a new one
    onSuccess: (_r, id) => { setSheet(null); navigate(`/scan/${id}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  /* The kept sheet as the server has it: on coming back, when the scan running
     is this user's on a sheet (a reload forgot it), and again once that page is
     in. A sheet read or deleted meanwhile is let go. */
  const running = status.data?.busy ?? null;
  const target = running?.sheetId ?? sheet?.id ?? null;
  useEffect(() => {
    if (!target) return;
    api.get<{ status: string; pages: unknown[] }>(`/scans/${target}`)
      .then((b) => setSheet(b.status === "uploaded" ? { id: target, pages: b.pages.length } : null))
      .catch((e) => { if (apiStatus(e) === 404) setSheet(null); });
  }, [target, Boolean(running)]);

  if (!status.data?.available) return null;
  const list = devices.data?.devices ?? [];
  // a scan is running here or was started before this screen opened; until the
  // server has said which, nothing is pressed on an old answer
  const busy = scan.isPending || Boolean(running);
  const hold = busy || !status.isFetchedAfterMount;

  return (
    <div className="space-y-3 rounded-xl border border-line bg-raised/30 p-3">
      <div className="flex items-center gap-2">
        <Printer className="h-4 w-4 text-brand" />
        <p className="text-[13px] font-semibold text-ink">{t("scanner.title")}</p>
        {devices.isFetching && <Spinner className="h-3.5 w-3.5" />}
        {/* plugged in, or joined the Wi-Fi, after the page opened */}
        <Button size="sm" variant="ghost" className="ml-auto" disabled={devices.isFetching} icon={<RefreshCw className="h-3.5 w-3.5" />}
          onClick={() => void devices.refetch()}>{t("scanner.lookAgain")}</Button>
        <Button size="sm" variant="ghost" disabled={details.isFetching} icon={<Stethoscope className="h-3.5 w-3.5" />}
          onClick={() => { setShowDetails(true); void details.refetch(); }}>{t("scanner.check")}</Button>
      </div>
      {err && <Alert tone="bad">{err}</Alert>}
      {showDetails && (
        <div className="rounded-lg border border-line bg-raised/40 p-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <p className="text-[12px] font-medium text-muted">{t("scanner.checkTitle")}</p>
            {details.isFetching && <Spinner className="h-3.5 w-3.5" />}
            <Button size="sm" variant="ghost" className="ml-auto" icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              disabled={!details.data?.details}
              onClick={async () => {
                try { await navigator.clipboard.writeText(details.data?.details ?? ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
              }}>{copied ? t("common.copied") : t("common.copy")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowDetails(false)}>{t("common.close")}</Button>
          </div>
          {details.isError
            ? <Alert tone="bad">{details.error instanceof ApiError ? details.error.message : t("common.somethingWrong")}</Alert>
            : <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug text-muted">{details.data?.details ?? ""}</pre>}
          <p className="mt-1.5 text-[11px] text-faint">{t("scanner.checkHelp")}</p>
        </div>
      )}
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
          <Button variant={sheet ? "secondary" : "primary"} loading={busy} disabled={hold} icon={sheet ? <Plus className="h-4 w-4" /> : <ScanLine className="h-4 w-4" />}
            onClick={() => { setErr(null); scan.mutate(); }}>
            {busy ? t("scanner.scanning") : sheet ? t("scanner.next", { n: sheet.pages + 1 }) : t("scanner.scan")}
          </Button>
          {sheet && (
            <>
              <Badge tone="brand">{t("scanner.pages", { n: sheet.pages })}</Badge>
              <Button variant="primary" loading={read.isPending} disabled={hold} icon={<Play className="h-4 w-4" />}
                onClick={() => read.mutate(sheet.id)}>{t("scanner.readNow")}</Button>
              <Button variant="ghost" disabled={hold} onClick={() => navigate(`/scan/${sheet.id}`)}>{t("scanner.open")}</Button>
              <Button variant="ghost" disabled={hold} onClick={() => setSheet(null)}>{t("scanner.newSheet")}</Button>
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
