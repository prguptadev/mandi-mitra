import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Network, Copy, Check } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Switch } from "@/components/ui/index.tsx";

/* A second laptop on the shop's own network, using THIS computer's books
   directly: one database, nothing to sync, whatever one types the other sees
   on its next refresh. Different from cloud sync, which keeps two databases
   in step through Supabase and works anywhere. */

interface NetworkView {
  share: boolean; live: boolean; needsRestart: boolean; port: number; addresses: string[];
}

export function NetworkCard() {
  const { t } = useI18n();
  const { can } = useSession();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["network"], queryFn: () => api.get<NetworkView>("/cloud/network"),
    enabled: can("backup.manage"), staleTime: 30_000,
  });
  const set = useMutation({
    mutationFn: (share: boolean) => api.put<NetworkView>("/cloud/network", { share }),
    onSuccess: (v) => { setErr(null); qc.setQueryData(["network"], v); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  if (!can("backup.manage")) return null;
  const n = q.data;
  const urls = (n?.addresses ?? []).map((a) => `http://${a}:${n!.port}`);

  return (
    <Card>
      <CardHeader title={t("net.title")} sub={t("net.sub")}
        action={n && <Badge tone={n.live ? "ok" : "neutral"}><Network className="h-2.5 w-2.5" /> {t(n.live ? "net.on" : "net.off")}</Badge>} />
      <div className="space-y-3 p-4 text-[13px]">
        {err && <Alert tone="bad">{err}</Alert>}
        <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-raised/40 px-3 py-2.5">
          <div className="min-w-0">
            <p className="font-medium text-ink">{t("net.switch")}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-muted">{t("net.switchHint")}</p>
          </div>
          <Switch checked={n?.share ?? false} disabled={!n || set.isPending} onChange={(on: boolean) => { setErr(null); set.mutate(on); }} />
        </div>

        {n?.needsRestart && <Alert tone="warn">{t("net.restart")}</Alert>}

        {n?.share && (
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-muted">{t("net.typeThis")}</p>
            {urls.length === 0 ? (
              <p className="text-[12px] text-faint">{t("net.noAddress")}</p>
            ) : (
              <div className="space-y-1.5">
                {urls.map((u) => (
                  <div key={u} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                    <span className="num flex-1 truncate text-ink">{u}</span>
                    <Button size="sm" variant="ghost" icon={copied === u ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(u); setCopied(u); setTimeout(() => setCopied(null), 1500); } catch { /* clipboard blocked */ }
                      }}>{copied === u ? t("common.copied") : t("common.copy")}</Button>
                  </div>
                ))}
              </div>
            )}
            <Alert tone="warn" className="mt-2.5">{t("net.careful")}</Alert>
          </div>
        )}
        <p className="text-[11px] leading-snug text-faint">{t("net.note")}</p>
      </div>
    </Card>
  );
}
