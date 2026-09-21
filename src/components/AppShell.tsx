import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, ListOrdered, ScanLine, Truck, FileText, Boxes, Users2,
  Factory, Wheat, BookOpen, Wallet, UserCog, ShieldCheck, ScrollText, Settings,
  Menu, X, Sun, Moon, Languages, ChevronDown, LogOut, Building2, Check, Plus,
  PanelLeftClose, PanelLeftOpen,
  ClipboardList, Landmark, ClipboardCheck, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { ApiError } from "@/lib/api.ts";
import { SyncIndicator } from "@/components/SyncIndicator.tsx";
import { MyPinDialog } from "@/components/MyPinDialog.tsx";
import { toastError } from "@/components/Toaster.tsx";
import { useI18n } from "@/lib/i18n.tsx";
import { useTheme } from "@/lib/theme.tsx";
import { useSession } from "@/lib/session.tsx";
import { Button, Badge } from "@/components/ui/index.tsx";
import type { StringKey } from "@/lib/strings.ts";

interface NavItem { href: string; labelKey: StringKey; icon: typeof LayoutDashboard; perm?: string; soon?: boolean }
interface NavGroup { labelKey: StringKey | null; items: NavItem[] }

const NAV: NavGroup[] = [
  { labelKey: null, items: [
    { href: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, perm: "dashboard.view" },
  ] },
  { labelKey: "nav.operations", items: [
    { href: "/daily", labelKey: "nav.dailyList", icon: ListOrdered, perm: "slip.read" },
    { href: "/scan", labelKey: "nav.scan", icon: ScanLine, perm: "scan.create" },
    { href: "/orders", labelKey: "nav.orders", icon: ClipboardList, perm: "po.read" },
    { href: "/loads", labelKey: "nav.loads", icon: Truck, perm: "load.read" },
    { href: "/challan", labelKey: "nav.challan", icon: ClipboardCheck, perm: "load.read" },
    { href: "/parcha", labelKey: "nav.parcha", icon: FileText, perm: "parcha.read" },
    { href: "/stock", labelKey: "nav.stock", icon: Boxes, perm: "stock.read" },
  ] },
  { labelKey: "nav.masters", items: [
    { href: "/suppliers", labelKey: "nav.suppliers", icon: Users2, perm: "adati.read" },
    { href: "/mills", labelKey: "nav.mills", icon: Factory, perm: "merchant.read" },
    { href: "/commodities", labelKey: "nav.commodities", icon: Wheat, perm: "jins.read" },
  ] },
  { labelKey: "nav.accounts", items: [
    { href: "/ledger", labelKey: "nav.ledger", icon: BookOpen, perm: "ledger.read" },
    { href: "/payments", labelKey: "nav.payments", icon: Wallet, perm: "payment.read" },
    { href: "/mill-accounts", labelKey: "nav.millAccounts", icon: Landmark, perm: "millledger.read" },
  ] },
  { labelKey: "nav.admin", items: [
    { href: "/users", labelKey: "nav.users", icon: UserCog, perm: "users.read" },
    { href: "/roles", labelKey: "nav.roles", icon: ShieldCheck, perm: "roles.manage" },
    { href: "/audit", labelKey: "nav.audit", icon: ScrollText, perm: "audit.read" },
    { href: "/settings", labelKey: "nav.settings", icon: Settings, perm: "business.read" },
  ] },
];

