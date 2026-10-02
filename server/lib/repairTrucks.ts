/* Truck and parcha repairs after a cloud pull, and the rule for a truck
 * approved on two computers. Every computer runs them on the same records and
 * so comes to the same result; whatever they change is marked by the sync
 * triggers and sent up like any other edit.
 * (Stub: filled in by the truck/parcha fix.) */

/**
 * Another computer's approved parcha arrived for a truck that already has a
 * live parcha here (unique index parcha_one_approved_uq). Must give the same
 * answer on every computer for the same pair of parchas.
 *   "take-incoming": this function has already voided the local live parcha; the caller stores the incoming one.
 *   "keep-local": the caller leaves the incoming one to be tried again (it arrives voided from the other computer).
 */
export function parchaUniqueClash(_incoming: Record<string, unknown>): "take-incoming" | "keep-local" {
  return "keep-local";
}

/** Called after every pull that applied something, inside no transaction. Returns how many records it changed. */
export function repairTrucksAfterPull(): number {
  return 0;
}
