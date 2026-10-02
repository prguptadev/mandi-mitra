import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Cloud, CloudOff, RefreshCw, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { cn } from "@/lib/utils.ts";
import { sayServer } from "@/lib/serverHi.ts";

/* The top bar's sync icon: in step, syncing, offline (work goes on), or
   paused. When changes from another computer arrive, every screen refreshes
   by itself. Nothing shows while sync is off. */

interface Status {
  enabled: boolean; state?: "ok" | "syncing" | "offline" | "paused" | "error";
  lastSyncAt?: string | null; changeCounter?: number; pausedReason?: string | null; lastError?: string | null;
  pending?: number; clashes?: number;
}

export function SyncIndicator() {
  const { t, lang } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  // asked every 8 s while the window is in front (paused while it is minimised);
  // coming back to the window asks at once, so the other computer's work shows straight away
  const q = useQuery({ queryKey: ["cloud-status"], queryFn: () => api.get<Status>("/cloud/status"), refetchInterval: 8_000, refetchOnWindowFocus: true, retry: false });
  const seen = useRef<number | null>(null);
  const s = q.data;

  useEffect(() => {
    if (!s?.enabled || s.changeCounter == null) return;
    if (seen.current !== null && s.changeCounter > seen.current) {
      // another computer's changes are here: bring every screen up to date
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== "cloud-status" });
    }
    seen.current = s.changeCounter;
  }, [s?.changeCounter, s?.enabled]);

  if (!s?.enabled) return null;
  const ago = s.lastSyncAt ? Math.max(0, Math.round((Date.now() - new Date(s.lastSyncAt).getTime()) / 1000)) : null;
  const title = s.state === "paused" ? sayServer(s.pausedReason ?? "", lang)
    : s.state === "offline" ? t("sync.tipOffline", { n: s.pending ?? 0 })
    : s.state === "error" ? sayServer(s.lastError ?? "", lang)
    : ago == null ? t("sync.notYet") : ago < 60 ? t("sync.tipSecs", { n: ago }) : t("sync.tipMins", { n: Math.round(ago / 60) });
  /* Nothing here alarms: no internet or a cloud hiccup is shown as a quiet grey
     cloud with the reason in its tooltip (work goes on and catches up by itself);
     the details live in Settings › Cloud sync. Only "update needed" is amber,
     because that one needs a person. */
  const quiet = s.state === "offline" || s.state === "error";
  const Icon = s.state === "syncing" ? RefreshCw : quiet ? CloudOff : s.state === "paused" ? AlertTriangle : Cloud;
  return (
    <button type="button" title={title} aria-label={title}
      onClick={() => { if (can("backup.manage")) navigate("/settings?tab=data"); }}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-raised",
        s.state === "ok" ? "text-ok" : s.state === "syncing" ? "text-brand" : quiet ? "text-faint" : "text-warn")}>
      <Icon className={cn("h-4 w-4", s.state === "syncing" && "animate-spin")} />
      <span className="hidden md:inline">{quiet ? t("sync.state.quiet") : t(`sync.state.${s.state ?? "ok"}`)}</span>
      {(s.clashes ?? 0) > 0 && <span className="rounded-full bg-warn px-1.5 text-[10px] font-semibold text-white">{s.clashes}</span>}
    </button>
  );
}
