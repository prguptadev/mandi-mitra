import crypto from "node:crypto";
import { sqlite } from "../db/client.ts";

/* The slips a scanned sheet puts on the daily list, as every computer works
 * them out. With cloud sync two computers can each add the same sheet before
 * either has heard of the other's Add; the rules here make that one set of
 * slips, never two. */

const hex = (s: string) => crypto.createHash("sha1").update(s).digest("hex");
const hex3 = (n: number) => Math.max(0, Math.min(0xfff, Math.floor(n) || 0)).toString(16).padStart(3, "0");

/**
 * The id of the slip one line of a sheet becomes. It is worked out from the
 * sheet and the line, never drawn at random: the same sheet added on two
 * computers makes the very same slips, which sync takes as one record each
 * instead of a second copy. Shaped like a UUID (version 8), it sorts in the
 * sheet's own order — the sheet, then the page, then the line — so slips
 * added in the same second are listed as the paper has them on every
 * computer (the daily list orders by date, entry time, then id).
 */
export function sheetSlipId(scanId: string, row: { id: string; page?: number | null }): string {
  // a sheet's id is a UUIDv7: its first 12 digits are when it was uploaded
  const plain = scanId.replace(/-/g, "").toLowerCase();
  const head = /^[0-9a-f]{12}/.test(plain) ? plain.slice(0, 12) : hex(scanId).slice(0, 12);
  const line = Number(row.id.replace(/^\D+/, ""));
  const tail = hex(`${scanId}:${row.id}`);
  const h = `${head}8${hex3(row.page ?? 1)}8${hex3(line)}${tail.slice(0, 12)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Whether any slip on the daily list came from this sheet, whatever its date now. */
export function sheetHasSlips(scanId: string): boolean {
  return Boolean(sqlite.prepare("select 1 from purchase_slips where scan_batch_id = ? limit 1").get(scanId));
}

/**
 * A sheet whose slips are on the daily list has been added, whatever its
 * status says. Two computers can leave it saying "waiting": a tick or an
 * edit on one, made before it heard of the other's Add, wins the sync. It
 * is marked added again here, so its review says so and it is never added
 * a second time. Who added it and when are taken from its first slip when
 * they were lost. The same records give the same answer on every computer,
 * and a second run changes nothing. One sheet: its slips on any day. Every
 * sheet (for the lists) or every recent one (after a pull): the slips of
 * each sheet's own day, which the index finds at once.
 * Returns how many sheets it marked. A repair that cannot run stops nothing.
 */
export function settleAddedSheets(o: { businessId?: string; scanId?: string; sinceSec?: number } = {}): number {
  const where = ["s.status <> 'committed'"];
  const args: (string | number)[] = [];
  if (o.businessId) { where.push("s.business_id = ?"); args.push(o.businessId); }
  // through the (business, uploaded) index: only the recent sheets are read
  else if (o.sinceSec != null) where.push("s.business_id in (select id from businesses)");
  if (o.sinceSec != null) { where.push("s.created_at >= ?"); args.push(o.sinceSec); }
  if (o.scanId) { where.push("s.id = ?"); args.push(o.scanId); }
  where.push(o.scanId
    ? "exists (select 1 from purchase_slips p where p.scan_batch_id = s.id)"
    : "exists (select 1 from purchase_slips p where p.business_id = s.business_id and p.slip_date = s.slip_date and p.scan_batch_id = s.id)");
  const first = (col: string) => `(select p.${col} from purchase_slips p where p.scan_batch_id = s.id order by p.created_at, p.id limit 1)`;
  try {
    return sqlite.prepare(`
      update scan_batches as s set status = 'committed',
        reviewed_by = coalesce(s.reviewed_by, ${first("entered_by")}),
        reviewed_at = coalesce(s.reviewed_at, ${first("created_at")})
      where ${where.join(" and ")}`).run(...args).changes;
  } catch (e) {
    console.warn(`[scan] could not settle added sheets: ${(e as Error).message}`);
    return 0;
  }
}

/** After every pull: the sheets uploaded in the last 90 days (an older one is put right when it is opened or listed). */
export const settleRecentAddedSheets = () => settleAddedSheets({ sinceSec: Math.floor(Date.now() / 1000) - 90 * 86400 });
