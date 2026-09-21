import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { cn, dmy } from "@/lib/utils.ts";

/* The small "T" on a row of a list: this entry is in Tally (green), or it was
   sent and has changed here since (red — Tally still has the old figures). */

export type TallyKind = "slip" | "payment" | "parcha" | "receipt" | "cut";
export interface TallyFlag { state: "sent" | "changed"; at: number | null; by: string | null }

/** Every entry of one kind in the dates that Tally has, keyed by the entry's id. */
export function useTallyFlags(kind: TallyKind, from: string, to: string): Record<string, TallyFlag> {
  const { can } = useSession();
  const q = useQuery({
    queryKey: ["tally", "flags", kind, from, to],
    queryFn: () => api.get<{ flags: Record<string, TallyFlag> }>(`/tally/flags?kind=${kind}&from=${from}&to=${to}`),
    enabled: Boolean(from && to && from <= to) && can("slip.read", "payment.read", "parcha.read", "millledger.read", "ledger.read"),
    staleTime: 30_000,
  });
  return q.data?.flags ?? {};
}

export function TallyMark({ flag, className }: { flag?: TallyFlag; className?: string }) {
  const { t, lang } = useI18n();
  if (!flag) return null;
  const when = flag.at ? new Date(flag.at * 1000) : null;
  const tip = flag.state === "sent"
    ? t("tally.markSent", { at: when ? `${dmy(when.toLocaleDateString("en-CA"))} ${when.toLocaleTimeString(lang === "hi" ? "hi-IN" : "en-IN", { hour: "2-digit", minute: "2-digit" })}` : "—", by: flag.by ?? "—" })
    : t("tally.markChanged");
  return (
    <span title={tip} aria-label={tip}
      className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded px-0.5 text-[9px] font-bold leading-none",
        flag.state === "sent" ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad", className)}>
      {flag.state === "sent" ? "T✓" : "T!"}
    </span>
  );
}
