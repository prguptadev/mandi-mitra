export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public field?: string,
    public issues?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? res.statusText, data?.code, data?.field, data?.issues);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
};

/* ------------------------------------------------------------------- types */

export interface Me {
  user: { id: string; name: string; nameHi: string | null; phone: string | null; isRoot: boolean; lang: "en" | "hi"; theme: "light" | "dark" | "system" };
  businesses: { businessId: string; roleKey: string; roleLabel: string; name: string; nameHi: string | null; shortCode: string; setupComplete: boolean }[];
  activeBusinessId: string | null;
  business: Business | null;
  role: { key: string; label: string; labelHi: string | null } | null;
  permissions: string[];
}

export interface Business {
  id: string; name: string; nameHi: string | null; shortCode: string;
  addressLine1: string | null; addressLine2: string | null;
  city: string | null; district: string | null; state: string | null; pincode: string | null;
  phone: string | null; gstin: string | null; mandiLicense: string | null; panNo: string | null;
  setupComplete: boolean;
}

export interface Adati {
  id: string; nameHi: string; nameHinglish: string; nameHinglishLocked: boolean;
  firmSuffix: string | null; village: string | null; villageHi: string | null;
  phone: string | null; accountNo: string | null; ifsc: string | null;
  openingBalancePaise: number; notes: string | null; active: boolean;
  aliasCount?: number; createdAt: number; updatedAt: number;
}

export interface AdatiAlias {
  id: string; adatiId: string; rawText: string; normKey: string;
  source: string; hits: number; lastUsedAt: number;
}

export interface Merchant {
  id: string; code: string; name: string; nameHi: string | null; nameHinglish: string | null;
  addressLine1: string | null; addressLine2: string | null; city: string | null;
  state: string | null; pincode: string | null; contactPerson: string | null;
  phone: string | null; gstin: string | null; active: boolean;
  chargeConfig: ChargeConfig;
}

export interface ChargeConfig {
  purchaseKatautiKgPerBag: number;
  millBardanaKgPerBag: number;
  adat: { enabled: boolean; pct: number; label: string };
  labour1: { enabled: boolean; perBagRupees: number; label: string };
  labour2: { enabled: boolean; perBagRupees: number; label: string };
  sutli: { enabled: boolean; perBagRupees: number; label: string };
  gaushala: { enabled: boolean; perQtlRupees: number; base: "gross" | "net"; label: string };
  mandiTax: { enabled: boolean; pct: number; base: PctBase; label: string };
  commission: { enabled: boolean; pct: number; base: PctBase; label: string };
  gatePass: { enabled: boolean; perTruckRupees: number; label: string };
  extraCharges: { key: string; label: string; labelHi?: string; kind: "per_bag" | "per_qtl" | "per_truck" | "pct" | "flat"; value: number; base?: PctBase; weightBase?: "gross" | "net"; sign: "add" | "subtract" }[];
  dara: { mode: "none" | "per_bag" | "per_qtl" | "pct" | "manual"; value: number; weightBase: "gross" | "net"; includeInGrandTotal: boolean; label: string; labelHi: string };
  advance: { treatment: "add" | "subtract" | "exclude"; label: string };
  grandTotalRounding: "none" | "nearest_rupee" | "up_rupee" | "nearest_ten";
  parcha: { title: string; titleHi: string; numberPrefix: string; showBoreColumns: boolean; showDaraRow: boolean; footerNote: string; footerNoteHi: string };
  paymentTermsDays: number;
  notes: string;
}

export type PctBase = "amount" | "amount_plus_adat" | "total_before_charge";

export interface ParchaLine {
  key: string; label: string; labelHi?: string; detail?: string;
  amountPaise: number; kind: "goods" | "charge" | "subtotal" | "total" | "info" | "adjust";
  sign?: "add" | "subtract";
}

export interface ParchaResult {
  grossGrams: number; bardanaGrams: number; netGrams: number; bags: number;
  ratePaisePerQtl: number; goodsAmountPaise: number; adatPaise: number;
  subtotalPaise: number; chargesPaise: number; totalPaise: number;
  advancePaise: number; daraPaise: number; grandTotalPaise: number;
  lines: ParchaLine[];
}

export interface Jins {
  id: string; code: string; name: string; nameHi: string | null;
  crop: string; active: boolean;
}

export interface Role {
  id: string; key: string; label: string; labelHi: string | null;
  isSystem: boolean; rank: number; permissions: string[]; userCount: number;
}

export interface UserRow {
  membershipId: string; userId: string; name: string; nameHi: string | null;
  phone: string | null; isRoot: boolean; userActive: boolean; membershipActive: boolean;
  lockedUntil: number | null; roleId: string; roleKey: string; roleLabel: string;
  roleLabelHi: string | null; createdAt: number;
  overrides: { permission: string; effect: "allow" | "deny" }[];
  effectivePermissions: string[];
}

export interface AuditRow {
  id: string; businessId: string | null; userId: string | null; userName: string | null;
  action: string; entity: string; entityId: string | null; entityLabel: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  changedKeys: string[]; ip: string | null; at: number;
}

export interface PermissionMeta { key: string; group: string; en: string; hi: string }
export interface GroupMeta { key: string; en: string; hi: string }
