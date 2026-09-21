import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, Download, FolderSync, FolderOpen, History } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input } from "@/components/ui/index.tsx";

/* Backups of the whole database: automatic (every 12 hours), before every
   update, and on demand — optionally copied to a second folder such as a
   Google Drive or OneDrive folder, which gives a copy off this computer. */

interface BackupState {
  folder: string | null; lastAt: string | null; lastError: string | null; copiedAt: string | null;
  folders?: { data: string; db: string; scans: string; backups: string };
  backups: { name: string; kind: "auto" | "before-update" | "manual" | "before-restore"; bytes: number; at: string }[];
}

export function BackupCard() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["backup"], queryFn: () => api.get<BackupState>("/backup"), enabled: can("backup.manage") });
  const [folder, setFolder] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api.post("/backup/run", {}),
    onSuccess: async () => { setErr(null); await qc.invalidateQueries({ queryKey: ["backup"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  /** Going back to a backup: done on the next start, the current data kept aside. */
  const [restoring, setRestoring] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const restore = useMutation({
    mutationFn: (name: string) => api.post<{ scheduled: boolean; restarting: boolean }>("/backup/restore", { name, confirm: "RESTORE" }),
    onSuccess: (r) => { setRestoring(null); setTyped(""); setErr(null); setRestoreMsg(r.restarting ? t("backup.restoreRestarting") : t("backup.restoreRestart")); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const saveFolder = useMutation({
    mutationFn: (f: string | null) => api.put("/backup", { folder: f }),
    onSuccess: async () => { setErr(null); setFolder(null); await qc.invalidateQueries({ queryKey: ["backup"] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  if (!can("backup.manage")) return null;
  const b = q.data;
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" });
  const shown = folder ?? b?.folder ?? "";

  return (
    <Card>
      <CardHeader title={t("backup.title")} sub={t("backup.sub")}
        action={<Button size="sm" variant="primary" loading={run.isPending} icon={<DatabaseBackup className="h-3.5 w-3.5" />} onClick={() => run.mutate()}>{t("backup.now")}</Button>} />
      <div className="space-y-3 p-4 text-[13px]">
        {err && <Alert tone="bad">{err}</Alert>}
        {b?.lastError && <Alert tone="warn">{b.lastError}</Alert>}
        <p className="text-muted">{b?.lastAt ? t("backup.last", { when: when(b.lastAt) }) : t("backup.never")}</p>
        <Field label={t("backup.folder")} hint={t("backup.folderHint")}>
          <div className="flex gap-2">
            <Input value={shown} placeholder="C:\Users\...\Google Drive\Mandi" className="num text-[13px]"
              onChange={(e) => setFolder(e.target.value)} />
            <Button loading={saveFolder.isPending} disabled={folder === null || folder.trim() === (b?.folder ?? "")}
              icon={<FolderSync className="h-3.5 w-3.5" />} onClick={() => saveFolder.mutate(folder?.trim() || null)}>{t("common.save")}</Button>
          </div>
          {b?.folder && b.copiedAt && <p className="mt-1 text-[11px] text-ok">{t("backup.copied", { when: when(b.copiedAt) })}</p>}
        </Field>
        {(b?.backups.length ?? 0) > 0 && (
          <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {b!.backups.map((x) => (
              <div key={x.name} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-ink">{when(x.at)}</span>
                  <span className="text-[11px] text-faint">{Math.round(x.bytes / 1024).toLocaleString()} KB</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={x.kind === "manual" ? "brand" : x.kind === "before-update" ? "warn" : "neutral"}>{t(`backup.kind.${x.kind}` as "backup.kind.auto")}</Badge>
                  <a href={`/api/backup/file/${x.name}`} download title={t("backup.download")}>
                    <Button size="icon" variant="ghost" aria-label={t("backup.download")}><Download className="h-3.5 w-3.5" /></Button>
                  </a>
                  <Button size="icon" variant="ghost" title={t("backup.restoreThis")} aria-label={t("backup.restoreThis")}
                    onClick={() => { setErr(null); setTyped(""); setRestoring(x.name); }}><History className="h-3.5 w-3.5" /></Button>
                </span>
              </div>
            ))}
          </div>
        )}
        {b?.folders && (
          <div className="rounded-lg border border-line bg-raised/40 p-3">
            <p className="mb-2 text-[12px] font-medium text-ink">{t("backup.whereTitle")}</p>
            {([["data", b.folders.db, "backup.whereDb"], ["scans", b.folders.scans, "backup.whereScans"], ["backups", b.folders.backups, "backup.whereBackups"]] as const).map(([which, p, label]) => (
              <div key={which} className="flex items-center gap-2 py-1">
                <span className="w-24 shrink-0 text-[11px] text-muted">{t(label)}</span>
                <code className="min-w-0 flex-1 select-all break-all text-[11px] text-ink">{p}</code>
                <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />}
                  onClick={() => void api.post("/backup/open-folder", { which }).catch(() => undefined)}>{t("backup.open")}</Button>
              </div>
            ))}
          </div>
        )}
        {restoreMsg && <Alert tone="ok">{restoreMsg}</Alert>}
        <p className="text-[11px] leading-snug text-faint">{t("backup.restore")}</p>
        {restoring && (
          <Dialog open onClose={() => setRestoring(null)} title={t("backup.restoreTitle")} sub={t("backup.restoreSub", { when: when(b!.backups.find((x) => x.name === restoring)?.at ?? new Date().toISOString()) })}
            footer={<>
              <Button onClick={() => setRestoring(null)}>{t("common.cancel")}</Button>
              <Button variant="danger" loading={restore.isPending} disabled={typed !== "RESTORE"} onClick={() => restore.mutate(restoring)}>{t("backup.restoreGo")}</Button>
            </>}>
            {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
            <Field label={t("backup.typeRestore")}><Input value={typed} onChange={(e) => setTyped(e.target.value)} className="num" autoFocus /></Field>
          </Dialog>
        )}
      </div>
    </Card>
  );
}
