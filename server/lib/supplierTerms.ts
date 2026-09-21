import { z } from "zod";
import { GRAMS_PER_QTL, pctPaise, perUnitPaise } from "./money.ts";

/*
 * What a supplier (adati) adds to their own receipt, on top of the goods:
 *   goods      = net weight (after katauti) × rate
 *   commission = commission % of the goods              (default 1 %)
 *   gaushala   = ₹ per quintal × net weight             (default ₹1.25)
 *   net amount = goods + commission + gaushala  — what we owe the supplier
 * Each figure is worked out per slip in whole paise, half up. A slip with no
 * rate yet carries no charges until it is priced. Each slip keeps the terms
 * it was made with, so changing the setting never re-prices old slips.
 */

export const SupplierTermsSchema = z.object({
  commissionPct: z.number().finite().min(0).max(10).default(1),
  gaushalaPerQtl: z.number().finite().min(0).max(100).default(1.25),
});
export type SupplierTerms = z.infer<typeof SupplierTermsSchema>;

/** The business setting: the terms for new slips, and the column names used on screen and in downloads. */
export const SupplierChargesSchema = SupplierTermsSchema.extend({
  labels: z.object({
    commission: z.string().trim().min(1).max(40).default("Commission"),
    commissionHi: z.string().trim().min(1).max(40).default("कमीशन"),
    gaushala: z.string().trim().min(1).max(40).default("Gaushala"),
    gaushalaHi: z.string().trim().min(1).max(40).default("गौशाला"),
    payable: z.string().trim().min(1).max(40).default("Net amount"),
    payableHi: z.string().trim().min(1).max(40).default("कुल देय"),
  }).default({}),
});
export type SupplierCharges = z.infer<typeof SupplierChargesSchema>;
export const defaultSupplierCharges = (): SupplierCharges => SupplierChargesSchema.parse({});

export interface SlipCharges { commissionPaise: number; gaushalaPaise: number; payablePaise: number }

/** The one formula: the same on the server, in the tests and in the money audit. */
export function slipCharges(amountPaise: number, netGrams: number, ratePaisePerQtl: number, terms: SupplierTerms): SlipCharges {
  if (ratePaisePerQtl <= 0) return { commissionPaise: 0, gaushalaPaise: 0, payablePaise: amountPaise };
  const commissionPaise = pctPaise(amountPaise, terms.commissionPct);
  const gaushalaPaise = perUnitPaise(netGrams, GRAMS_PER_QTL, terms.gaushalaPerQtl);
  return { commissionPaise, gaushalaPaise, payablePaise: amountPaise + commissionPaise + gaushalaPaise };
}

/** The terms a slip was made with; slips from before these charges existed use `fallback`. */
export function supplierTermsOf(slip: { supplierTerms: string | null }, fallback: SupplierTerms): SupplierTerms {
  if (!slip.supplierTerms) return fallback;
  try {
    const p = SupplierTermsSchema.safeParse(JSON.parse(slip.supplierTerms));
    return p.success ? p.data : fallback;
  } catch { return fallback; }
}
export const termsOnly = (c: SupplierTerms): SupplierTerms => ({ commissionPct: c.commissionPct, gaushalaPerQtl: c.gaushalaPerQtl });
