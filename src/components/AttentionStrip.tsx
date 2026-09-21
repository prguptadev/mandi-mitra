import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarCheck, FileSpreadsheet, PhoneCall } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFY } from "@/lib/fy.tsx";
import { todayISO } from "@/lib/utils.ts";

/* The three things worth doing today, on the dashboard: mills to call,
   past days still open, and entries not yet in Tally. Each shows only when
   there is something to do, and only to those who can act on it. */

export function AttentionStrip() {
  const { t } = useI18n();
  const { can } = useSession();
  const { thisYear } = useFY();
  const today = todayISO();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
  const canTally = can("export.data") && can("ledger.read") && can("millledger.read");
  const fu = useQuery({
    queryKey: ["mill-followup"], queryFn: () => api.get<{ totals: { dueToday: number } }>("/mill-followup"),
    enabled: can("millledger.read"), staleTime: 60_000,
  });
  const days = useQuery({
    queryKey: ["days", "list", thisYear.from, yesterday],
    queryFn: () => api.get<{ days: { day: string; closed: unknown }[] }>(`/days?from=${thisYear.from}&to=${yesterday}`),
    enabled: can("day.close") && yesterday >= thisYear.from, staleTime: 60_000,
  });
  const tally = useQuery({
    queryKey: ["tally", "days", thisYear.from, today, "attention"],
    queryFn: () => api.post<{ days: { all: { new: number; changed: number } }[] }>("/tally/days", { from: thisYear.from, to: today, kinds: ["slip", "payment", "parcha", "receipt", "cut"] }),
    enabled: canTally, staleTime: 60_000,
  });
  const calls = fu.data?.totals.dueToday ?? 0;
  const open = (days.data?.days ?? []).filter((d) => !d.closed).length;
  const toSend = (tally.data?.days ?? []).reduce((s, d) => s + d.all.new + d.all.changed, 0);
  const items = [
    calls > 0 && { href: "/mill-followup", icon: PhoneCall, text: t("att.calls", { n: calls }), tone: "text-warn" },
    open > 0 && { href: "/day-close", icon: CalendarCheck, text: t("att.openDays", { n: open }), tone: "text-warn" },
    toSend > 0 && { href: "/tally", icon: FileSpreadsheet, text: t("att.tally", { n: toSend }), tone: "text-brand" },
  ].filter(Boolean) as { href: string; icon: typeof PhoneCall; text: string; tone: string }[];
  if (!items.length) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {items.map((it) => (
        <Link key={it.href} href={it.href}
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-ink shadow-card hover:border-brand/50">
          <it.icon className={`h-4 w-4 ${it.tone}`} />{it.text}
        </Link>
      ))}
    </div>
  );
}
