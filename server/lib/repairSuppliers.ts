/* Supplier repairs after a cloud pull. Every computer runs them on the same
 * records and so comes to the same result; whatever they change is marked by
 * the sync triggers and sent up like any other edit.
 * (Stub: filled in by the supplier-join fix.) */

/** Called after every pull that applied something, inside no transaction. Returns how many records it changed. */
export function repairSuppliersAfterPull(): number {
  return 0;
}