function BusinessSwitcher({ onAdd }: { onAdd: () => void }) {
  const { me, switchBusiness } = useSession();
  const { t, pick } = useI18n();
  const [open, setOpen] = useState(false);
  const [location, navigate] = useLocation();
  if (!me) return null;

  const active = me.businesses.find((b) => b.businessId === me.activeBusinessId);

  return (
    <div className="relative">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-raised"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand text-brand-ink text-[11px] font-bold">
          {active?.shortCode.slice(0, 3) ?? "—"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-tight text-ink">
            {active ? pick(active.name, active.nameHi) : "—"}
          </span>
          <span className="block truncate text-[11px] text-faint leading-tight mt-0.5">
            {me.role ? pick(me.role.label, me.role.labelHi) : ""}
          </span>
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-line bg-surface shadow-pop animate-fade-up">
            <p className="px-3 pt-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {t("biz.switch")}
            </p>
            {me.businesses.map((b) => (
              <button
                key={b.businessId} type="button"
                onClick={async () => {
                  setOpen(false);
                  if (b.businessId === me.activeBusinessId) return;
                  try {
                    await switchBusiness(b.businessId);
                    // a truck, scan or mill page belongs to the old business: go to its list
                    const parts = location.split("/").filter(Boolean);
                    if (parts.length > 1) navigate(`/${parts[0]}`);
                  } catch (e) {
                    toastError(e instanceof ApiError ? e.message : t("common.somethingWrong"));
                  }
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-raised"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-raised text-[10px] font-bold text-muted">
                  {b.shortCode.slice(0, 3)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{pick(b.name, b.nameHi)}</span>
                  <span className="block truncate text-[11px] text-faint">{pick(b.roleLabel, b.roleLabelHi)}</span>
                </span>
                {b.businessId === me.activeBusinessId && <Check className="h-4 w-4 shrink-0 text-brand" />}
              </button>
            ))}
            {me.user.isRoot && <div className="border-t border-line">
              <button
                type="button" onClick={() => { setOpen(false); onAdd(); }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-brand transition-colors hover:bg-raised"
              >
                <Plus className="h-4 w-4" /> {t("biz.add")}
              </button>
            </div>}
          </div>
        </>
      )}
    </div>
  );
}

const SIDEBAR_KEY = "mandi.sidebar.collapsed";

export function AppShell({ children, onAddBusiness }: { children: ReactNode; onAddBusiness: () => void }) {
  const [pinOpen, setPinOpen] = useState(false);
  const { t, lang, setLang } = useI18n();
  const { resolved, cycle } = useTheme();
  const { me, can, logout } = useSession();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === "1"; } catch { return false; }
  });

  /* Collapsed, the menu is still one flick of the mouse away: pointing at the
     left edge slides it over the page without pushing the grid around, and
     moving off it tucks it away again. */
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openPeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const closePeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 180);
  };

  /* Pointer-leave alone is not enough: alt-tab, the pointer leaving the window,
     or a touchpad jump can skip it and leave the menu stuck over the page. */
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPeek(false); };
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest("[data-sidebar-peek]")) setPeek(false);
    };
    const onBlur = () => setPeek(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onBlur);
    document.addEventListener("mouseleave", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseleave", onBlur);
    };
  }, [peek]);

  // following a link from the overlay should put it away
  useEffect(() => { setPeek(false); }, [location]);

  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((it) => !it.perm || can(it.perm)),
  })).filter((g) => g.items.length > 0);

  const sidebar = (
    <nav className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <BusinessSwitcher onAdd={onAddBusiness} />
      <div className="flex flex-1 flex-col gap-4">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.labelKey && (
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {t(g.labelKey)}
              </p>
            )}
            <div className="space-y-0.5">
              {g.items.map((it) => {
                const active = location === it.href || (it.href !== "/" && location.startsWith(it.href));
                return (
                  <Link
                    key={it.href} href={it.href} onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                      active ? "bg-brand/12 text-brand" : "text-muted hover:bg-raised hover:text-ink",
                    )}
                  >
                    <it.icon className={cn("h-4 w-4 shrink-0", active ? "text-brand" : "text-faint group-hover:text-muted")} />
                    <span className="flex-1 truncate">{t(it.labelKey)}</span>
                    {it.soon && <span className="text-[10px] text-faint">•</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );

  return (
    <div className="flex h-full bg-bg">
      <aside className={cn(
        "hidden shrink-0 border-r border-line bg-surface transition-[width] duration-200 lg:block",
        collapsed ? "w-0 overflow-hidden border-r-0" : "w-60",
      )}>
        {!collapsed && sidebar}
      </aside>

      {/* hover strip and overlay, only while collapsed */}
      {collapsed && (
        <>
          <div
            aria-hidden
            onMouseEnter={openPeek}
            className="fixed inset-y-0 left-0 z-40 hidden w-2 lg:block"
          />
          <aside
            data-sidebar-peek
            onMouseEnter={openPeek}
            onMouseLeave={closePeek}
            className={cn(
              "fixed inset-y-0 left-0 z-50 hidden w-60 border-r border-line bg-surface shadow-pop",
              "transition-transform duration-200 ease-out lg:block",
              peek ? "translate-x-0" : "-translate-x-full",
            )}
          >
            <div className="flex items-center justify-end border-b border-line px-2 py-1.5">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setPeek(false); toggleSidebar(); }}
                title={t("nav.pinSidebar")} aria-label={t("nav.pinSidebar")}>
                <PanelLeftOpen className="h-3.5 w-3.5" />
              </Button>
            </div>
            {sidebar}
          </aside>
        </>
      )}

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r border-line bg-surface shadow-pop">
            <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
              <span className="text-sm font-semibold">{t("app.name")}</span>
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} title={t("common.close")} aria-label={t("common.close")}><X className="h-4 w-4" /></Button>
            </div>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface/85 px-3 backdrop-blur sm:px-5">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menu">
            <Menu className="h-4.5 w-4.5" />
          </Button>
          <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={toggleSidebar}
            title={collapsed ? t("nav.showSidebar") : t("nav.hideSidebar")}
            aria-label={collapsed ? t("nav.showSidebar") : t("nav.hideSidebar")}>
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>

          <div className="flex min-w-0 items-center gap-2">
            <Building2 className="hidden h-4 w-4 shrink-0 text-brand sm:block" />
            <span className="truncate text-sm font-semibold text-ink">{t("app.name")}</span>
            <span className="hidden truncate text-xs text-faint md:block">— {t("app.tagline")}</span>
          </div>

          <div className="flex-1" />

          <SyncIndicator />

          <Button
            variant="ghost" size="sm" onClick={() => setLang(lang === "en" ? "hi" : "en")}
            icon={<Languages className="h-4 w-4" />}
            title={t("common.language")}
          >
            <span className="hidden sm:inline">{lang === "en" ? "हिन्दी" : "English"}</span>
          </Button>

          <Button variant="ghost" size="icon" onClick={cycle} title={t("common.theme")} aria-label={t("common.theme")}>
            {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <div className="mx-1 hidden h-6 w-px bg-line sm:block" />

          <button type="button" onClick={() => setPinOpen(true)} title={t("auth.changePin")}
            className="hidden items-center gap-2 rounded-lg px-1.5 py-0.5 hover:bg-raised sm:flex">
            <div className="text-right leading-tight">
              <p className="text-[13px] font-medium text-ink">{me?.user.name}</p>
              {me?.user.isRoot && <Badge tone="brand" className="mt-0.5">{t("users.owner")}</Badge>}
            </div>
          </button>
          <Button variant="ghost" size="icon" className="sm:hidden" onClick={() => setPinOpen(true)} title={t("auth.changePin")} aria-label={t("auth.changePin")}>
            <KeyRound className="h-4 w-4" />
          </Button>
          {pinOpen && <MyPinDialog onClose={() => setPinOpen(false)} />}
          <Button variant="ghost" size="icon" onClick={logout} title={t("auth.signOut")} aria-label={t("auth.signOut")}>
            <LogOut className="h-4 w-4" />
          </Button>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] px-3 py-5 sm:px-6 sm:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
      </div>
      {/* on a phone the buttons wrap under the title instead of pushing the page sideways */}
      {action && <div className="min-w-0 max-w-full">{action}</div>}
    </div>
  );
}
