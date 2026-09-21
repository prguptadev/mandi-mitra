import { useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n.tsx";
import { Alert, Button, Dialog, Field, Textarea } from "@/components/ui/index.tsx";

/* Cancelling money (a payment, a receipt) never erases it: it stays on
   record, struck out, with who cancelled it and why. This asks for the why. */
export function ReasonDialog({ title, sub, confirmLabel, onClose, onConfirm, busy, error }: {
  title: ReactNode; sub?: ReactNode; confirmLabel: string;
  onClose: () => void; onConfirm: (reason: string) => void; busy?: boolean; error?: string | null;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <Dialog open onClose={onClose} title={title} sub={sub}
      footer={<>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
      </>}>
      {error && <Alert tone="bad" className="mb-3">{error}</Alert>}
      <Field label={t("money.reason")} required hint={t("money.reasonHint")}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus />
      </Field>
    </Dialog>
  );
}
