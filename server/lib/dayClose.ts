import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { HttpError } from "./http.ts";

/* A closed day is finished: nothing dated on it — a slip, a payment, a truck,
   a parcha, money from a mill — can be added, changed or cancelled until the
   owner reopens it. Every write route asks here first, with each day the
   change touches (the old date and the new one when a date moves). */

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** Which of these days are closed. */
export async function closedAmong(biz: string, days: (string | null | undefined)[]): Promise<string[]> {
  const list = [...new Set(days.filter((d): d is string => Boolean(d)))];
  if (!list.length) return [];
  const rows = await db.select({ day: schema.dayCloses.day }).from(schema.dayCloses)
    .where(and(eq(schema.dayCloses.businessId, biz), inArray(schema.dayCloses.day, list)));
  return rows.map((r) => r.day).sort();
}

/** Refuses the change when any of these days is closed. */
export async function assertDaysOpen(biz: string, ...days: (string | null | undefined)[]) {
  const shut = await closedAmong(biz, days);
  if (!shut.length) return;
  const names = shut.slice(0, 3).map(dmy).join(", ") + (shut.length > 3 ? ` +${shut.length - 3}` : "");
  throw new HttpError(409,
    `${names} ${shut.length === 1 ? "is" : "are"} closed (दिन बंद है). To change ${shut.length === 1 ? "it" : "them"}, the owner reopens the day on the Day close screen.`,
    "day_closed");
}
