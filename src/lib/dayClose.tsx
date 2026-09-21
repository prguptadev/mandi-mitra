import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { useFormat } from "@/lib/format.tsx";
import { useConfirm } from "@/components/Confirm.tsx";
import { Alert, Button, Dialog, Field, Input } from "@/components/ui/index.tsx";
import { dmy } from "@/lib/utils.ts";

/* Closing and reopening a day, shared by the Day close screen and the daily
   list. Closing shows the day's figures and anything still unfinished;
   reopening asks why, and the reason goes into the audit trail. */

export interface DaySummary {
  slips: number; netGrams: number; amountPaise: number; payablePaise: number; unpriced: number;
  payments: number; paidPaise: number;
  trucks: number; draftTrucks: number; parchas: number; billedPaise: number;
  receipts: number; receivedPaise: number;
  scansPending: number;
}
export interface DayRow extends DaySummary {
  day: string;
  closed: { at: number; by: string | null; note: string | null; changed?: boolean } | null;
}

/** Everything a list or the daily list shows about days has "days" first in its key. */
export const invalidateDays = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "days" || q.queryKey[0] === "tally" });

export function useDayActions() {
  const { t } = useI18n();
  const f = useFormat();
  const ask = useConfirm();
  const qc = useQueryClient();
  const [reopening, setReopening] = useState<string | null>(null);

  const closeM = useMutation({
    mutationFn: (day: string) => api.post<{ closed: string[] }>("/days/close", { day }),
    onSuccess: () => invalidateDays(qc),
  });
  const uptoM = useMutation({
    mutationFn: (day: string) => api.post<{ closed: string[] }>("/days/close-upto", { day }),
    onSuccess: () => invalidateDays(qc),
  });

  const warningsOf = (r: DaySummary) => [
    r.unpriced ? t("dc.warnUnpriced", { n: r.unpriced }) : "",
    r.scansPending ? t("dc.warnScans", { n: r.scansPending }) : "",
    r.draftTrucks ? t("dc.warnDrafts", { n: r.draftTrucks }) : "",
  ].filter(Boolean);

  /** Close one day, after showing its figures. */
  const close = async (r: DayRow) => {
    const ok = await ask({
      title: t("dc.confirmTitle", { d: dmy(r.day) }),
      message: t("dc.confirmSub"),
      rows: [
        { label: t("dc.slips"), value: `${r.slips} · ${f.weight(r.netGrams, { unit: true })}` },
        { label: t("dc.payable"), value: f.money(r.payablePaise) },
        { label: t("dc.paid"), value: `${r.payments} · ${f.money(r.paidPaise)}` },
        { label: t("dc.billed"), value: `${r.parchas} · ${f.money(r.billedPaise)}` },
        { label: t("dc.received"), value: `${r.receipts} · ${f.money(r.receivedPaise)}` },
      ],
      warnings: warningsOf(r),
      confirmLabel: t("dc.closeBtn"),
    });
    if (ok) await closeM.mutateAsync(r.day).catch(() => undefined);
  };

  /** Close every day from the first entry up to this one. */
  const closeUpTo = async (day: string, openDays: number) => {
    const ok = await ask({
      title: t("dc.uptoTitle", { d: dmy(day) }),
      message: t("dc.uptoSub"),
      rows: [{ label: t("dc.openDaysWithWork"), value: String(openDays) }],
      confirmLabel: t("dc.uptoBtn"),
    });
    if (!ok) return null;
    return uptoM.mutateAsync(day).catch(() => null);
  };

  const dialog = reopening ? <ReopenDialog day={reopening} onClose={() => setReopening(null)} /> : null;
  return { close, closeUpTo, reopen: setReopening, dialog, busy: closeM.isPending || uptoM.isPending, warningsOf };
}

function ReopenDialog({ day, onClose }: { day: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.post("/days/reopen", { day, reason }),
    onSuccess: async () => { await invalidateDays(qc); onClose(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : t("common.somethingWrong")),
  });
  return (
    <Dialog open onClose={onClose} title={t("dc.reopenTitle", { d: dmy(day) })} sub={t("dc.reopenSub")}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => { setErr(null); m.mutate(); }}>{t("dc.reopenBtn")}</Button>
      </>}>
      {err && <Alert tone="bad" className="mb-3">{err}</Alert>}
      <Field label={t("dc.reason")} hint={t("dc.reasonHint")}>
        <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
          onKeyDown={(e) => { if (e.key === "Enter" && reason.trim().length >= 3) m.mutate(); }} />
      </Field>
    </Dialog>
  );
}
