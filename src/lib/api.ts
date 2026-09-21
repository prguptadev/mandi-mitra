/** Duck-typed: `instanceof` is unreliable across hot-reloaded module copies. */
export function apiStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

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
  del: <T>(p: string, b?: unknown) => request<T>("DELETE", p, b),
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

/* Charge terms and parcha results come straight from the server's own
   types (type-only imports, erased from the browser bundle), so the two
   sides cannot drift apart. */
import type { ChargeConfig } from "@server/lib/charges.ts";
export type { ChargeConfig };
export type { ParchaResult, ParchaLine } from "@server/lib/charges.ts";
export type { ParchaDoc, Blocker as LoadBlocker, Warning as LoadWarning, LoadState } from "@server/lib/parcha.ts";

export type PctBase = "amount" | "amount_plus_adat" | "total_before_charge";

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

export interface SlipRow {
  id: string; slipDate: string; rstNo: string;
  adatiId: string; adatiNameHi: string; adatiNameHinglish: string; adatiVillage: string | null;
  jinsId: string; jinsCode: string; jinsName: string; jinsNameHi: string | null;
  merchantId: string | null; merchantCode: string | null; merchantName: string | null;
  loadId: string | null; loadTruckNo: string | null; loadStatus: "draft" | "billed" | null;
  grossGrams: number; katautiUnits: number; katautiOverride: boolean;
  bagsCount: number | null; netGrams: number;
  ratePaisePerQtl: number; amountPaise: number;
  status: string; ocrConfidence: number | null; scanBatchId: string | null;
  scanStatus: string | null; scanPages: number;
  katautiGrams: number; katautiCfg: KatautiConfig; suggestedKatautiUnits: number;
  expectedNetGrams: number; expectedAmountPaise: number;
  netMismatchGrams: number; amountMismatchPaise: number; reconciles: boolean;
  ratePending: boolean; avgBagKg: number | null; bagWarning: boolean;
  createdAt: number; updatedAt: number;
}

export interface KatautiConfig {
  mode: "per_quintal_rounded" | "per_quintal_exact" | "per_bag" | "none";
  kgPerUnit: number;
}

export interface SlipTotals {
  rows: number; grossGrams: number; katautiUnits: number; bagsCount: number; katautiGrams: number;
  netGrams: number; amountPaise: number; weightedAvgRatePaise: number;
  pricedNetGrams: number; allocatedRows: number; mismatchRows: number;
  ratePendingRows: number; bagWarningRows: number;
}

export interface SlipDay {
  slipDate: string; n: number; netGrams: number; amountPaise: number;
}

export interface GeminiSettings {
  model: string; fallbackModel: string; fallbackBelowConfidence: number;
  maxOutputTokens: number; temperature: number;
  configured: boolean; maskedKey: string | null; keyUnreadable: boolean;
  models: { id: string; label: string; note: string }[];
}

export interface ScanIssue { code: string; level: "error" | "warn"; message: string; params?: Record<string, string | number> }

export interface ScanRow {
  id: string;
  page?: number;
  ocr: {
    rstNo: string | null; adatiName: string | null; grossQtl: number | null;
    katauti: number | null; netQtl: number | null; rate: number | null;
    confidence: number | null; struckThrough: boolean | null;
  };
  rstNo: string;
  adatiId: string | null;
  adatiRawText: string;
  grossGrams: number | null;
  katautiOverride: number | null;
  ratePaisePerQtl: number | null;
  excluded: boolean;
  nameCorrected: boolean;
  modelPick?: string | null;
  confirmed?: string[];
  match: { adatiId: string; nameHi: string; nameHinglish: string; confidence: number; via: "alias" | "normkey" | "model" | "fuzzy" } | null;
  chosen: { adatiId: string; nameHi: string; nameHinglish: string } | null;
  suggestions: { adatiId: string; nameHi: string; nameHinglish: string; village: string | null; confidence: number }[];
  derivedKatautiUnits: number | null;
  derivedNetGrams: number | null;
  derivedAmountPaise: number | null;
  netAgrees: boolean | null;
  netDiffGrams: number | null;
  issues: ScanIssue[];
  blocking: boolean;
}

export interface ScanSummary {
  total: number; included: number; excluded: number;
  blocking: number; warnings: number; clean: number;
  autoMatchedNames: number; netAgreeing: number; netChecked: number;
  totalNetGrams: number; totalAmountPaise: number; meanConfidence: number;
}

export interface ScanBatch {
  id: string; status: string; sourceKind: string;
  slipDate: string | null; merchantId: string | null; jinsId: string | null;
  model: string | null; errorText: string | null; warningText: string | null;
  tokensIn: number | null; tokensOut: number | null;
  createdAt: number; reviewedAt: number | null;
  running: boolean;
  pagesDone: number;
  pages: { index: number; name: string; mimeType: string; bytes: number }[];
  rows: ScanRow[];
  summary: ScanSummary | null;
}

export interface ScanListRow {
  id: string; status: string; sourceKind: string;
  slipDate: string | null; merchantId: string | null; merchantCode: string | null;
  model: string | null; errorText: string | null;
  pages: number; rowCount: number;
  createdAt: number; reviewedAt: number | null;
}

export interface GeminiUsage {
  configured: boolean;
  model?: string;
  used?: number;
  dailyLimit?: number | null;
  exhausted?: boolean;
  resetsAt?: string;
}

export interface OrderRow {
  id: string; merchantId: string; jinsId: string; poNo: string; poDate: string;
  qtyGrams: number; ratePaisePerQtl: number | null; validTill: string | null;
  status: "open" | "closed"; notes: string | null;
  millCode: string; millName: string; jinsCode: string; jinsName: string; jinsNameHi: string | null;
  sentGrams: number; loads: number; billedLoads: number; balanceGrams: number;
}

export interface LoadListRow {
  id: string; loadDate: string; merchantId: string; jinsId: string; poId: string | null;
  truckNo: string | null; transporter: string | null; status: "draft" | "billed";
  millGrossGrams: number | null; millNetGrams: number | null; bags: number | null;
  invoiceNo: string | null;
  millCode: string; millName: string; jinsCode: string; poNo: string | null;
  slips: number; slipNetGrams: number; slipAmountPaise: number; avgRatePaisePerQtl: number;
  diffGrams: number | null;
  parcha: { id: string; parchaNo: string; version: number; grandTotalPaise: number } | null;
}

export interface CandidateSlip {
  id: string; slipDate: string; rstNo: string; adatiNameHi: string; adatiNameHinglish: string;
  merchantId: string | null; merchantCode: string | null;
  grossGrams: number; katautiUnits: number; netGrams: number; ratePaisePerQtl: number; amountPaise: number;
}

export interface ParchaRegisterRow {
  id: string; loadId: string; parchaNo: string; version: number; invoiceDate: string | null;
  grandTotalPaise: number; status: "approved" | "void"; approvedAt: number | null;
  voidedAt: number | null; voidReason: string | null;
  truckNo: string | null; millCode: string; millName: string;
}
