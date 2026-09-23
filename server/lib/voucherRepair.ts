import { sqlite } from "../db/client.ts";
import { audit } from "./audit.ts";
import { fyRange, voucherLabel } from "./vouchers.ts";

/* Two computers, one shop, no internet for a while: each gives its next
 * payment the same number, because each can only see its own. Once they meet
 * again this settles it — the one entered first keeps the number, the other
 * takes the next free one in that year.
 *
 * It is worked out the same way on every computer (earliest created_at, then
 * id, wins), so they all land on the same answer and the fix itself syncs.
 * Numbers are only ever moved up, never reused, and every move is audited.
 */

interface Row { id: string; business_id: string; voucher_no: number; d: string; created_at: number }

const TABLES = {
  payments: { date: "pay_date", kind: "payment" as const },
  mill_receipts: { date: "receipt_date", kind: "receipt" as const },
};

export interface Renumber { table: string; id: string; from: number; to: number }

/** Returns what it changed; nothing to do is the normal case and costs one query per table. */
export async function settleVoucherNumbers(): Promise<Renumber[]> {
  const done: Renumber[] = [];
  for (const [table, meta] of Object.entries(TABLES)) {
    const clashing = sqlite.prepare(
      `select business_id, voucher_no, ${meta.date} as d from ${table}
        where voucher_no is not null
        group by business_id, voucher_no, substr(${meta.date}, 1, 4)
        having count(*) > 1`).all() as { business_id: string; voucher_no: number; d: string }[];
    if (!clashing.length) continue;
    for (const c of clashing) {
      const { from, to } = fyRange(c.d);
      const rows = sqlite.prepare(
        `select id, business_id, voucher_no, ${meta.date} as d, created_at from ${table}
          where business_id = ? and voucher_no = ? and ${meta.date} between ? and ?
          order by created_at, id`).all(c.business_id, c.voucher_no, from, to) as Row[];
      // the first one entered keeps the number
      for (const r of rows.slice(1)) {
        const next = (sqlite.prepare(
          `select coalesce(max(voucher_no), 0) + 1 as n from ${table} where business_id = ? and ${meta.date} between ? and ?`)
          .get(r.business_id, from, to) as { n: number }).n;
        sqlite.prepare(`update ${table} set voucher_no = ? where id = ?`).run(next, r.id);
        done.push({ table, id: r.id, from: c.voucher_no, to: next });
        await audit({
          actor: { userId: null, userName: "Mandi Mitra", ip: null },
          action: `${meta.kind}.renumber`, entity: meta.kind, entityId: r.id,
          entityLabel: `${voucherLabel(meta.kind, c.voucher_no)} → ${voucherLabel(meta.kind, next)} (another computer had used that number)`,
          before: { voucherNo: c.voucher_no }, after: { voucherNo: next, reason: "the same number came from another computer" },
        });
      }
    }
  }
  return done;
}
