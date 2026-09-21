import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui/index.tsx";

/** Anyone signed in changes their own PIN here, whatever their role. */
export function MyPinDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [pin, setPin] = useState({ currentPin: "", newPin: "", again: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const change = useMutation({
    mutationFn: () => api.post("/auth/change-pin", { currentPin: pin.currentPin, newPin: pin.newPin }),
    onSuccess: () => { setMsg({ ok: true, text: t("common.saved") }); setPin({ currentPin: "", newPin: "", again: "" }); },
    onError: (e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : t("common.somethingWrong") }),
  });
  const digits = (v: string) => v.replace(/\D/g, "");
  return (
    <Dialog open onClose={onClose} title={t("auth.changePin")}
      footer={<>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={change.isPending}
          disabled={pin.newPin.length < 4 || pin.newPin !== pin.again || !pin.currentPin}
          onClick={() => { setMsg(null); change.mutate(); }}>{t("auth.changePin")}</Button>
      </>}>
      <div className="space-y-3.5">
        {msg && <Alert tone={msg.ok ? "ok" : "bad"}>{msg.text}</Alert>}
        <Field label={t("auth.currentPin")}>
          <Input value={pin.currentPin} type="password" mono inputMode="numeric" maxLength={6} autoFocus
            onChange={(e) => setPin((p) => ({ ...p, currentPin: digits(e.target.value) }))} />
        </Field>
        <Field label={t("auth.newPin")} hint={t("auth.pinHelp")}>
          <Input value={pin.newPin} type="password" mono inputMode="numeric" maxLength={6}
            onChange={(e) => setPin((p) => ({ ...p, newPin: digits(e.target.value) }))} />
        </Field>
        <Field label={t("auth.pinAgain")} error={pin.again && pin.again !== pin.newPin ? t("auth.pinMismatch") : undefined}>
          <Input value={pin.again} type="password" mono inputMode="numeric" maxLength={6}
            onChange={(e) => setPin((p) => ({ ...p, again: digits(e.target.value) }))} />
        </Field>
      </div>
    </Dialog>
  );
}
