import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from "@/components/ui/index.tsx";

/* The app's version, and updating it from an installer downloaded from
   GitHub Releases into a folder (Downloads unless another is set). */

interface UpdateState {
  version: string; desktop: boolean; folder: string;
  found: { name: string; version: string; verified: boolean | null } | null;
  latest: { version: string; url: string } | null; releasesUrl: string;
}

export function UpdateCard() {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const basic = useQuery({ queryKey: ["app"], queryFn: () => api.get<{ version: string; desktop: boolean }>("/app") });
  const allowed = can("app.update");
  const q = useQuery({ queryKey: ["app", "update"], queryFn: () => api.get<UpdateState>("/app/update"), enabled: allowed });
  const [folder, setFolder] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const saveFolder = useMutation({
    mutationFn: (f: string) => api.put<UpdateState>("/app/update", { folder: f }),
    onSuccess: (r) => { setErr(null); setFolder(null); qc.setQueryData(["app", "update"], r); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const install = useMutation({
    mutationFn: (name: string) => api.post<{ installing: string }>("/app/update/install", { name }),
    onSuccess: (r) => setInstalling(r.installing),
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const u = q.data;
  const version = u?.version ?? basic.data?.version;

  return (
    <Card>
      <CardHeader title={t("upd.title")} sub={version ? t("upd.current", { v: version }) : undefined}
        action={allowed && <Button size="sm" loading={q.isFetching} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => { setErr(null); void q.refetch(); }}>{t("upd.check")}</Button>} />
      {allowed && (
        <div className="space-y-3 p-4 text-[13px]">
          {err && <Alert tone="bad">{err}</Alert>}
          {installing && <Alert tone="ok">{t("upd.installing", { v: installing })}</Alert>}
          {u?.latest && version && u.latest.version !== version && (
            <p className="text-muted">{t("upd.latest", { v: u.latest.version })}{" "}
              <a href={u.latest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">{t("upd.download")} <ExternalLink className="h-3 w-3" /></a></p>
          )}
          {u?.found ? (
            <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{t("upd.found", { v: u.found.version })}</span>
                {u.found.verified === true && <Badge tone="ok"><ShieldCheck className="h-3 w-3" /> {t("upd.verified")}</Badge>}
                {u.found.verified === false && <Badge tone="bad"><ShieldAlert className="h-3 w-3" /> {t("upd.notVerified")}</Badge>}
                {u.found.verified === null && <Badge>{t("upd.unknown")}</Badge>}
              </p>
              <p className="num text-[11px] text-faint">{u.found.name}</p>
              {u.found.verified === false && <Alert tone="warn">{t("upd.notVerifiedHelp")}</Alert>}
              {u.desktop ? (
                <Button variant="primary" loading={install.isPending} disabled={Boolean(installing) || u.found.verified === false} icon={<Download className="h-4 w-4" />}
                  onClick={() => { if (confirm(t("upd.confirm", { v: u.found!.version }))) install.mutate(u.found!.name); }}>
                  {t("upd.install", { v: u.found.version })}
                </Button>
              ) : <p className="text-[12px] text-muted">{t("upd.desktopOnly")}</p>}
            </div>
          ) : u && <p className="text-muted">{t("upd.none")}</p>}
          <Field label={t("upd.folder")} hint={t("upd.folderHint")}>
            <div className="flex gap-2">
              <Input value={folder ?? u?.folder ?? ""} className="num text-[13px]" onChange={(e) => setFolder(e.target.value)} />
              <Button loading={saveFolder.isPending} disabled={folder === null || folder.trim() === u?.folder} onClick={() => saveFolder.mutate(folder!.trim())}>{t("common.save")}</Button>
            </div>
          </Field>
          <a href={u?.releasesUrl ?? "https://github.com/prguptadev/mandi-mitra/releases"} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:underline">{t("upd.releases")} <ExternalLink className="h-3 w-3" /></a>
        </div>
      )}
    </Card>
  );
}
