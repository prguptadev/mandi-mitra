import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarCheck, X } from "lucide-react";
import { api } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { useFY } from "@/lib/fy.tsx";
import { todayISO } from "@/lib/utils.ts";

/* The things worth doing today, on the dashboard: mills to call and past days
   still open. Each shows only when there is something to do, and only to those
   who can act on it. Tally is not one of them — sending to Tally is done when
   the books are being closed, not chased from here. */

const CLOSED = "mm.attentionClosed";

export function AttentionStrip() {
  const { t } = useI18n();
  const { can } = useSession();
  const { thisYear } = useFY();
  const today = todayISO();
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString("en-CA"); })();
  const days = useQuery({
    queryKey: ["days", "list", thisYear.from, yesterday],
    queryFn: () => api.get<{ days: { day: string; closed: unknown }[] }>(`/days?from=${thisYear.from}&to=${yesterday}`),
    enabled: can("day.close") && yesterday >= thisYear.from, staleTime: 60_000,
  });
  // closed with ×: hidden until the app is closed, or until the count changes
  const [closed, setClosed] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem(CLOSED) ?? "[]"); } catch { return []; } });
  const close = (text: string) => {
    const next = [...closed, text];
    setClosed(next);
    try { sessionStorage.setItem(CLOSED, JSON.stringify(next)); } catch { /* closed for now only */ }
  };
  const open = (days.data?.days ?? []).filter((d) => !d.closed).length;
  const items = ([
    open > 0 && { href: "/day-close", icon: CalendarCheck, text: t("att.openDays", { n: open }), tone: "text-warn" },
  ].filter(Boolean) as { href: string; icon: typeof CalendarCheck; text: string; tone: string }[]).filter((it) => !closed.includes(it.text));
  if (!items.length) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {items.map((it) => (
        <span key={it.href} className="inline-flex items-center rounded-lg border border-line bg-surface text-[13px] font-medium text-ink shadow-card hover:border-brand/50">
          <Link href={it.href} className="inline-flex items-center gap-2 py-2 pl-3 pr-1.5">
            <it.icon className={`h-4 w-4 ${it.tone}`} />{it.text}
          </Link>
          <button type="button" onClick={() => close(it.text)} title={t("common.close")} aria-label={t("common.close")}
            className="mr-1 grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
