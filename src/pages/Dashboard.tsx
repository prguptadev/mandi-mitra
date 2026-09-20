import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Users2, Factory, Wheat, UserCog, Check, ArrowRight, Building2, Hammer } from "lucide-react";
import { api, type Adati, type Merchant, type Jins, type UserRow, type Business } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { PageHeader } from "@/components/AppShell.tsx";
import { SkeletonStats } from "@/components/Skeletons.tsx";
import { Card, CardHeader, Badge, Button } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

function Stat({ icon: Icon, label, value, href }: { icon: typeof Users2; label: string; value: number | string; href?: string }) {
  const body = (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-card transition-colors hover:border-faint/60">
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand" />
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</p>
      </div>
      <p className="num text-2xl font-semibold tracking-tight text-ink">{value}</p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function DashboardPage() {
  const { t, pick } = useI18n();
  const { me, can } = useSession();

  const adati = useQuery({ queryKey: ["adati", {}], queryFn: () => api.get<Adati[]>("/adati"), enabled: can("adati.read") });
  const mills = useQuery({ queryKey: ["merchants"], queryFn: () => api.get<Merchant[]>("/merchants?all=1"), enabled: can("merchant.read") });
  const jins = useQuery({ queryKey: ["jins"], queryFn: () => api.get<Jins[]>("/jins"), enabled: can("jins.read") });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserRow[]>("/users"), enabled: can("users.read") });
  const biz = useQuery({ queryKey: ["business"], queryFn: () => api.get<Business>("/business/current"), enabled: can("business.read") });

  const loading = adati.isLoading || mills.isLoading || jins.isLoading;

  const steps = [
    { key: "business", label: t("dash.stepBusiness"), done: Boolean(biz.data?.addressLine1 && biz.data?.city), href: "/settings", perm: "business.read" },
    { key: "mills", label: t("dash.stepMills"), done: (mills.data?.length ?? 0) > 0, href: "/mills", perm: "merchant.read" },
    { key: "suppliers", label: t("dash.stepSuppliers"), done: (adati.data?.length ?? 0) > 0, href: "/suppliers", perm: "adati.read" },
    { key: "users", label: t("dash.stepUsers"), done: (users.data?.length ?? 0) > 1, href: "/users", perm: "users.read" },
  ].filter((s) => can(s.perm));

  const pending = steps.filter((s) => !s.done);

  return (
    <>
      <PageHeader
        title={`${t("auth.welcome")}, ${me?.user.name ?? ""}`}
        sub={me?.business ? pick(me.business.name, me.business.nameHi) : undefined}
      />

      {loading ? <SkeletonStats /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {can("adati.read") && <Stat icon={Users2} label={t("dash.suppliers")} value={adati.data?.length ?? 0} href="/suppliers" />}
          {can("merchant.read") && <Stat icon={Factory} label={t("dash.mills")} value={mills.data?.filter((m) => m.active).length ?? 0} href="/mills" />}
          {can("jins.read") && <Stat icon={Wheat} label={t("dash.commodities")} value={jins.data?.length ?? 0} href="/commodities" />}
          {can("users.read") && <Stat icon={UserCog} label={t("dash.staff")} value={users.data?.length ?? 0} href="/users" />}
        </div>
      )}

      {pending.length > 0 && (
        <Card className="mt-4">
          <CardHeader title={t("dash.setupChecklist")} sub={t("dash.setupSub")}
            action={<Badge tone="warn">{pending.length}</Badge>} />
          <div className="divide-y divide-line/70">
            {steps.map((s) => (
              <Link key={s.key} href={s.href}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/50">
                <span className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                  s.done ? "border-ok bg-ok text-white" : "border-line text-faint",
                )}>
                  {s.done && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span className={cn("flex-1 text-[13px]", s.done ? "text-muted line-through" : "font-medium text-ink")}>
                  {s.label}
                </span>
                <Badge tone={s.done ? "ok" : "neutral"}>{s.done ? t("dash.stepDone") : t("dash.stepTodo")}</Badge>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" />
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader
          title={<span className="inline-flex items-center gap-2"><Hammer className="h-3.5 w-3.5 text-warn" />{t("dash.comingSoon")}</span>} />
        <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {[t("nav.dailyList"), t("nav.scan"), t("nav.loads"), t("nav.parcha"), t("nav.stock"), t("nav.ledger")].map((label) => (
            <div key={label} className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">
              {label}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

export function AddBusinessDialogBody() { return null; }
