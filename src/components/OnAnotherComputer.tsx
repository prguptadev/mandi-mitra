import { useQuery } from "@tanstack/react-query";
import { MonitorSmartphone } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Badge } from "@/components/ui/index.tsx";

/* Reached over the shop's network, these are another computer's books — one
   shared set, not this laptop's own. The munshi must never wonder which books
   are on screen, so the header says whose they are. Nothing shows when the
   app is opened on the computer that holds them. */

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

/** Opened over the shop's network, not on the main computer that holds the books. */
export const onAnotherComputer = () => !LOCAL.has(window.location.hostname);

export function OnAnotherComputer() {
  const { t } = useI18n();
  const remote = onAnotherComputer();
  const q = useQuery({
    queryKey: ["cloud", "host"],
    queryFn: () => api.get<{ deviceName: string; shared: boolean }>("/cloud/host"),
    enabled: remote, staleTime: 5 * 60_000,
  });
  if (!remote) return null;
  return (
    <Badge tone="warn" className="max-w-[14rem] truncate"
      title={t("net.onOtherHint", { name: q.data?.deviceName ?? window.location.hostname })}>
      <MonitorSmartphone className="h-2.5 w-2.5" />
      {t("net.onOther", { name: q.data?.deviceName ?? window.location.hostname })}
    </Badge>
  );
}
