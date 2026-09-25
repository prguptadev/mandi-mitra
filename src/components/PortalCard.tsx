import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Landmark, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select } from "@/components/ui/index.tsx";

/* The mandi portal login for THIS business. The two firms have separate
   logins there, so this card follows whichever business is open.

   The password is kept encrypted in this computer's own data folder — not in
   the database — so it never travels with cloud sync or with a backup copied
   to another machine. It is never sent back to this screen. */

interface PortalStatus {
  configured: boolean; user: string; licence: string; watch: string[];
  signedIn: boolean; signedInAt: string | null; note: string | null; base: string;
}

export function PortalCard() {
  const { t } = useI18n();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const [user, setUser] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [licence, setLicence] = useState<string | null>(null);
  const [watch, setWatch] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const q = useQuery({
    queryKey: ["emandi"], queryFn: () => api.get<PortalStatus>("/emandi"),
    enabled: can("business.write"), staleTime: 60_000,
  });
  // the business can be switched under us; forget what was typed for the old one
  useEffect(() => { setUser(null); setPassword(""); setLicence(null); setWatch(null); setSaved(false); }, [me?.activeBusinessId]);

  const crops = useQuery({
    queryKey: ["emandi", "crops"], queryFn: () => api.get<{ code: string; name: string }[]>("/emandi/crops"),
    enabled: Boolean(q.data?.signedIn), staleTime: 60 * 60_000, retry: false,
  });

  const save = useMutation({
    mutationFn: () => api.put<PortalStatus>("/emandi", {
      ...(user !== null ? { user: user.trim() } : {}),
      ...(password ? { password } : {}),
      ...(licence !== null ? { licence: licence.trim() } : {}),
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
  const shownLicence = licence ?? s?.licence ?? "";
  const shownWatch = watch ?? s?.watch ?? [];
  const dirty = user !== null || licence !== null || watch !== null || password.length > 0;

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
          <Field label={t("portal.licence")} hint={t("portal.licenceHint")}>
            <Input value={shownLicence} className="num" onChange={(e) => { setSaved(false); setLicence(e.target.value); }} />
          </Field>
          <Field label={t("portal.watch")} hint={t("portal.watchHint")}>
            {crops.data?.length ? (
              <Select value={shownWatch[0] ?? ""} onChange={(e) => { setSaved(false); setWatch(e.target.value ? [e.target.value] : []); }}>
                <option value="">{t("portal.watchNone")}</option>
                {crops.data.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </Select>
            ) : (
              <Input value={shownWatch.join(", ")} className="num" placeholder="1, 6"
                onChange={(e) => { setSaved(false); setWatch(e.target.value.split(",").map((x) => x.trim()).filter(Boolean)); }} />
            )}
          </Field>
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
