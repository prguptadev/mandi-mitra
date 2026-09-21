import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n.tsx";
import { Button, Dialog } from "@/components/ui/index.tsx";
import { cn } from "@/lib/utils.ts";

/*
 * One "are you sure?" box for every save that is hard to undo: it shows, in
 * plain words and large figures, exactly what is about to be saved, so it can
 * be checked against the paper before anything is written. Cancel changes
 * nothing.
 *   const ask = useConfirm();
 *   if (!(await ask({ title, rows: [{ label, value }], warnings }))) return;
 */

export interface ConfirmRow { label: string; value: ReactNode; big?: boolean }
export interface ConfirmAsk {
  title: string;
  message?: ReactNode;
  rows?: ConfirmRow[];
  /** Shown in amber above the buttons: things worth a second look. */
  warnings?: string[];
  confirmLabel?: string;
  /** Deleting or cancelling: a red button. */
  danger?: boolean;
}

const Ctx = createContext<(a: ConfirmAsk) => Promise<boolean>>(() => Promise.resolve(false));
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [ask, setAsk] = useState<(ConfirmAsk & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((a: ConfirmAsk) => new Promise<boolean>((resolve) => setAsk({ ...a, resolve })), []);
  const done = (ok: boolean) => { ask?.resolve(ok); setAsk(null); };
  return (
    <Ctx.Provider value={confirm}>
      {children}
      {ask && (
        <Dialog open onClose={() => done(false)} title={ask.title}
          footer={<>
            <Button size="lg" onClick={() => done(false)}>{t("confirm.cancel")}</Button>
            <Button size="lg" variant={ask.danger ? "danger" : "primary"} autoFocus onClick={() => done(true)}>
              {ask.confirmLabel ?? t("confirm.yesSave")}
            </Button>
          </>}>
          <div className="space-y-3">
            {ask.message && <div className="text-[14px] leading-relaxed text-ink">{ask.message}</div>}
            {ask.rows && ask.rows.length > 0 && (
              <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {ask.rows.map((r, i) => (
                  <div key={i} className={cn("flex items-baseline justify-between gap-4 px-4 py-2.5", r.big && "bg-brand/5")}>
                    <dt className="text-[13px] text-muted">{r.label}</dt>
                    <dd className={cn("num text-right text-ink", r.big ? "text-xl font-bold text-brand" : "text-[15px] font-semibold")}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {ask.warnings?.filter(Boolean).map((w, i) => (
              <p key={i} className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] text-warn">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w}
              </p>
            ))}
          </div>
        </Dialog>
      )}
    </Ctx.Provider>
  );
}
