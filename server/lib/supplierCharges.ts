import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { SupplierChargesSchema, defaultSupplierCharges, type SupplierCharges } from "./supplierTerms.ts";

/* The business setting as stored; the formula itself lives in supplierTerms.ts (no database, so the screens use it too). */
export * from "./supplierTerms.ts";

export async function supplierChargesOf(businessId: string): Promise<SupplierCharges> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings)
    .where(and(eq(schema.settings.businessId, businessId), eq(schema.settings.key, "supplierCharges"))).limit(1);
  if (!row?.value) return defaultSupplierCharges();
  const p = SupplierChargesSchema.safeParse(JSON.parse(row.value));
  return p.success ? p.data : defaultSupplierCharges();
}
