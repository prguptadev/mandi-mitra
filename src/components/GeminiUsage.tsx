import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { api, type GeminiUsage } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Alert } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * How much of today's Gemini allowance is gone, as counted by this app.
 * On the free tier Google allows a fixed number of reads a day and each page
 * is one read, so this is what tells the operator whether a sheet will go
 * through before they upload it rather than after.
 */
export function GeminiUsageBar({ className }: { className?: string }) {
  const { t, lang } = useI18n();
  const q = useQuery({
    queryKey: ["settings", "gemini", "usage"],
    queryFn: () => api.get<GeminiUsage>("/settings/gemini/usage"),
    refetchInterval: 30_000,
  });
  const u = q.data;
  if (!u?.configured) return null;

  const reset = u.resetsAt
    ? new Date(u.resetsAt).toLocaleTimeString(lang === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", minute: "2-digit" })
    : "";
  const limit = u.dailyLimit ?? null;
  const left = limit !== null ? Math.max(0, limit - (u.used ?? 0)) : null;

  if (u.exhausted || (left !== null && left === 0)) {
    return (
      <Alert tone="bad" className={className}>
        <p className="font-semibold">{t("gemini.exhausted", { limit: limit ?? 20, reset })}</p>
        <p className="mt-0.5">{t("gemini.exhaustedSub")}</p>
      </Alert>
    );
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-[12px] text-muted", className)}>
      <Gauge className="h-3.5 w-3.5 text-brand" />
      {limit !== null ? (
        <>
          <span>{t("gemini.usedOf", { used: u.used ?? 0, limit })}</span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-raised">
            <span className={cn("block h-full rounded-full", (left ?? 0) <= 3 ? "bg-bad" : (left ?? 0) <= 8 ? "bg-warn" : "bg-ok")}
              style={{ width: `${Math.min(100, ((u.used ?? 0) / limit) * 100)}%` }} />
          </span>
        </>
      ) : (
        <span>{t("gemini.usedToday", { used: u.used ?? 0 })}</span>
      )}
      <span className="text-faint">· {t("gemini.onePerPage")} · {t("gemini.resets", { reset })}</span>
    </div>
  );
}
