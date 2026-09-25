import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Landmark, RefreshCw, LogIn } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/* The mandi portal's own rate band for the commodities this firm watches.
   The portal states a lowest and a highest rate per commodity, with the mandi
   fee and development cess as percentages — that band is what a 6R rate has
   to sit inside, so it is worth seeing before the day is priced.

   Signing in needs the portal's captcha, which a person reads: the image is
   shown here and nothing tries to read it for them. */

interface PortalStatus {
  configured: boolean; user: string; watch: string[];
  firm: string | null; portalLicence: string | null;
  signedIn: boolean; signedInAt: string | null; note: string | null; base: string;
}
interface Rate {
  cropCode: string; cropName: string | null;
  minRatePaise: number | null; maxRatePaise: number | null;
  mandiFeePct: number | null; developmentCessPct: number | null;
  onMandiSthal: boolean | null; directLicence: boolean | null;
  at: string; error: string | null;
}

export function PortalRatesCard() {
  const { t } = useI18n();
  const f = useFormat();
  const { can } = useSession();
  const qc = useQueryClient();
  const [captcha, setCaptcha] = useState("");
  const [ask, setAsk] = useState<{ image: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /* The login can be added here as well as in Settings — the operator is on
     this screen when they notice the rates are missing. */
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");

  const status = useQuery({
    queryKey: ["emandi"], queryFn: () => api.get<PortalStatus>("/emandi"),
    enabled: can("dashboard.view"), staleTime: 60_000,
  });
  const rates = useQuery({
    queryKey: ["emandi", "rates"], queryFn: () => api.get<{ rates: Rate[]; status: PortalStatus }>("/emandi/rates"),
    enabled: Boolean(status.data?.signedIn), staleTime: 5 * 60_000,
  });

  const addLogin = useMutation({
    mutationFn: () => api.put<PortalStatus>("/emandi", { user: user.trim(), password }),
    onSuccess: (st) => {
      setErr(null); setPassword("");
      qc.setQueryData(["emandi"], st);
      start.mutate(); // straight on to the captcha: that is what they came for
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  const start = useMutation({
    mutationFn: () => api.post<{ image: string; ticket: string }>("/emandi/signin/start", {}),
    onSuccess: (r) => { setErr(null); setCaptcha(""); setAsk({ image: r.image }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const finish = useMutation({
    mutationFn: () => api.post<PortalStatus>("/emandi/signin/finish", { captcha }),
    onSuccess: (s) => {
      setErr(null); setAsk(null); setCaptcha("");
      qc.setQueryData(["emandi"], s);
      void qc.invalidateQueries({ queryKey: ["emandi", "rates"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  if (!can("dashboard.view")) return null;
  const s = status.data;
  // nothing set up yet: the login can be added right here
  if (s && !s.configured) {
    if (!can("business.write")) {
      return (
        <Card className="mb-5">
          <CardHeader title={t("portal.title")} sub={t("portal.notSetUp")} />
        </Card>
      );
    }
    return (
      <Card className="mb-5">
        <CardHeader title={t("portal.title")} sub={t("portal.notSetUp")}
          action={<Link href="/settings?tab=data"><Button size="sm" variant="ghost">{t("portal.moreSettings")}</Button></Link>} />
        <div className="space-y-3 p-4">
          {err && <Alert tone="bad">{err}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("portal.user")} className="min-w-[13rem] flex-1">
              <Input value={user} autoComplete="off" placeholder="name@example.com"
                onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field label={t("portal.password")} className="min-w-[11rem] flex-1">
              <Input type="password" autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && user.trim() && password) addLogin.mutate(); }} />
            </Field>
            <Button variant="primary" className="mb-0.5" disabled={!user.trim() || !password}
              loading={addLogin.isPending || start.isPending} onClick={() => addLogin.mutate()}>
              {t("portal.saveAndSignIn")}
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-faint">{t("portal.cardNote")}</p>
        </div>
      </Card>
    );
  }

  const list = rates.data?.rates ?? [];
  const rupees = (p: number | null) => (p === null ? "—" : f.amount(p));
  /* The portal states 0.00 for both ends when the mandi has fixed no band. */
  const noBand = (r: Rate) => !r.error && !r.minRatePaise && !r.maxRatePaise;
  const allBandless = list.length > 0 && list.every(noBand);


  return (
    <Card className="mb-5">
      <CardHeader title={t("portal.title")} sub={t("portal.sub")}
        action={
          <span className="flex items-center gap-2">
            <Badge tone={s?.signedIn ? "ok" : "neutral"}>
              <Landmark className="h-2.5 w-2.5" /> {t(s?.signedIn ? "portal.on" : "portal.off")}
            </Badge>
            {s?.signedIn ? (
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />}
                loading={rates.isFetching} onClick={() => void rates.refetch()}>{t("portal.refresh")}</Button>
            ) : (
              <Button size="sm" variant="secondary" icon={<LogIn className="h-3.5 w-3.5" />}
                loading={start.isPending} onClick={() => start.mutate()}>{t("portal.signIn")}</Button>
            )}
          </span>
        } />
      <div className="space-y-3 p-4">
        {err && <Alert tone="bad">{err}</Alert>}
        {s?.note && !err && <Alert tone="warn">{s.note}</Alert>}
        {s?.signedIn && s.firm && (
          <p className="text-[12px] text-muted">
            {t("portal.whose")} <span className="font-medium text-ink">{s.firm}</span>
            {s.portalLicence && <span className="num ml-1.5 text-faint">{s.portalLicence}</span>}
          </p>
        )}

        {ask && (
          <div className="rounded-lg border border-line bg-raised/40 p-3">
            <p className="mb-2 text-[13px] text-muted">{t("portal.captchaAsk", { user: s?.user ?? "" })}</p>
            <div className="flex flex-wrap items-end gap-3">
              <img src={ask.image} alt={t("portal.captchaAlt")} className="h-11 rounded border border-line bg-white px-1" />
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={start.isPending}
                onClick={() => start.mutate()} title={t("portal.captchaAgain")} aria-label={t("portal.captchaAgain")} />
              <Field label={t("portal.captchaTyped")} className="w-40">
                <Input value={captcha} className="num" autoFocus inputMode="numeric"
                  onChange={(e) => setCaptcha(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && captcha.trim()) finish.mutate(); }} />
              </Field>
              <Button size="sm" variant="primary" disabled={!captcha.trim()} loading={finish.isPending}
                onClick={() => finish.mutate()}>{t("portal.captchaGo")}</Button>
            </div>
          </div>
        )}

        {s?.signedIn && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="min-w-full text-[13px]">
              <thead className="bg-raised/60 text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{t("daily.jins")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("portal.minRate")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("portal.maxRate")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("portal.mandiFee")}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t("portal.cess")}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.cropCode} className="border-t border-line/70">
                    <td className="px-2 py-1.5">
                      <span lang="hi" className="text-[14px] text-ink">{r.cropName ?? r.cropCode}</span>
                      <span className="num ml-1.5 text-[11px] text-faint">#{r.cropCode}</span>
                    </td>
                    {r.error ? (
                      <td className="px-2 py-1.5 text-[12px] text-warn" colSpan={4}>{r.error}</td>
                    ) : (
                      <>
                        {noBand(r) ? (
                          /* The portal answers 0.00 when the mandi has set no
                             band for this commodity — zero is not a price, so
                             it is not shown as one. */
                          <>
                            <td className="num px-2 py-1.5 text-right text-faint">—</td>
                            <td className="num px-2 py-1.5 text-right text-faint">—</td>
                          </>
                        ) : (
                          <>
                            <td className={cn("num px-2 py-1.5 text-right")}>{rupees(r.minRatePaise)}</td>
                            <td className={cn("num px-2 py-1.5 text-right font-semibold text-brand")}>{rupees(r.maxRatePaise)}</td>
                          </>
                        )}
                        <td className="num px-2 py-1.5 text-right text-muted">{r.mandiFeePct === null ? "—" : `${r.mandiFeePct}%`}</td>
                        <td className="num px-2 py-1.5 text-right text-muted">{r.developmentCessPct === null ? "—" : `${r.developmentCessPct}%`}</td>
                      </>
                    )}
                  </tr>
                ))}
                {!list.length && (
                  <tr><td className="px-2 py-2 text-[13px] text-faint" colSpan={5}>{rates.isFetching ? t("common.loading") : t("portal.noneWatched")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {s?.signedIn && allBandless && <p className="text-[12px] leading-snug text-muted">{t("portal.noBandAll")}</p>}
        <p className="text-[11px] leading-snug text-faint">{t("portal.note")}</p>
      </div>
    </Card>
  );
}
