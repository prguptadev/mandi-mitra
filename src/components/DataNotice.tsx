import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, X } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { sayServer } from "@/lib/serverHi.ts";
import { Button } from "@/components/ui/index.tsx";

/* One line above every screen, for everyone signed in, when the books need
   someone to know: a backup was put back at start-up (and from when), the
   books are damaged and only readable, or backups on this computer are
   failing. One sentence, at most two buttons. Asked for rarely: once when
   the app opens, then every half hour. */

interface Notice {
  start: { kind: "restored" | "readOnly" | "unavailable"; why: "missing" | "damaged"; backupAt?: string; syncHeld?: boolean } | null;
  backupFailing: string | null;
}

export function DataNotice() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["backup", "notice"], queryFn: () => api.get<Notice>("/backup/notice"),
    staleTime: 10 * 60_000, refetchInterval: 30 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const dismiss = useMutation({
    mutationFn: () => api.post("/backup/notice/dismiss"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backup", "notice"] }),
  });
  // the backup line can be closed for this sitting; it comes back while backups still fail
  const [hidden, setHidden] = useState<string | null>(null);
  const n = q.data;
  if (!n) return null;
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN", { dateStyle: "medium", timeStyle: "short" }) : "");
  let text: string | null = null;
  let onClose: (() => void) | null = null;
  let toSettings = false;
  if (n.start?.kind === "restored") {
    text = t(`${n.start.syncHeld ? "safe.restoredHeld" : "safe.restored"}.${n.start.why}` as "safe.restored.missing", { when: when(n.start.backupAt) });
    onClose = () => dismiss.mutate();
    toSettings = Boolean(n.start.syncHeld);
  } else if (n.start?.kind === "readOnly") {
    text = t("safe.readOnly");
  } else if (n.backupFailing && hidden !== n.backupFailing) {
    text = t("safe.backupFailing", { why: sayServer(n.backupFailing, lang) });
    const shown = n.backupFailing;
    onClose = () => setHidden(shown);
    toSettings = true;
  }
  if (!text) return null;
  return (
    <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-ink">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">{text}</span>
      {toSettings && can("backup.manage") && (
        <Link href="/settings?tab=data"><Button size="sm">{t("safe.openBackups")}</Button></Link>
      )}
      {onClose && (
        <Button size="icon" variant="ghost" onClick={onClose} loading={dismiss.isPending} title={t("common.close")} aria-label={t("common.close")}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
