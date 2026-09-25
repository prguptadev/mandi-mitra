import { useI18n } from "@/lib/i18n.tsx";
import { useSession } from "@/lib/session.tsx";
import { Badge } from "@/components/ui/index.tsx";

/* A slip with no mill on it was bought by the firm itself, so it is shown as
   the firm — VLDM, VCE — and not as a blank. It still has no mill, so a truck
   cannot take it until one is chosen; the places that matter say so alongside. */

/** The open firm's short code, for a list of choices or a line of text. */
export function useOwnCode() {
  const { me } = useSession();
  return me?.business?.shortCode ?? "";
}

export function OwnFirm({ withName = false }: { withName?: boolean }) {
  const { t, pick } = useI18n();
  const { me } = useSession();
  const b = me?.business;
  if (!b) return <span className="text-faint">{t("daily.noMill")}</span>;
  const tip = t("daily.ownFirmTip", { firm: pick(b.name, b.nameHi ?? "") });
  return (
    <span className="inline-flex items-center gap-1.5" title={tip}>
      <Badge tone="neutral" className="num">{b.shortCode}</Badge>
      {withName && <span className="text-muted">{pick(b.name, b.nameHi ?? "")}</span>}
    </span>
  );
}
