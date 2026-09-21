import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Cloud, CloudUpload, ExternalLink, RotateCcw, Unplug } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/* The cloud copy (Supabase, or any Postgres): this computer stays the real
   database; every 5 minutes what changed is copied up. Images stay here. */

interface CloudState {
  configured: boolean; host: string | null; lastSyncAt: string | null; lastError: string | null;
  pushedLast: number; rowsInCloud: number | null; sizeBytes: number | null; freeBytes: number; syncing: boolean;
}

export function CloudCard() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cloud"], queryFn: () => api.get<CloudState>("/cloud"), enabled: can("backup.manage"), refetchInterval: 30_000 });
  const [conn, setConn] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["cloud"] });
  const connect = useMutation({
    mutationFn: (connection: string | null) => api.put("/cloud", { connection }),
    onSuccess: async () => { setErr(null); setConn(""); await refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ pushed: number }>("/cloud/sync", {}),
    onSuccess: async (r) => { setErr(null); setDone(t("cloud.pushed", { n: r.pushed })); await refresh(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const restore = useMutation({
    mutationFn: () => api.post<{ counts: Record<string, number> }>("/cloud/restore", { confirm: typed }),
    // everyone signs in again after a restore
    onSuccess: () => { window.location.href = "/"; },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  if (!can("backup.manage")) return null;
  const c = q.data;
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" });
  const used = c?.sizeBytes ?? 0;
  const pct = c ? Math.min(100, (used / c.freeBytes) * 100) : 0;

  return (
    <Card>
      <CardHeader title={t("cloud.title")} sub={t("cloud.sub")}
        action={c?.configured ? <Badge tone={c.lastError ? "warn" : "ok"}><Cloud className="h-2.5 w-2.5" /> {c.lastError ? t("cloud.problem") : t("cloud.on")}</Badge> : <Badge>{t("cloud.off")}</Badge>} />
      <div className="space-y-3 p-4 text-[13px]">
        {err && <Alert tone="bad">{err}</Alert>}
        {done && !err && <Alert tone="ok">{done}</Alert>}
        {c?.configured ? (
          <>
            <p className="num text-muted">{c.host}</p>
            {c.lastError && <Alert tone="warn">{c.lastError}</Alert>}
            <p className="text-muted">{c.lastSyncAt ? t("cloud.last", { when: when(c.lastSyncAt) }) : t("cloud.notYet")}{c.rowsInCloud != null ? ` · ${t("cloud.rows", { n: c.rowsInCloud.toLocaleString() })}` : ""}</p>
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-raised">
                <div className={cn("h-full rounded-full", pct > 85 ? "bg-bad" : pct > 60 ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, 0.5)}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-faint">{t("cloud.space", { used: (used / 1048576).toFixed(1), free: Math.round(c.freeBytes / 1048576) })}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={sync.isPending || c.syncing} icon={<CloudUpload className="h-3.5 w-3.5" />} onClick={() => { setDone(null); sync.mutate(); }}>{t("cloud.syncNow")}</Button>
              <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { setTyped(""); setRestoring(true); }}>{t("cloud.restore")}</Button>
              <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} loading={connect.isPending}
                onClick={() => { if (confirm(t("cloud.offConfirm"))) connect.mutate(null); }}>{t("cloud.turnOff")}</Button>
            </div>
          </>
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-snug text-muted">
              <li>{t("cloud.step1")} <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">supabase.com <ExternalLink className="h-3 w-3" /></a></li>
              <li>{t("cloud.step2")}</li>
              <li>{t("cloud.step3")}</li>
            </ol>
            <Field label={t("cloud.conn")} hint={t("cloud.connHint")}>
              <div className="flex gap-2">
                <Input type="password" autoComplete="off" value={conn} className="num text-[13px]"
                  placeholder="postgresql://postgres.xxxx:password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"
                  onChange={(e) => setConn(e.target.value)} />
                <Button variant="primary" loading={connect.isPending} disabled={conn.trim().length < 20} onClick={() => { setErr(null); connect.mutate(conn.trim()); }}>{t("cloud.connect")}</Button>
              </div>
            </Field>
          </>
        )}
        <p className="text-[11px] leading-snug text-faint">{t("cloud.note")}</p>
      </div>
      {restoring && (
        <Dialog open onClose={() => setRestoring(false)} title={t("cloud.restoreTitle")} sub={t("cloud.restoreSub")}
          footer={<>
            <Button onClick={() => setRestoring(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" loading={restore.isPending} disabled={typed !== "RESTORE"} onClick={() => restore.mutate()}>{t("cloud.restoreGo")}</Button>
          </>}>
          {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
          <Field label={t("cloud.typeRestore")}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="num" autoFocus />
          </Field>
        </Dialog>
      )}
    </Card>
  );
}
