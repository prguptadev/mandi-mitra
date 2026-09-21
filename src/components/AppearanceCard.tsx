import { Check, Moon, Monitor, Sun } from "lucide-react";
import { useI18n } from "@/lib/i18n.tsx";
import { ACCENTS, useTheme, type Accent, type Theme } from "@/lib/theme.tsx";
import { Card, CardHeader, Switch } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/** How the screens look on this computer: light or dark, the accent colour, and alternate row shading. */
export function AppearanceCard() {
  const { t } = useI18n();
  const { theme, setTheme, resolved, accent, setAccent, zebra, setZebra } = useTheme();
  const modes: { v: Theme; icon: typeof Sun; label: string }[] = [
    { v: "light", icon: Sun, label: t("look.light") },
    { v: "dark", icon: Moon, label: t("look.dark") },
    { v: "system", icon: Monitor, label: t("look.system") },
  ];
  return (
    <Card>
      <CardHeader title={t("look.title")} sub={t("look.sub")} />
      <div className="space-y-5 p-4">
        <div>
          <p className="mb-2 text-[12px] font-semibold text-ink">{t("look.mode")}</p>
          <div className="inline-flex rounded-lg border border-line bg-raised/50 p-0.5">
            {modes.map((m) => (
              <button key={m.v} type="button" onClick={() => setTheme(m.v)}
                className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
                  theme === m.v ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                <m.icon className="h-3.5 w-3.5" />{m.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-[12px] font-semibold text-ink">{t("look.accent")}</p>
          <div className="flex flex-wrap gap-2.5">
            {(Object.keys(ACCENTS) as Accent[]).map((a) => {
              const [brand] = ACCENTS[a][resolved];
              return (
                <button key={a} type="button" onClick={() => setAccent(a)} title={t(`look.c.${a}`)} aria-label={t(`look.c.${a}`)} aria-pressed={accent === a}
                  className="group flex w-14 flex-col items-center gap-1">
                  <span className={cn("flex h-9 w-9 items-center justify-center rounded-full ring-offset-2 ring-offset-surface transition-shadow",
                    accent === a ? "ring-2 ring-ink" : "group-hover:ring-2 group-hover:ring-line")}
                    style={{ backgroundColor: `hsl(${brand})` }}>
                    {accent === a && <Check className="h-4 w-4" style={{ color: `hsl(${ACCENTS[a][resolved][1]})` }} />}
                  </span>
                  <span className={cn("text-[11px] leading-tight", accent === a ? "font-semibold text-ink" : "text-muted")}>{t(`look.c.${a}`)}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] text-muted">{t("look.accentSub")}</p>
        </div>

        <div className="rounded-lg border border-line p-3">
          <Switch checked={zebra} onChange={setZebra} label={t("look.zebra")} />
          <p className="mt-1.5 text-[12px] text-muted">{t("look.zebraSub")}</p>
          {/* a small sample, so the choice can be seen before leaving the page */}
          <table className="mt-3 w-full max-w-sm border-collapse text-[12px]">
            <tbody>
              {["630 · Samra Enterprises", "634 · Shivam Trading", "635 · Amit Trading", "636 · Radha Charan Trading"].map((r) => (
                <tr key={r}><td className="border-b border-line/70 px-2 py-1 text-ink">{r}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
