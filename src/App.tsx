import { useState } from "react";
import { Route, Switch as RouteSwitch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, WifiOff, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { AppShell } from "@/components/AppShell.tsx";
import { SkeletonShell } from "@/components/Skeletons.tsx";
import { Button, Card, Dialog, Field, Input, Alert, EmptyState } from "@/components/ui/index.tsx";
import { SignupPage, LoginPage } from "@/pages/Auth.tsx";
import { DashboardPage } from "@/pages/Dashboard.tsx";
import { SuppliersPage } from "@/pages/Suppliers.tsx";
import { MillsPage } from "@/pages/Mills.tsx";
import { UsersPage, RolesPage, AuditPage, CommoditiesPage, SettingsPage } from "@/pages/Admin.tsx";

function AddBusinessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", nameHi: "", shortCode: "" });
  const [err, setErr] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => api.post("/auth/businesses", {
      name: f.name, nameHi: f.nameHi || undefined, shortCode: f.shortCode,
    }),
    onSuccess: async () => { await qc.invalidateQueries(); onClose(); setF({ name: "", nameHi: "", shortCode: "" }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t("biz.add")} sub={t("biz.addSub")}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
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
          <Input value={f.nameHi} lang="hi" onChange={(e) => setF((p) => ({ ...p, nameHi: e.target.value }))} />
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

  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api.get<{ needsSignup: boolean }>("/auth/bootstrap"),
    enabled: !me,
    retry: 1,
  });

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
  if (!me) return bootstrap.data?.needsSignup ? <SignupPage /> : <LoginPage />;

  return (
    <>
      <AppShell onAddBusiness={() => setAddBiz(true)}>
        <RouteSwitch>
          <Route path="/" component={DashboardPage} />
          <Route path="/suppliers">{() => <Guard perm="adati.read"><SuppliersPage /></Guard>}</Route>
          <Route path="/mills">{() => <Guard perm="merchant.read"><MillsPage /></Guard>}</Route>
          <Route path="/commodities">{() => <Guard perm="jins.read"><CommoditiesPage /></Guard>}</Route>
          <Route path="/users">{() => <Guard perm="users.read"><UsersPage /></Guard>}</Route>
          <Route path="/roles">{() => <Guard perm="roles.manage"><RolesPage /></Guard>}</Route>
          <Route path="/audit">{() => <Guard perm="audit.read"><AuditPage /></Guard>}</Route>
          <Route path="/settings">{() => <Guard perm="business.read"><SettingsPage /></Guard>}</Route>
          <Route>
            <Card>
              <EmptyState title={t("dash.comingSoon")} sub={t("app.tagline")} />
            </Card>
          </Route>
        </RouteSwitch>
      </AppShell>
      <AddBusinessDialog open={addBiz} onClose={() => setAddBiz(false)} />
    </>
  );
}
