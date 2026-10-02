import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { Route, Switch as RouteSwitch, useLocation, Redirect, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, WifiOff, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { AppShell } from "@/components/AppShell.tsx";
import { ErrorBoundary } from "@/components/ErrorBoundary.tsx";
import { HindiInput } from "@/components/HindiInput.tsx";
import { SkeletonShell } from "@/components/Skeletons.tsx";
import { Button, Card, Dialog, Field, Input, Alert, EmptyState, Spinner } from "@/components/ui/index.tsx";

/* Each screen is its own file, fetched the first time it is opened, so the
   app starts on the code of its first screen only. The others are fetched one
   at a time once the first screen is up and the computer is idle, so moving
   between screens stays instant. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Screen = ComponentType<any>;
const loaders: (() => Promise<unknown>)[] = [];
function screen<M>(load: () => Promise<M>, pick: (m: M) => Screen): Screen {
  let mod: M | undefined;
  const get = () => load().then((m) => (mod = m));
  loaders.push(get);
  // already fetched: handed over at once, so the screen does not blink through "loading"
  return lazy(() => (mod !== undefined
    ? ({ then: (ok: (v: { default: Screen }) => void) => ok({ default: pick(mod as M) }) } as unknown as Promise<{ default: Screen }>)
    : get().then((m) => ({ default: pick(m) }))));
}
// most used first: that is the order they are fetched in while idle
const DashboardPage = screen(() => import("@/pages/Dashboard.tsx"), (m) => m.DashboardPage);
const DailyListPage = screen(() => import("@/pages/DailyList.tsx"), (m) => m.DailyListPage);
const loads = () => import("@/pages/Loads.tsx");
const LoadsPage = screen(loads, (m) => m.LoadsPage);
const LoadDetailPage = screen(loads, (m) => m.LoadDetailPage);
const ParchaRegisterPage = screen(loads, (m) => m.ParchaRegisterPage);
const stock = () => import("@/pages/Stock.tsx");
const StockPage = screen(stock, (m) => m.StockPage);
const MillAccountPage = screen(stock, (m) => m.MillAccountPage);
const accounts = () => import("@/pages/Accounts.tsx");
const LedgerPage = screen(accounts, (m) => m.LedgerPage);
const PaymentsPage = screen(accounts, (m) => m.PaymentsPage);
const ScanListPage = screen(() => import("@/pages/ScanList.tsx"), (m) => m.ScanListPage);
const ScanReviewPage = screen(() => import("@/pages/ScanReview.tsx"), (m) => m.ScanReviewPage);
const SheetsPage = screen(() => import("@/pages/Sheets.tsx"), (m) => m.SheetsPage);
const SuppliersPage = screen(() => import("@/pages/Suppliers.tsx"), (m) => m.SuppliersPage);
const millMoney = () => import("@/pages/MillMoney.tsx");
const MillLedgerPage = screen(millMoney, (m) => m.MillLedgerPage);
const MillStatementPage = screen(millMoney, (m) => m.MillStatementPage);
const OrdersPage = screen(() => import("@/pages/Orders.tsx"), (m) => m.OrdersPage);
const ChallanPage = screen(() => import("@/pages/Challan.tsx"), (m) => m.ChallanPage);
const DayClosePage = screen(() => import("@/pages/DayClose.tsx"), (m) => m.DayClosePage);
const MillFollowupPage = screen(() => import("@/pages/MillFollowup.tsx"), (m) => m.MillFollowupPage);
const MillsPage = screen(() => import("@/pages/Mills.tsx"), (m) => m.MillsPage);
const TallyPage = screen(() => import("@/pages/Tally.tsx"), (m) => m.TallyPage);
const admin = () => import("@/pages/Admin.tsx");
const UsersPage = screen(admin, (m) => m.UsersPage);
const RolesPage = screen(admin, (m) => m.RolesPage);
const AuditPage = screen(admin, (m) => m.AuditPage);
const CommoditiesPage = screen(admin, (m) => m.CommoditiesPage);
const SettingsPage = screen(admin, (m) => m.SettingsPage);
const auth = () => import("@/pages/Auth.tsx");
const SignupPage = screen(auth, (m) => m.SignupPage);
const LoginPage = screen(auth, (m) => m.LoginPage);

/** The other screens, fetched one at a time while nothing else is going on. */
function useFetchScreensWhenIdle(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const idle = (fn: () => void) => {
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 5000 });
      else setTimeout(fn, 200);
    };
    let i = 0;
    const next = () => {
      if (stop || i >= loaders.length) return;
      loaders[i++]().catch(() => undefined).finally(() => { if (!stop) idle(next); });
    };
    // not before the first screen is drawn (nothing on it still loading), so it never slows that down
    const since = Date.now();
    let timer = 0;
    const wait = () => {
      if (stop) return;
      if (document.querySelector('[aria-busy="true"]') && Date.now() - since < 30_000) { timer = window.setTimeout(wait, 1000); return; }
      idle(next);
    };
    timer = window.setTimeout(wait, 2000);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [ready]);
}

