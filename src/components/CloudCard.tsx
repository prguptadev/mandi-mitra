import { useState } from "react";
import { useConfirm } from "@/components/Confirm.tsx";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Cloud, CloudDownload, ExternalLink, Laptop, RefreshCw, Unplug, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Switch } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/* Cloud sync (Supabase): every computer keeps its own data and works offline;
   in the background each sends its changes up and brings the others' down. */

interface Device { id: string; name: string; version: string; lastSeen: string | null; me: boolean }
interface CloudView {
  configured: boolean; live: boolean; host: string | null; deviceName: string;
  lastSyncAt: string | null; lastError: string | null; pausedReason: string | null;
  rowsInCloud: number | null; sizeBytes: number | null; freeBytes: number;
  syncing: boolean; state: "off" | "ok" | "syncing" | "offline" | "paused" | "error"; pending: number; clashes: number;
  devices: Device[];
  needsJoin?: { rows: number; devices: string[] };
}
interface Clash { id: number; at: string; tbl: string; row_id: string; kept: string; other_device: string | null; lost: string; note: string }

export function CloudCard() {
  const { t, lang } = useI18n();
  const ask = useConfirm();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cloud"], queryFn: () => api.get<CloudView>("/cloud"), enabled: can("backup.manage"), refetchInterval: 15_000 });
  const [conn, setConn] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [joining, setJoining] = useState<null | { rows: number; devices: string[] }>(null);
  const [restoring, setRestoring] = useState(false);
  const [typed, setTyped] = useState("");
  const [showClashes, setShowClashes] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["cloud"] });

  const connect = useMutation({
    mutationFn: (connection: string | null) => api.put<CloudView>("/cloud", { connection }),
    onSuccess: async (r) => {
      setErr(null);
      if (r.needsJoin) { setTyped(""); setJoining(r.needsJoin); return; }
      setConn(""); await refresh();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const join = useMutation({
    mutationFn: () => api.post("/cloud/join", { connection: conn.trim(), confirm: typed }),
    // everyone signs in again against the joined data
    onSuccess: () => { window.location.href = "/"; },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const live = useMutation({
    mutationFn: (on: boolean) => api.post<CloudView>("/cloud/live", { on }),
    onSuccess: (v) => { qc.setQueryData(["cloud"], v); void qc.invalidateQueries({ queryKey: ["sync"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const sync = useMutation({
    mutationFn: () => api.post("/cloud/sync", {}),
    onSuccess: async () => { setErr(null); await refresh(); await qc.invalidateQueries(); },
    onError: async (e) => { setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")); await refresh(); },
  });
  const restore = useMutation({
    mutationFn: () => api.post("/cloud/restore", { confirm: typed }),
    onSuccess: () => { window.location.href = "/"; },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const rename = useMutation({
    mutationFn: (n: string) => api.put("/cloud/device", { name: n }),
    onSuccess: async () => { setName(null); await refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const clashes = useQuery({ queryKey: ["cloud", "clashes"], queryFn: () => api.get<Clash[]>("/cloud/clashes"), enabled: showClashes });
  const clearClashes = useMutation({
    mutationFn: () => api.del("/cloud/clashes"),
    onSuccess: async () => { setShowClashes(false); await refresh(); },
  });

  if (!can("backup.manage")) return null;
  const c = q.data;
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" });
  const used = c?.sizeBytes ?? 0;
  const pct = c ? Math.min(100, (used / c.freeBytes) * 100) : 0;
  const tone = { ok: "ok", syncing: "brand", offline: "warn", paused: "warn", error: "bad", off: "neutral" } as const;

  return (
    <Card>
      <CardHeader title={t("cloud.title")} sub={t("cloud.sub")}
        action={c && <Badge tone={tone[c.state]}><Cloud className="h-2.5 w-2.5" /> {t(`sync.state.${c.state}`)}</Badge>} />
      <div className="space-y-3 p-4 text-[13px]">
        {err && <Alert tone="bad">{err}</Alert>}
        {c?.configured ? (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-raised/40 px-3 py-2.5">
              <div className="min-w-0">
                <p className="font-medium text-ink">{t("sync.liveTitle")}</p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">{c.live ? t("sync.liveOnHint") : t("sync.liveOffHint")}</p>
              </div>
              <Switch checked={c.live} disabled={live.isPending}
                onChange={(on: boolean) => { setErr(null); live.mutate(on); }} />
            </div>
            {c.pausedReason && <Alert tone="warn">{c.pausedReason}</Alert>}
            {!c.pausedReason && c.lastError && <Alert tone={c.state === "offline" ? "warn" : "bad"}>{c.lastError}</Alert>}
            <p className="text-muted">
              {c.lastSyncAt ? t("sync.last", { when: when(c.lastSyncAt) }) : t("sync.notYet")}
              {c.pending ? ` · ${t("sync.pending", { n: c.pending })}` : ""}
            </p>
            <div className="rounded-lg border border-line">
              {c.devices.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 border-b border-line/70 px-3 py-1.5 last:border-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <Laptop className="h-3.5 w-3.5 shrink-0 text-faint" />
                    <span className="truncate text-ink">{d.name}</span>
                    {d.me && <Badge tone="brand">{t("sync.thisComputer")}</Badge>}
                  </span>
                  <span className="whitespace-nowrap text-[11px] text-faint">v{d.version}{d.lastSeen ? ` · ${when(d.lastSeen)}` : ""}</span>
                </div>
              ))}
            </div>
            <Field label={t("sync.name")} hint={t("sync.nameHint")}>
              <div className="flex gap-2">
                <Input value={name ?? c.deviceName} onChange={(e) => setName(e.target.value)} className="text-[13px]" />
                <Button disabled={name === null || !name.trim() || name.trim() === c.deviceName} loading={rename.isPending} onClick={() => rename.mutate(name!.trim())}>{t("common.save")}</Button>
              </div>
            </Field>
            {c.clashes > 0 && (
              <Alert tone="warn">
                <span className="flex flex-wrap items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5" />{t("sync.clashesN", { n: c.clashes })}
                  <Button size="sm" variant="secondary" onClick={() => setShowClashes(true)}>{t("sync.showClashes")}</Button>
                </span>
              </Alert>
            )}
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-raised">
                <div className={cn("h-full rounded-full", pct > 85 ? "bg-bad" : pct > 60 ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, 0.5)}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-faint">{t("cloud.space", { used: (used / 1048576).toFixed(1), free: Math.round(c.freeBytes / 1048576) })} · {c.host}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={!c.live} loading={sync.isPending || c.syncing} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => sync.mutate()}>{t("sync.now")}</Button>
              <Button size="sm" variant="secondary" icon={<CloudDownload className="h-3.5 w-3.5" />} onClick={() => { setTyped(""); setRestoring(true); }}>{t("cloud.restore")}</Button>
              <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} loading={connect.isPending}
                onClick={async () => { if (await ask({ title: t("cloud.turnOff"), message: t("sync.offConfirm"), danger: true, confirmLabel: t("cloud.turnOff") })) connect.mutate(null); }}>{t("cloud.turnOff")}</Button>
            </div>
          </>
        ) : (
          <>
            {c?.pausedReason && <Alert tone="warn">{c.pausedReason}</Alert>}
            <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-snug text-muted">
              <li>{t("cloud.step1")} <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">supabase.com <ExternalLink className="h-3 w-3" /></a></li>
              <li>{t("cloud.step2")}</li>
              <li>{t("cloud.step3")}</li>
              <li>{t("sync.step4")}</li>
            </ol>
            <Field label={t("cloud.conn")} hint={t("cloud.connHint")}>
              <div className="flex gap-2">
                <Input type="password" autoComplete="off" value={conn} className="num text-[13px]"
                  placeholder="postgresql://postgres.xxxx:password@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
                  onChange={(e) => setConn(e.target.value)} />
                <Button variant="primary" loading={connect.isPending} disabled={conn.trim().length < 20} onClick={() => { setErr(null); connect.mutate(conn.trim()); }}>{t("cloud.connect")}</Button>
              </div>
            </Field>
          </>
        )}
        <p className="text-[11px] leading-snug text-faint">{t("sync.note")}</p>
      </div>

      {joining && (
        <Dialog open onClose={() => setJoining(null)} title={t("sync.joinTitle")}
          sub={t("sync.joinSub", { n: joining.rows.toLocaleString(), from: joining.devices.join(", ") || "—" })}
          footer={<>
            <Button onClick={() => setJoining(null)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={join.isPending} disabled={typed !== "JOIN"} onClick={() => join.mutate()}>{t("sync.joinGo")}</Button>
          </>}>
          {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
          <Field label={t("sync.typeJoin")}><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="num" autoFocus /></Field>
        </Dialog>
      )}
      {restoring && (
        <Dialog open onClose={() => setRestoring(false)} title={t("cloud.restoreTitle")} sub={t("cloud.restoreSub")}
          footer={<>
            <Button onClick={() => setRestoring(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={restore.isPending} disabled={typed !== "RESTORE"} onClick={() => restore.mutate()}>{t("cloud.restoreGo")}</Button>
          </>}>
          {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
          <Field label={t("cloud.typeRestore")}><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="num" autoFocus /></Field>
        </Dialog>
      )}
      {showClashes && (
        <Dialog open wide onClose={() => setShowClashes(false)} title={t("sync.clashesTitle")} sub={t("sync.clashesSub")}
          footer={<>
            <Button variant="ghost" className="mr-auto" loading={clearClashes.isPending} onClick={() => clearClashes.mutate()}>{t("sync.clearClashes")}</Button>
            <Button onClick={() => setShowClashes(false)}>{t("common.close")}</Button>
          </>}>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto text-[12px]">
            {(clashes.data ?? []).map((x) => (
              <div key={x.id} className="rounded-lg border border-line p-2.5">
                <p className="font-medium text-ink">{t(`sync.tbl.${x.tbl}` as "sync.tbl.purchase_slips") === `sync.tbl.${x.tbl}` ? x.tbl : t(`sync.tbl.${x.tbl}` as "sync.tbl.purchase_slips")} · <span className="text-faint">{when(x.at)}</span></p>
                <p className="text-muted">{x.note}</p>
                <details className="mt-1"><summary className="cursor-pointer text-faint">{t("sync.otherVersion")}</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-[11px]">{x.lost}</pre></details>
              </div>
            ))}
            {clashes.data && !clashes.data.length && <p className="text-muted">{t("sync.noClashes")}</p>}
          </div>
        </Dialog>
      )}
    </Card>
  );
}
