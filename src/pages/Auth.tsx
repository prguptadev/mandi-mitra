import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Wheat, Sun, Moon, Languages, ArrowRight, Delete } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useTheme } from "@/lib/theme.tsx";
import { Button, Field, Input, Alert, Card, Spinner } from "@/components/ui/index.tsx";
import { HindiInput } from "@/components/HindiInput.tsx";
import { cn } from "@/lib/utils.ts";

function AuthChrome({ children }: { children: React.ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { resolved, cycle } = useTheme();
  return (
    <div className="flex min-h-full flex-col bg-bg">
      <div className="flex items-center justify-end gap-1 p-3">
        <Button variant="ghost" size="sm" onClick={() => setLang(lang === "en" ? "hi" : "en")} icon={<Languages className="h-4 w-4" />}>
          {lang === "en" ? "हिन्दी" : "English"}
        </Button>
        <Button variant="ghost" size="icon" onClick={cycle} aria-label={t("common.theme")}>
          {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand text-brand-ink shadow-card">
              <Wheat className="h-6 w-6" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">{t("app.name")}</h1>
            <p className="mt-0.5 text-[13px] text-muted">{t("app.tagline")}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ signup */

export function SignupPage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: "", nameHi: "", phone: "", pin: "", pin2: "",
    businessName: "", businessNameHi: "", shortCode: "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  // auto-suggest a short code from the business name initials
  useEffect(() => {
    if (f.shortCode) return;
    const initials = f.businessName.trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 5);
    if (initials.length >= 2) setF((p) => ({ ...p, shortCode: initials }));
  }, [f.businessName]);

  const m = useMutation({
    mutationFn: () => api.post("/auth/signup", {
      name: f.name, nameHi: f.nameHi || undefined, phone: f.phone || undefined,
      pin: f.pin, businessName: f.businessName,
      businessNameHi: f.businessNameHi || undefined, shortCode: f.shortCode,
    }),
    onSuccess: async () => { await qc.invalidateQueries(); },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
      setField(e instanceof ApiError ? e.field ?? null : null);
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setField(null);
    if (f.pin !== f.pin2) { setErr(t("auth.pinMismatch")); setField("pin"); return; }
    m.mutate();
  };

  return (
    <AuthChrome>
      <Card>
        <form onSubmit={submit} className="space-y-5 p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">{t("auth.setupTitle")}</h2>
            <p className="mt-0.5 text-xs text-muted">{t("auth.setupSub")}</p>
          </div>

          {err && <Alert tone="bad">{err}</Alert>}

          <div className="space-y-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t("auth.welcome")}</p>
            <Field label={t("auth.yourName")} required htmlFor="name">
              <Input id="name" value={f.name} onChange={set("name")} required autoFocus autoComplete="name" invalid={field === "name"} />
            </Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label={t("auth.yourNameHi")} hint={t("common.optional")}>
                <HindiInput value={f.nameHi} publicOnly
                  onChange={(v) => setF((p) => ({ ...p, nameHi: v }))} placeholder="vijay kumar" />
              </Field>
              <Field label={t("auth.phone")} hint={t("common.optional")}>
                <Input value={f.phone} onChange={set("phone")} inputMode="tel" mono autoComplete="tel" />
              </Field>
            </div>
          </div>

          <div className="space-y-3.5 border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t("biz.profile")}</p>
            <Field label={t("auth.businessName")} required>
              <Input value={f.businessName} onChange={set("businessName")} required placeholder="Vijay Laxmi Dal Mill" invalid={field === "businessName"} />
            </Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label={t("auth.businessNameHi")} hint={t("common.optional")}>
                <HindiInput value={f.businessNameHi} publicOnly
                  onChange={(v) => setF((p) => ({ ...p, businessNameHi: v }))} placeholder="vijay laxmi dal mill" />
              </Field>
              <Field label={t("auth.shortCode")} hint={t("auth.shortCodeHelp")} required>
                <Input value={f.shortCode} onChange={(e) => setF((p) => ({ ...p, shortCode: e.target.value.toUpperCase() }))}
                  required maxLength={12} mono className="uppercase" invalid={field === "shortCode"} />
              </Field>
            </div>
          </div>

          <div className="space-y-3.5 border-t border-line pt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t("auth.pin")}</p>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label={t("auth.pin")} hint={t("auth.pinHelp")} required>
                <Input value={f.pin} onChange={set("pin")} required type="password" inputMode="numeric"
                  pattern="\d{4,6}" maxLength={6} mono autoComplete="new-password" invalid={field === "pin"} />
              </Field>
              <Field label={t("auth.pinAgain")} required>
                <Input value={f.pin2} onChange={set("pin2")} required type="password" inputMode="numeric"
                  maxLength={6} mono autoComplete="new-password" invalid={field === "pin"} />
              </Field>
            </div>
          </div>

          <Button type="submit" variant="primary" size="lg" loading={m.isPending} className="w-full justify-center">
            {t("auth.createAccount")} <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      </Card>
    </AuthChrome>
  );
}

/* ------------------------------------------------------------------- login */

export function LoginPage() {
  const { t, pick } = useI18n();
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  const users = useQuery({
    queryKey: ["auth", "users"],
    queryFn: () => api.get<{ id: string; name: string; nameHi: string | null }[]>("/auth/users"),
  });

  useEffect(() => {
    if (users.data?.length === 1 && !userId) setUserId(users.data[0].id);
  }, [users.data]);

  useEffect(() => { if (userId) pinRef.current?.focus(); }, [userId]);

  const m = useMutation({
    mutationFn: () => api.post("/auth/login", { userId, pin }),
    onSuccess: async () => { await qc.invalidateQueries(); },
    onError: (e) => {
      setErr(e instanceof ApiError ? e.message : t("common.somethingWrong"));
      setPin("");
      pinRef.current?.focus();
    },
  });

  const submit = (e: React.FormEvent) => { e.preventDefault(); setErr(null); m.mutate(); };
  const selected = users.data?.find((u) => u.id === userId);

  if (users.isLoading) {
    return <AuthChrome><Card><div className="flex items-center justify-center p-10"><Spinner className="h-5 w-5" /></div></Card></AuthChrome>;
  }

  return (
    <AuthChrome>
      <Card>
        <div className="p-5">
          {!userId ? (
            <>
              <h2 className="mb-3 text-[15px] font-semibold text-ink">{t("auth.whoAreYou")}</h2>
              <div className="space-y-1.5">
                {users.data?.map((u) => (
                  <button
                    key={u.id} type="button" onClick={() => setUserId(u.id)}
                    className="flex w-full items-center gap-3 rounded-lg border border-line px-3 py-2.5 text-left transition-colors hover:bg-raised"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/12 text-[13px] font-semibold text-brand">
                      {u.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{pick(u.name, u.nameHi)}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-faint" />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand/12 text-sm font-semibold text-brand">
                  {selected?.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">{pick(selected?.name, selected?.nameHi)}</p>
                  <p className="text-xs text-muted">{t("auth.enterPin")}</p>
                </div>
                {(users.data?.length ?? 0) > 1 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setUserId(null); setPin(""); setErr(null); }}>
                    {t("auth.switchUser")}
                  </Button>
                )}
              </div>

              {err && <Alert tone="bad">{err}</Alert>}

              <Input
                ref={pinRef} value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                type="password" inputMode="numeric" autoComplete="current-password"
                maxLength={6} required
                className="h-14 text-center text-2xl tracking-[0.5em] num"
                aria-label={t("auth.pin")}
              />

              {/* keypad — this runs on a desk machine with no numpad half the time */}
              <div className="grid grid-cols-3 gap-2">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                  <Button key={d} type="button" variant="subtle" size="lg"
                    className="justify-center num text-base"
                    onClick={() => setPin((p) => (p + d).slice(0, 6))}>{d}</Button>
                ))}
                <Button type="button" variant="ghost" size="lg" className="justify-center" onClick={() => setPin("")}>
                  {t("common.cancel")}
                </Button>
                <Button type="button" variant="subtle" size="lg" className="justify-center num text-base"
                  onClick={() => setPin((p) => (p + "0").slice(0, 6))}>0</Button>
                <Button type="button" variant="subtle" size="lg" className="justify-center"
                  onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Backspace">
                  <Delete className="h-4 w-4" />
                </Button>
              </div>

              <Button type="submit" variant="primary" size="lg" loading={m.isPending}
                disabled={pin.length < 4} className="w-full justify-center">
                {t("auth.signIn")} <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          )}
        </div>
      </Card>
    </AuthChrome>
  );
}