/** While a screen's file arrives: nothing for a moment (it is usually quick), then a small spinner. */
function ScreenLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => { const id = window.setTimeout(() => setShow(true), 250); return () => window.clearTimeout(id); }, []);
  return <div className="flex justify-center py-16">{show && <Spinner className="h-5 w-5" />}</div>;
}

/** The dashboard, or — for a role without it — the first screen the role may open. */
function Home() {
  const { can } = useSession();
  const { t } = useI18n();
  if (can("dashboard.view")) return <DashboardPage />;
  const first = ([
    ["/daily", "slip.read"], ["/scan", "scan.create"], ["/loads", "load.read"], ["/stock", "stock.read"],
    ["/ledger", "ledger.read"], ["/payments", "payment.read"], ["/suppliers", "adati.read"], ["/settings", "business.read"],
  ] as const).find(([, p]) => can(p));
  if (first) return <Redirect to={first[0]} />;
  return <Card><EmptyState icon={<ShieldAlert className="h-5 w-5" />} title={t("err.noPermission")} sub={t("err.askOwner")} /></Card>;
}

function AddBusinessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", nameHi: "", shortCode: "" });
  const [err, setErr] = useState<string | null>(null);

  // a cancelled dialog opens empty next time
  const close = () => { setF({ name: "", nameHi: "", shortCode: "" }); setErr(null); onClose(); };
  const m = useMutation({
    mutationFn: () => api.post("/auth/businesses", {
      name: f.name, nameHi: f.nameHi || undefined, shortCode: f.shortCode,
    }),
    onSuccess: async () => { await qc.invalidateQueries(); close(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={close} title={t("biz.add")} sub={t("biz.addSub")}
      footer={<>
        <Button onClick={close}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={m.isPending}
          disabled={!f.name.trim() || !f.shortCode.trim()}
          onClick={() => { setErr(null); m.mutate(); }}>{t("common.add")}</Button>
      </>}>
      <div className="space-y-4">
        {err && <Alert tone="bad">{err}</Alert>}
        <Field label={t("auth.businessName")} required>
          <Input value={f.name} autoFocus placeholder="V C Enterprise"
            onChange={(e) => {
              const name = e.target.value;
              setF((p) => ({
                ...p, name,
                shortCode: p.shortCode || name.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 5),
              }));
            }} />
        </Field>
        <Field label={t("auth.businessNameHi")}>
          <HindiInput value={f.nameHi} onChange={(v) => setF((p) => ({ ...p, nameHi: v }))} />
        </Field>
        <Field label={t("auth.shortCode")} hint={t("auth.shortCodeHelp")} required>
          <Input value={f.shortCode} mono className="uppercase" maxLength={12}
            onChange={(e) => setF((p) => ({ ...p, shortCode: e.target.value.toUpperCase() }))} />
        </Field>
      </div>
    </Dialog>
  );
}

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useSession();
  const { t } = useI18n();
  if (can(perm)) return <>{children}</>;
  return (
    <Card>
      <EmptyState icon={<ShieldAlert className="h-8 w-8" />}
        title={t("err.noPermission")} sub={t("err.noPermissionSub", { perm })} />
    </Card>
  );
}

