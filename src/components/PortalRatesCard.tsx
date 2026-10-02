import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Landmark, RefreshCw, LogIn, LogOut } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useSession } from "@/lib/session.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from "@/components/ui/index.tsx";
import { cn, sameFirm, licenceKey } from "@/lib/utils.ts";
import { emandiKey, emandiPath, isBusinessChanged, ownReply, putStatus } from "@/lib/emandiKeys.ts";
import type { StringKey } from "@/lib/strings.ts";

/* The mandi portal's own rate band for the commodities this firm watches, and
   the stock e-Mandi holds on this firm's licence. The portal states a lowest
   and a highest rate per commodity, with the mandi fee and development cess
   as percentages — that band is what a 6R rate has to sit inside, so it is
   worth seeing before the day is priced.

   Signing in needs the portal's captcha, which a person reads: the image is
   shown here and nothing tries to read it for them.

   What the card says always follows what the server last learnt: every reply
   carries the session's status, and the status itself is asked again every
   minute — so a session e-Mandi has ended turns into a "Sign in" button by
   itself, instead of a "Signed in" badge over rates that no longer come. */

export interface PortalStatus {
  /** The business this status is for; a screen keeps it only under that business. */
  businessId: string;
  configured: boolean; passwordUnreadable: boolean; user: string; watch: string[];
  firm: string | null; portalLicence: string | null;
  signedIn: boolean; signedInAt: string | null; checkedAt: string | null;
  noteCode: string | null; note: string | null;
  refused: { code: string; said: string | null } | null;
  storeNote: "store_restored" | "store_lost" | null; base: string;
}
interface StockLine { cropCode: string; crop: string; inGrams: number | null; outGrams: number | null; leftGrams: number | null; rows: number }
interface StockReply { lines: StockLine[]; licence: string; from: string; to: string; at: string; status: PortalStatus }
interface Rate {
  cropCode: string; cropName: string | null;
  minRatePaise: number | null; maxRatePaise: number | null;
  mandiFeePct: number | null; developmentCessPct: number | null;
  onMandiSthal: boolean | null; directLicence: boolean | null;
  at: string; said: string | null; error: string | null; code: string | null;
}
interface RatesReply { rates: Rate[]; problem: { code: string; error: string; said: string | null } | null; status: PortalStatus; at: string }

/** A portal message in the chosen language, from its code; the server's English only for a code this screen does not know. */
export function usePortalSay() {
  const { t } = useI18n();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : typeof e === "string" ? e : null;
    const key = `portal.err.${code}` as StringKey;
    const said = code ? t(key) : key;
    if (said !== key) return said;
    return e instanceof ApiError ? e.message : t("common.somethingWrong");
  };
}

/* Everything read with one login is dropped the moment the login changes, so
   nothing read for one licence is ever drawn under another. */
export const dropPortalReadings = (qc: ReturnType<typeof useQueryClient>, biz: string | null) => {
  qc.removeQueries({ queryKey: emandiKey(biz, "rates") });
  qc.removeQueries({ queryKey: emandiKey(biz, "stock") });
};

/* The figures a session problem stops: shown once above the table, not on every row. */
const STOPS = new Set(["signed_out", "ended", "offline", "slow", "portal_error", "store_busy", "other_licence"]);

/* The card belongs to the business open: switching business starts it afresh,
   so nothing typed, shown or said for one firm stays on screen for the other. */
export function PortalRatesCard() {
  const { me } = useSession();
  const biz = me?.activeBusinessId ?? null;
  return <RatesCard key={biz ?? ""} bizId={biz} />;
}

