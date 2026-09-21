import { AlertTriangle, RotateCcw } from "lucide-react";
import { ApiError } from "@/lib/api.ts";
import { useI18n } from "@/lib/i18n.tsx";
import { Button, EmptyState } from "@/components/ui/index.tsx";

/** A list or card that could not load: says so, with the reason and a Retry — never an endless skeleton or "nothing here". */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState icon={<AlertTriangle className="h-5 w-5 text-bad" />} title={t("err.loadFailed")}
      sub={error instanceof ApiError ? error.message : t("err.loadFailedSub")}
      action={<Button icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onRetry}>{t("err.retry")}</Button>} />
  );
}