export default function App() {
  const { t } = useI18n();
  const { me, loading, error, refresh } = useSession();
  const [addBiz, setAddBiz] = useState(false);
  const [location] = useLocation();
  useFetchScreensWhenIdle(Boolean(me));

  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api.get<{ needsSignup: boolean }>("/auth/bootstrap"),
    enabled: !me,
    // no books to open (the server says why): shown at once, not after retries
    retry: (n, e) => !(e instanceof ApiError && e.code === "books_unavailable") && n < 1,
  });

  // no books could be opened (damaged or missing, and no good backup): the reason, plainly, and nothing else
  const down = [error, bootstrap.error].find((e): e is ApiError => e instanceof ApiError && e.code === "books_unavailable");
  if (down) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="max-w-md">
          <EmptyState icon={<ShieldAlert className="h-8 w-8" />} title={down.message} />
        </Card>
      </div>
    );
  }
  if (error || (bootstrap.isError && !me)) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="max-w-sm">
          <EmptyState icon={<WifiOff className="h-8 w-8" />}
            title={t("err.offline")} sub={t("err.offlineSub")}
            action={<Button variant="primary" onClick={() => { refresh(); bootstrap.refetch(); }}>{t("common.retry")}</Button>} />
        </Card>
      </div>
    );
  }

  if (loading || (bootstrap.isLoading && !me)) return <SkeletonShell />;
  if (!me) return <Suspense fallback={<SkeletonShell />}>{bootstrap.data?.needsSignup ? <SignupPage /> : <LoginPage />}</Suspense>;

  return (
    <>
      <AppShell onAddBusiness={() => setAddBiz(true)}>
        <ErrorBoundary
          // another business is a fresh start for every screen: no ids or filters carry over
          key={`${me.activeBusinessId}|${location}`}
          fallbackTitle={t("err.crashed")}
          fallbackSub={t("err.crashedSub")}
          reloadLabel={t("err.reload")}
        >
        <Suspense fallback={<ScreenLoading />}>
        <RouteSwitch>
          <Route path="/" component={Home} />
          <Route path="/scan">{() => <Guard perm="scan.create"><ScanListPage /></Guard>}</Route>
          <Route path="/scan/:id">{(p) => <Guard perm="scan.review"><ScanReviewPage scanId={p.id} /></Guard>}</Route>
          <Route path="/sheets">{() => <Guard perm="scan.create"><SheetsPage /></Guard>}</Route>
          <Route path="/daily">{() => <Guard perm="slip.read"><DailyListPage /></Guard>}</Route>
          <Route path="/orders">{() => <Guard perm="po.read"><OrdersPage /></Guard>}</Route>
          <Route path="/loads">{() => <Guard perm="load.read"><LoadsPage /></Guard>}</Route>
          <Route path="/loads/:id">{(p) => <Guard perm="load.read"><LoadDetailPage id={p.id} /></Guard>}</Route>
          <Route path="/challan">{() => <Guard perm="load.read"><ChallanPage /></Guard>}</Route>
          <Route path="/parcha">{() => <Guard perm="parcha.read"><ParchaRegisterPage /></Guard>}</Route>
          <Route path="/stock">{() => <Guard perm="stock.read"><StockPage /></Guard>}</Route>
          <Route path="/stock/:mill">{(p) => <Guard perm="stock.read"><MillAccountPage id={p.mill} /></Guard>}</Route>
          <Route path="/ledger">{() => <Guard perm="ledger.read"><LedgerPage /></Guard>}</Route>
          <Route path="/payments">{() => <Guard perm="payment.read"><PaymentsPage /></Guard>}</Route>
          <Route path="/mill-accounts">{() => <Guard perm="millledger.read"><MillLedgerPage /></Guard>}</Route>
          <Route path="/tally">{() => <Guard perm="millledger.read"><TallyPage /></Guard>}</Route>
          <Route path="/day-close">{() => <Guard perm="slip.read"><DayClosePage /></Guard>}</Route>
          <Route path="/mill-followup">{() => <Guard perm="millledger.read"><MillFollowupPage /></Guard>}</Route>
          <Route path="/mill-accounts/:id">{(p) => <Guard perm="millledger.read"><MillStatementPage id={p.id} /></Guard>}</Route>
          <Route path="/suppliers">{() => <Guard perm="adati.read"><SuppliersPage /></Guard>}</Route>
          <Route path="/mills">{() => <Guard perm="merchant.read"><MillsPage /></Guard>}</Route>
          <Route path="/commodities">{() => <Guard perm="jins.read"><CommoditiesPage /></Guard>}</Route>
          <Route path="/users">{() => <Guard perm="users.read"><UsersPage /></Guard>}</Route>
          <Route path="/roles">{() => <Guard perm="roles.manage"><RolesPage /></Guard>}</Route>
          <Route path="/audit">{() => <Guard perm="audit.read"><AuditPage /></Guard>}</Route>
          <Route path="/settings">{() => <Guard perm="business.read"><SettingsPage /></Guard>}</Route>
          <Route>
            <Card>
              <EmptyState title={t("err.pageNotFound")} sub={t("err.pageNotFoundSub")}
                action={<Link href="/"><Button>{t("err.goHome")}</Button></Link>} />
            </Card>
          </Route>
        </RouteSwitch>
        </Suspense>
        </ErrorBoundary>
      </AppShell>
      <AddBusinessDialog open={addBiz} onClose={() => setAddBiz(false)} />
    </>
  );
}