function RatesCard({ bizId }: { bizId: string | null }) {
  const { t, lang } = useI18n();
  const f = useFormat();
  const { can, me, refresh: refreshMe } = useSession();
  const qc = useQueryClient();
  const ask = useConfirm();
  const say = usePortalSay();
  const [captcha, setCaptcha] = useState("");
  const [shown, setShown] = useState<{ image: string; ticket: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Whether `err` is e-Mandi refusing a sign-in — only then are its own words shown under it. */
  const [errIsRefusal, setErrIsRefusal] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  /** The portal firm the operator said is not theirs — until the login changes. */
  const [notOurs, setNotOurs] = useState<string | null>(null);
  /* The login can be added here as well as in Settings — the operator is on
     this screen when they notice the rates are missing. */
  const [user, setUser] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const status = useQuery({
    queryKey: emandiKey(bizId), queryFn: async () => ownReply(bizId, await api.get<PortalStatus>(emandiPath(bizId, "/emandi"))),
    enabled: can("dashboard.view") && Boolean(bizId), staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true,
    retry: (n, e) => !isBusinessChanged(e) && n < 3,
  });
  const s = status.data;
  const biz = me?.business ?? null;
  const here = biz?.name ?? "";

  /* Whose login this is: by licence when this firm has one on record, else by
     name. A login that is another firm's reads nothing here; one the names
     cannot place is asked about once, and its stock waits for the answer. */
  const firm = s?.signedIn ? sameFirm({ firm: s.firm, licence: s.portalLicence }, { name: biz?.name, nameHi: biz?.nameHi, licence: biz?.mandiLicense }) : null;
  const whoKey = `${s?.firm ?? ""}|${s?.portalLicence ?? ""}`;
  const blocked = firm?.match === "different" || notOurs === whoKey;
  /* Asked once e-Mandi has said whose licence it is, so "yes" can settle it.
     Until then no stock is drawn either way: reading it is what learns the
     licence, and the reply that brings the licence brings the question. */
  const asking = !blocked && firm?.match === "unknown" && Boolean(s?.portalLicence);
  const readRates = Boolean(s?.signedIn) && !blocked;
  const readStock = readRates && !asking;

  const rates = useQuery({
    queryKey: emandiKey(bizId, "rates"),
    queryFn: async () => {
      const r = await api.get<RatesReply>(emandiPath(bizId, "/emandi/rates"));
      ownReply(bizId, r.status);
      putStatus(qc, bizId, r.status); // a session found ended turns the card to "Sign in" now
      // the first rates after a sign-in read the commodity list too; Settings should see it
      void qc.invalidateQueries({ queryKey: emandiKey(bizId, "crops") });
      return r;
    },
    enabled: readRates, staleTime: 5 * 60_000, retry: false,
  });

  /* e-Mandi's own stock for this licence, beside the band. It is asked for
     under the licence it belongs to, and lines read for any other licence are
     never drawn. */
  const stock = useQuery({
    queryKey: emandiKey(bizId, "stock", licenceKey(s?.portalLicence)),
    queryFn: async () => {
      try {
        const r = await api.get<StockReply>(emandiPath(bizId, "/emandi/stock"));
        ownReply(bizId, r.status);
        // filed under the licence it was read for, so learning the licence just now does not read it twice
        qc.setQueryData(emandiKey(bizId, "stock", licenceKey(r.licence)), r);
        putStatus(qc, bizId, r.status);
        return r;
      } catch (e) {
        if (e instanceof ApiError && (e.code === "ended" || e.code === "signed_out")) void qc.invalidateQueries({ queryKey: emandiKey(bizId), exact: true });
        throw e;
      }
    },
    enabled: readStock, staleTime: 5 * 60_000, retry: false,
  });

  // a reply for a business switched away from is not said here
  const fail = (e: unknown) => { if (isBusinessChanged(e)) return; setInfo(null); setErr(say(e)); setErrIsRefusal(false); };

  const addLogin = useMutation({
    mutationFn: () => api.put<PortalStatus>(emandiPath(bizId, "/emandi"), { user: (user ?? s?.user ?? "").trim(), password }),
    onSuccess: (st) => {
      if (!putStatus(qc, bizId, st)) return;
      setErr(null); setPassword("");
      dropPortalReadings(qc, bizId);
      start.mutate({}); // straight on to the captcha: that is what they came for
    },
    onError: fail,
  });

  const start = useMutation({
    mutationFn: (_v: { keepErr?: boolean }) =>
      api.post<{ image: string; ticket: string } | { already: true; status: PortalStatus }>(emandiPath(bizId, "/emandi/signin/start"), {}),
    onSuccess: (r, v) => {
      if ("already" in r && !putStatus(qc, bizId, r.status)) return;
      if (!v.keepErr) setErr(null);
      setCaptcha("");
      if ("already" in r) {
        // someone else signed in meanwhile, or the session never ended: no captcha needed
        setShown(null); setErr(null); setInfo(t("portal.already"));
        void qc.invalidateQueries({ queryKey: emandiKey(bizId, "rates") });
        return;
      }
      setInfo(null);
      setShown({ image: r.image, ticket: r.ticket });
    },
    onError: (e, v) => { if (!v.keepErr) fail(e); setShown(null); },
  });
  const finish = useMutation({
    mutationFn: () => api.post<PortalStatus>(emandiPath(bizId, "/emandi/signin/finish"), { captcha, ticket: shown?.ticket }),
    onSuccess: (st) => {
      if (!putStatus(qc, bizId, st)) return;
      setErr(null); setInfo(null); setShown(null); setCaptcha(""); setNotOurs(null);
      dropPortalReadings(qc, bizId);
      void qc.invalidateQueries({ queryKey: emandiKey(bizId, "crops") });
    },
    onError: (e) => {
      if (isBusinessChanged(e)) return;
      fail(e);
      setCaptcha("");
      const code = e instanceof ApiError ? e.code : null;
      // e-Mandi's own words come with the status; they belong under a refusal only, not under "replaced" or "slow"
      setErrIsRefusal(code === "captcha" || code === "credentials" || code === "denied");
      void qc.invalidateQueries({ queryKey: emandiKey(bizId), exact: true });
      /* A captcha is good for one try. Put a fresh one up straight away, so
         the next attempt is just typing — unless no captcha can help. */
      if (code !== "no_account" && code !== "password_unreadable") start.mutate({ keepErr: true });
      else setShown(null);
    },
  });

  /* Refresh looks at the session first (landing on /Traders/index, which is
     what makes e-Mandi give a band), then reads the rates and the stock again. */
  const refresh = useMutation({
    mutationFn: () => api.post<PortalStatus>(emandiPath(bizId, "/emandi/check"), {}),
    onSuccess: (st) => {
      if (!putStatus(qc, bizId, st)) return;
      setErr(null); setInfo(null);
      void qc.invalidateQueries({ queryKey: emandiKey(bizId, "rates") });
      void qc.invalidateQueries({ queryKey: emandiKey(bizId, "stock") });
    },
    onError: (e) => { fail(e); void qc.invalidateQueries({ queryKey: emandiKey(bizId), exact: true }); },
  });

  const signOut = useMutation({
    mutationFn: () => api.post<PortalStatus>(emandiPath(bizId, "/emandi/signout"), {}),
    onSuccess: (st) => {
      if (!putStatus(qc, bizId, st)) return;
      setErr(null); setInfo(null); setShown(null); dropPortalReadings(qc, bizId);
    },
    onError: fail,
  });
  const askSignOut = async () => {
    if (await ask({ title: t("portal.signOutAsk"), message: t("portal.signOutNote"), confirmLabel: t("portal.signOutYes") })) signOut.mutate();
  };

  // "Yes, this login is ours": its licence goes on the firm, and from then on the check is exact
  const confirmOurs = useMutation({
    mutationFn: () => api.put("/business/current", { mandiLicense: s?.portalLicence ?? "" }),
    onSuccess: async () => { setErr(null); await refreshMe(); },
    onError: fail,
  });

  if (!can("dashboard.view")) return null;

  const storeAlert = s?.storeNote && <Alert tone="warn">{t(s.storeNote === "store_restored" ? "portal.storeRestored" : "portal.storeLost")}</Alert>;

  // nothing set up yet (or the password cannot be read here): the login can be added right here
  if (s && !s.configured) {
    const shownUser = user ?? s.user ?? "";
    if (!can("business.write")) {
      return (
        <Card className="mb-5">
          <CardHeader title={t("portal.title")} sub={t(s.passwordUnreadable ? "portal.err.password_unreadable" : "portal.notSetUp")} />
        </Card>
      );
    }
    return (
      <Card className="mb-5">
        <CardHeader title={t("portal.title")}
          action={<Link href="/settings?tab=business"><Button size="sm" variant="ghost">{t("portal.moreSettings")}</Button></Link>} />
        <div className="space-y-3 p-4">
          {storeAlert}
          {s.passwordUnreadable && !err && <Alert tone="warn">{t("portal.err.password_unreadable")}</Alert>}
          {err && <Alert tone="bad">{err}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("portal.user")} className="min-w-[13rem] flex-1">
              <Input value={shownUser} autoComplete="off" placeholder="name@example.com"
                onChange={(e) => setUser(e.target.value)} />
            </Field>
            <Field label={t("portal.password")} className="min-w-[11rem] flex-1">
              <Input type="password" autoComplete="new-password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && shownUser.trim() && password) addLogin.mutate(); }} />
            </Field>
            <Button variant="primary" className="mb-0.5" disabled={!shownUser.trim() || !password}
              loading={addLogin.isPending || start.isPending} onClick={() => addLogin.mutate()}>
              {t("portal.saveAndSignIn")}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  /* ---- the readings ---- */
  const list = readRates ? rates.data?.rates ?? [] : [];
  const problem = readRates ? rates.data?.problem ?? null : null;
  // lines read for another licence are never drawn, whatever the cache holds
  const stockForeign = Boolean(stock.data && s?.portalLicence && licenceKey(stock.data.licence) !== licenceKey(s.portalLicence));
  const lines = readStock && stock.data && !stockForeign ? stock.data.lines : null;
  // a failed re-read keeps the figures already read on screen, with their time, and says it failed
  const stockState: "off" | "loading" | "error" | "ready" = !readStock ? "off"
    : lines ? "ready" : stock.isError ? "error" : stock.isFetching || stock.isPending ? "loading" : "off";
  const stockOf = new Map((lines ?? []).filter((l) => l.cropCode).map((l) => [l.cropCode, l]));
  const inTable = new Set(list.map((r) => r.cropCode));
  // every commodity e-Mandi holds stock in is shown — the ones without a rate row as stock-only rows
  const extra = (lines ?? []).filter((l) => !l.cropCode || !inTable.has(l.cropCode));
  // "rate not watched" only when it is not; a watched one whose rate failed is not called unwatched
  const watched = new Set([...(s?.watch ?? []), ...inTable]);

  const rupees = (p: number | null) => (p === null ? "—" : f.amount(p));
  /* e-Mandi states quintals to three decimals; shown as stated, from whole
     grams, so in − out = left on screen exactly as it does on the portal. */
  const qtl = (g: number | null | undefined) => {
    if (g == null) return "—";
    const units = Math.floor((Math.abs(g) + 50) / 100); // 0.001 qtl = 100 g
    return `${g < 0 ? "-" : ""}${f.int(Math.floor(units / 1000))}.${String(units % 1000).padStart(3, "0")}`;
  };
  const stockCell = (n: number | null | undefined, strong = false) =>
    stockState === "loading" ? <span className="text-faint">…</span>
      : stockState !== "ready" ? <span className="text-faint">—</span>
      : <span className={cn(n ? (strong ? "font-semibold text-ink" : "text-muted") : "text-faint")}>{qtl(n)}</span>;
  /* The portal states 0.00 for both ends when the mandi has fixed no band. */
  const noBand = (r: Rate) => !r.error && !r.minRatePaise && !r.maxRatePaise;
  const allBandless = list.length > 0 && !problem && list.every(noBand);
  const hhmm = (iso: string | null | undefined) => (iso
    ? new Date(iso).toLocaleTimeString(lang === "hi" ? "hi-IN" : "en-IN", { hour: "2-digit", minute: "2-digit" }) : "—");
  const busy = refresh.isPending || rates.isFetching || stock.isFetching;
  const stockErr = stock.error instanceof ApiError ? stock.error.code ?? null : null;
  const cols = readStock ? 6 : 3;

  return (
    <Card className="mb-5">
      <CardHeader title={t("portal.title")}
        action={
          <span className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone={!s ? "neutral" : s.signedIn ? "ok" : "neutral"} title={s?.checkedAt ? t("portal.checkedAt", { time: hhmm(s.checkedAt) }) : undefined}>
              <Landmark className="h-2.5 w-2.5" /> {!s ? t("portal.checking") : t(s.signedIn ? "portal.on" : "portal.off")}
            </Badge>
            {s?.signedIn ? (
              <>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />}
                  loading={busy} onClick={() => refresh.mutate()}>{t("portal.refreshAll")}</Button>
                <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />}
                  loading={signOut.isPending} onClick={() => void askSignOut()}>{t("portal.signOut")}</Button>
              </>
            ) : s && !shown ? (
              <Button size="sm" variant="secondary" icon={<LogIn className="h-3.5 w-3.5" />}
                loading={start.isPending} onClick={() => start.mutate({})}>{t("portal.signIn")}</Button>
            ) : null}
          </span>
        } />
      <div className="space-y-3 p-4">
        {status.isError && !isBusinessChanged(status.error) && <Alert tone="bad">{say(status.error)}</Alert>}
        {storeAlert}
        {err && (
          <Alert tone="bad">
            {err}
            {errIsRefusal && s?.refused?.said && <span className="mt-1 block text-[12px] opacity-80">{t("portal.said", { said: s.refused.said })}</span>}
          </Alert>
        )}
        {info && !err && <Alert tone="ok">{info}</Alert>}
        {s?.noteCode && !err && s.noteCode !== problem?.code && <Alert tone="warn">{say(s.noteCode)}</Alert>}

        {s?.signedIn && firm && (firm.match === "different" && firm.by === "licence" ? (
          <Alert tone="warn">{t("portal.wrongLicence", { portal: s.firm ?? "—", pl: s.portalLicence ?? "—", here, hl: biz?.mandiLicense ?? "—" })}</Alert>
        ) : blocked ? (
          <Alert tone="warn">{t("portal.wrongFirm", { portal: s.firm ?? "—", here })}</Alert>
        ) : asking ? (
          // a question, not a warning: closing it would leave the rates unexplained
          <Alert tone="brand" closable={false}>
            <p>{t("portal.askWhose", { portal: s.firm ?? s.portalLicence ?? "—", here })}</p>
            {can("business.write") && s.portalLicence ? (
              <>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" loading={confirmOurs.isPending} onClick={() => confirmOurs.mutate()}>{t("portal.askYes", { here })}</Button>
                  <Button size="sm" variant="secondary" onClick={() => setNotOurs(whoKey)}>{t("portal.askNo")}</Button>
                </div>
                <p className="mt-1.5 text-[11px] opacity-80">{t("portal.askYesNote", { licence: s.portalLicence, here })}</p>
              </>
            ) : <p className="mt-1 text-[12px]">{t("portal.askOwner", { here })}</p>}
          </Alert>
        ) : s.firm ? (
          <p className="text-[12px] text-muted">
            {t("portal.whose")} <span className="font-medium text-ink">{s.firm}</span>
            {s.portalLicence && <span className="num ml-1.5 text-faint">{s.portalLicence}</span>}
          </p>
        ) : null)}

        {shown && !s?.signedIn && (
          <div className="rounded-lg border border-line bg-raised/40 p-3">
            <p className="mb-2 text-[13px] text-muted">{t("portal.captchaAsk", { user: s?.user ?? "" })}</p>
            <div className="flex flex-wrap items-end gap-3">
              {/* the captcha just used is dimmed until the new one comes: it cannot be typed again */}
              <img src={shown.image} alt={t("portal.captchaAlt")}
                className={cn("h-11 rounded border border-line bg-white px-1", start.isPending && "opacity-25")} />
              <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={start.isPending}
                onClick={() => start.mutate({})} title={t("portal.captchaAgain")}>{t("portal.captchaNew")}</Button>
              <Field label={t("portal.captchaTyped")} className="w-40">
                <Input value={captcha} className="num" autoFocus inputMode="numeric"
                  onChange={(e) => setCaptcha(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && captcha.trim() && !finish.isPending && !start.isPending) finish.mutate(); }} />
              </Field>
              <Button size="sm" variant="primary" disabled={!captcha.trim() || start.isPending} loading={finish.isPending}
                onClick={() => finish.mutate()}>{t("portal.captchaGo")}</Button>
            </div>
          </div>
        )}

        {readRates && (
          <>
            {problem && <Alert tone="warn">{say(problem.code)}</Alert>}
            {rates.isError && <Alert tone="warn">{t("portal.ratesFailed", { why: say(rates.error) })}</Alert>}
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="min-w-full text-[13px]">
                <thead className="bg-raised/60 text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">{t("daily.jins")}</th>
                    <th className="border-l border-line/70 px-2 py-1.5 text-right font-medium">{t("portal.minRate")}</th>
                    <th className="px-2 py-1.5 text-right font-medium">{t("portal.maxRate")}</th>
                    {readStock && <>
                      <th className="border-l border-line/70 px-2 py-1.5 text-right font-medium">{t("portal.stockIn")}</th>
                      <th className="px-2 py-1.5 text-right font-medium">{t("portal.stockOut")}</th>
                      <th className="px-2 py-1.5 text-right font-medium">{t("portal.stockLeft")}</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const st = stockOf.get(r.cropCode);
                    // a session-wide failure is said once above; the row only shows there is no figure
                    const rowErr = r.error && !STOPS.has(r.code ?? "") ? say(r.code) : null;
                    return (
                      <tr key={r.cropCode} className="border-t border-line/70">
                        <td className="px-2 py-1.5">
                          <span lang="hi" className="text-[14px] text-ink">{r.cropName ?? st?.crop ?? r.cropCode}</span>
                          <span className="num ml-1.5 text-[11px] text-faint">#{r.cropCode}</span>
                        </td>
                        {rowErr ? (
                          <td className="border-l border-line/70 px-2 py-1.5 text-[12px] text-warn" colSpan={2} title={r.said ?? undefined}>{rowErr}</td>
                        ) : r.error || noBand(r) ? (
                          /* e-Mandi answers 0.00 when the mandi has fixed no band —
                             zero is not a price, so it is not shown as one. */
                          <>
                            <td className="num border-l border-line/70 px-2 py-1.5 text-right text-faint">—</td>
                            <td className="num px-2 py-1.5 text-right text-faint">—</td>
                          </>
                        ) : (
                          <>
                            <td className="num border-l border-line/70 px-2 py-1.5 text-right">{rupees(r.minRatePaise)}</td>
                            <td className="num px-2 py-1.5 text-right font-semibold text-brand">{rupees(r.maxRatePaise)}</td>
                          </>
                        )}
                        {readStock && <>
                          <td className="num border-l border-line/70 px-2 py-1.5 text-right">{stockCell(st?.inGrams)}</td>
                          <td className="num px-2 py-1.5 text-right">{stockCell(st?.outGrams)}</td>
                          <td className="num px-2 py-1.5 text-right" title={st && st.rows > 1 ? t("portal.rowsAdded", { n: st.rows }) : undefined}>{stockCell(st?.leftGrams, true)}</td>
                        </>}
                      </tr>
                    );
                  })}
                  {extra.map((l) => (
                    <tr key={l.cropCode || `name:${l.crop}`} className="border-t border-line/70">
                      <td className="px-2 py-1.5">
                        <span lang="hi" className="text-[14px] text-ink">{l.crop || l.cropCode}</span>
                        {l.cropCode && <span className="num ml-1.5 text-[11px] text-faint">#{l.cropCode}</span>}
                        {!watched.has(l.cropCode) && <span className="block text-[11px] text-faint">{t("portal.notWatched")}</span>}
                      </td>
                      <td className="num border-l border-line/70 px-2 py-1.5 text-right text-faint">—</td>
                      <td className="num px-2 py-1.5 text-right text-faint">—</td>
                      <td className="num border-l border-line/70 px-2 py-1.5 text-right">{stockCell(l.inGrams)}</td>
                      <td className="num px-2 py-1.5 text-right">{stockCell(l.outGrams)}</td>
                      <td className="num px-2 py-1.5 text-right" title={l.rows > 1 ? t("portal.rowsAdded", { n: l.rows }) : undefined}>{stockCell(l.leftGrams, true)}</td>
                    </tr>
                  ))}
                  {!list.length && !extra.length && (
                    <tr><td className="px-2 py-2 text-[13px] text-faint" colSpan={cols}>
                      {rates.isFetching ? t("common.loading") : rates.isError || problem ? "—" : t("portal.noneWatched")}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* What the stock line means, said for each of its states — never "no stock" while it is still being read. */}
            {stockState === "loading" && <p className="text-[12px] leading-snug text-muted">{t("portal.stockLoading")}</p>}
            {/* the stock failing for the reason already said above is not said again */}
            {readStock && stock.isError && !(problem && (STOPS.has(stockErr ?? "") || stockErr === problem.code))
              && <p className="text-[12px] leading-snug text-warn">{t("portal.stockFailed", { why: say(stock.error) })}</p>}
            {stockForeign && <p className="text-[12px] leading-snug text-warn">{t("portal.stockOtherLicence")}</p>}
            {asking && <p className="text-[12px] leading-snug text-muted">{t("portal.stockHeld")}</p>}
          </>
        )}

        {readRates && allBandless && (
          <>
            <p className="text-[12px] leading-snug text-muted">{t("portal.noBandAll")}</p>
            {/* When there is no band to show, show what the portal actually
                said, as it came, so nobody has to wonder whether the app
                swallowed a figure. */}
            <p className="num break-all text-[11px] leading-snug text-faint">
              {t("portal.rawSaid")}{" "}
              {list.filter((r) => r.said).slice(0, 3).map((r) => `${r.cropName ?? r.cropCode}: ${r.said}`).join("  ·  ")}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
