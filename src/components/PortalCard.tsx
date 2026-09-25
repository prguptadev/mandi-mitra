import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Landmark, Trash2, RefreshCw, Search } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Field, Input } from "@/components/ui/index.tsx";

/* The mandi portal login for THIS business. The two firms have separate
   logins there, so this card follows whichever business is open.

   The password is kept encrypted in this computer's own data folder — not in
   the database — so it never travels with cloud sync or with a backup copied
   to another machine. It is never sent back to this screen. */

interface PortalStatus {
  configured: boolean; user: string; watch: string[];
  firm: string | null; portalLicence: string | null;
  signedIn: boolean; signedInAt: string | null; note: string | null; base: string;
}

export function PortalCard() {
  const { t } = useI18n();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const [user, setUser] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [watch, setWatch] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const q = useQuery({
    queryKey: ["emandi"], queryFn: () => api.get<PortalStatus>("/emandi"),
    enabled: can("business.write"), staleTime: 60_000,
  });
  // the business can be switched under us; forget what was typed for the old one
  useEffect(() => { setUser(null); setPassword(""); setWatch(null); setSaved(false); }, [me?.activeBusinessId]);

  /* The portal's commodity list is read once and kept on this computer, so the
     choice can be made whether or not anyone is signed in just now. */
  const crops = useQuery({
    queryKey: ["emandi", "crops"], queryFn: () => api.get<{ crops: { code: string; name: string }[]; at: string | null }>("/emandi/crops"),
    enabled: can("business.write"), staleTime: 60 * 60_000,
  });
  const reread = useMutation({
    mutationFn: () => api.post<{ crops: { code: string; name: string }[]; at: string }>("/emandi/crops/refresh", {}),
    onSuccess: (r) => { setErr(null); qc.setQueryData(["emandi", "crops"], r); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const [find, setFind] = useState("");

  const save = useMutation({
    mutationFn: () => api.put<PortalStatus>("/emandi", {
      ...(user !== null ? { user: user.trim() } : {}),
      ...(password ? { password } : {}),
      ...(watch !== null ? { watch } : {}),
    }),
    onSuccess: (s) => {
      setErr(null); setPassword(""); setSaved(true);
      qc.setQueryData(["emandi"], s);
      void qc.invalidateQueries({ queryKey: ["emandi", "rates"] });
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  const forget = useMutation({
    mutationFn: () => api.del<PortalStatus>("/emandi"),
    onSuccess: (s) => { setErr(null); setSaved(false); qc.setQueryData(["emandi"], s); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });

  if (!can("business.write")) return null;
  const s = q.data;
  const shownUser = user ?? s?.user ?? "";
  const shownWatch = watch ?? s?.watch ?? [];
  const dirty = user !== null || watch !== null || password.length > 0;
  const list = crops.data?.crops ?? [];
  const needle = find.trim().toLowerCase();
  const shown = needle ? list.filter((c) => c.name.toLowerCase().includes(needle) || c.code.includes(needle)) : list;

  return (
    <Card>
      <CardHeader title={t("portal.cardTitle")} sub={t("portal.cardSub", { firm: me?.business?.name ?? "" })}
        action={s && <Badge tone={s.configured ? (s.signedIn ? "ok" : "brand") : "neutral"}>
          <Landmark className="h-2.5 w-2.5" /> {t(s.signedIn ? "portal.on" : s.configured ? "portal.saved" : "portal.off")}
        </Badge>} />
      <div className="space-y-3 p-4 text-[13px]">
        {err && <Alert tone="bad">{err}</Alert>}
        {saved && !err && <Alert tone="ok">{t("portal.savedNote")}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("portal.user")} hint={t("portal.userHint")}>
            <Input value={shownUser} autoComplete="off" onChange={(e) => { setSaved(false); setUser(e.target.value); }} />
          </Field>
          <Field label={t("portal.password")} hint={s?.configured ? t("portal.passwordKept") : t("portal.passwordHint")}>
            <Input type="password" autoComplete="new-password" value={password}
              placeholder={s?.configured ? "••••••••" : ""}
              onChange={(e) => { setSaved(false); setPassword(e.target.value); }} />
          </Field>
        </div>

        {/* Whose licence this login is, in the portal's own words. A mill's
            licence carries no rate band; an arhat's does — so it is worth
            seeing which one is saved here. */}
        {s?.firm && (
          <p className="text-[12px] text-muted">
            {t("portal.whose")} <span className="font-medium text-ink">{s.firm}</span>
            {s.portalLicence && <span className="num ml-1.5 text-faint">{s.portalLicence}</span>}
          </p>
        )}

        <div className="rounded-lg border border-line bg-raised/30 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-medium text-ink">{t("portal.watch")}</p>
            <Badge tone={shownWatch.length ? "brand" : "neutral"}>{t("portal.watchCount", { n: shownWatch.length })}</Badge>
            <Button size="sm" variant="ghost" className="ml-auto" icon={<RefreshCw className="h-3.5 w-3.5" />}
              loading={reread.isPending} onClick={() => reread.mutate()}>{t("portal.cropsAgain")}</Button>
          </div>
          <p className="mb-2 text-[12px] leading-snug text-muted">{t("portal.watchHint")}</p>

          {list.length ? (
            <>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <Input value={find} className="pl-7" placeholder={t("common.search")} onChange={(e) => setFind(e.target.value)} />
              </div>
              <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border border-line/70 p-1.5">
                {shown.map((c) => (
                  <label key={c.code} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-raised">
                    <Checkbox checked={shownWatch.includes(c.code)}
                      onChange={(on: boolean) => {
                        setSaved(false);
                        setWatch(on ? [...shownWatch, c.code] : shownWatch.filter((x) => x !== c.code));
                      }} />
                    <span lang="hi" className="flex-1 text-[14px] text-ink">{c.name}</span>
                    <span className="num text-[11px] text-faint">#{c.code}</span>
                  </label>
                ))}
                {!shown.length && <p className="px-1.5 py-1 text-[12px] text-faint">{t("portal.cropsNoMatch")}</p>}
              </div>
            </>
          ) : (
            <p className="text-[12px] text-faint">{t("portal.cropsNotYet")}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!dirty || !shownUser.trim()} loading={save.isPending}
            onClick={() => save.mutate()}>{t("common.save")}</Button>
          {s?.configured && (
            <Button variant="ghost" icon={<Trash2 className="h-3.5 w-3.5 text-bad/80" />} loading={forget.isPending}
              onClick={() => forget.mutate()}>{t("portal.forget")}</Button>
          )}
        </div>

        <p className="text-[11px] leading-snug text-faint">{t("portal.cardNote")}</p>
      </div>
    </Card>
  );
}
