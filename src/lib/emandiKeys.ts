import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.ts";

/*
 * Everything read from e-Mandi is filed under the business it was read for,
 * and each request names that business to the server. When the business is
 * switched while a read is still on its way — the portal can take fifteen
 * seconds — its reply lands under the business it was asked for, never under
 * the one open now, and the server refuses it anyway ("business_changed").
 * Nothing of one firm's login, rates or stock is ever shown under the other.
 */

/** ["emandi", business, …]: the status, or what follows it ("rates", "stock", "crops"). */
export const emandiKey = (biz: string | null | undefined, ...rest: unknown[]) => ["emandi", biz ?? "", ...rest];

/** An e-Mandi API path that tells the server which business it is asking for. */
export const emandiPath = (biz: string | null | undefined, path: string) =>
  `${path}${path.includes("?") ? "&" : "?"}biz=${encodeURIComponent(biz ?? "")}`;

/** The server's word that the business was switched while this was on its way. Never shown. */
export const isBusinessChanged = (e: unknown) => e instanceof ApiError && e.code === "business_changed";

/** The reply, if it is this business's; otherwise it is refused as "business_changed". */
export function ownReply<T extends { businessId?: string | null }>(biz: string | null | undefined, st: T): T {
  if (!biz || st?.businessId !== biz) throw new ApiError(409, "The business was switched while this was being read", "business_changed");
  return st;
}

/** Keeps a status only under the business it belongs to; a reply for any other is dropped. */
export function putStatus(qc: Pick<QueryClient, "setQueryData">, biz: string | null | undefined, st: { businessId?: string | null }) {
  if (!biz || st?.businessId !== biz) return false;
  qc.setQueryData(emandiKey(biz), st);
  return true;
}
