import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/* Money is stored in paise (integer). Weight is stored in grams (integer).
   Never store rupees/quintals as float — 310.74 qtl and 3413.45 rate must
   multiply out to the exact paisa the mill sees on the parcha. */

const now = () => Math.floor(Date.now() / 1000);

/* ----------------------------------------------------------------- identity */

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    nameHi: text("name_hi"),
    phone: text("phone"),
    pinHash: text("pin_hash").notNull(),
    pinSalt: text("pin_salt").notNull(),
    isRoot: integer("is_root", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: integer("locked_until"),
    lang: text("lang").notNull().default("en"),
    theme: text("theme").notNull().default("system"),
    /** JSON blob of per-screen preferences (column layout, row order, ...). */
    prefs: text("prefs"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ phoneIdx: index("users_phone_idx").on(t.phone) }),
);

export const businesses = sqliteTable("businesses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nameHi: text("name_hi"),
  shortCode: text("short_code").notNull(),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  district: text("district"),
  state: text("state").default("Uttar Pradesh"),
  pincode: text("pincode"),
  phone: text("phone"),
  gstin: text("gstin"),
  mandiLicense: text("mandi_license"),
  panNo: text("pan_no"),
  logoPath: text("logo_path"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  setupComplete: integer("setup_complete", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().$defaultFn(now),
  updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

/** Role definitions are rows, not code — so permissions stay editable. */
export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    labelHi: text("label_hi"),
    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    rank: integer("rank").notNull().default(100),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({ uq: uniqueIndex("roles_biz_key_uq").on(t.businessId, t.key) }),
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    id: text("id").primaryKey(),
    roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => ({ uq: uniqueIndex("role_perm_uq").on(t.roleId, t.permission) }),
);

/** A user can hold a different role in each business. */
export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull().references(() => roles.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({ uq: uniqueIndex("membership_uq").on(t.userId, t.businessId) }),
);

/** Per-user grant/revoke on top of the role. effect: 'allow' | 'deny'. */
export const userPermissionOverrides = sqliteTable(
  "user_permission_overrides",
  {
    id: text("id").primaryKey(),
    membershipId: text("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    effect: text("effect").notNull(),
  },
  (t) => ({ uq: uniqueIndex("upo_uq").on(t.membershipId, t.permission) }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    activeBusinessId: text("active_business_id").references(() => businesses.id, { onDelete: "set null" }),
    userAgent: text("user_agent"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({ userIdx: index("sessions_user_idx").on(t.userId) }),
);

/* ------------------------------------------------------------------ masters */

/** Commodity / variety: paddy 1509, wheat, maize. */
export const jins = sqliteTable(
  "jins",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    nameHi: text("name_hi"),
    crop: text("crop").notNull().default("paddy"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ uq: uniqueIndex("jins_biz_code_uq").on(t.businessId, t.code) }),
);

/** Suppliers — the small businesses on the daily list.
 *  nameHi is what the employee writes; nameHinglish is the Latin form used in
 *  CSV export. nameHinglishLocked survives regeneration once a human edits it. */
export const adati = sqliteTable(
  "adati",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    nameHi: text("name_hi").notNull(),
    nameHinglish: text("name_hinglish").notNull(),
    nameHinglishLocked: integer("name_hinglish_locked", { mode: "boolean" }).notNull().default(false),
    firmSuffix: text("firm_suffix"),
    village: text("village"),
    villageHi: text("village_hi"),
    phone: text("phone"),
    accountNo: text("account_no"),
    ifsc: text("ifsc"),
    openingBalancePaise: integer("opening_balance_paise").notNull().default(0),
    notes: text("notes"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    bizIdx: index("adati_biz_idx").on(t.businessId),
    hiIdx: index("adati_hi_idx").on(t.businessId, t.nameHi),
  }),
);

/** OCR learning table. Every correction an operator makes lands here, so the
 *  same garbled reading resolves instantly next time instead of being re-guessed. */
export const adatiAliases = sqliteTable(
  "adati_aliases",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    adatiId: text("adati_id").notNull().references(() => adati.id, { onDelete: "cascade" }),
    /** Raw string as it came out of OCR / was typed. */
    rawText: text("raw_text").notNull(),
    /** rawText with matras, spaces and nukta stripped — the fuzzy match key. */
    normKey: text("norm_key").notNull(),
    source: text("source").notNull().default("correction"),
    hits: integer("hits").notNull().default(1),
    lastUsedAt: integer("last_used_at").notNull().$defaultFn(now),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({
    uq: uniqueIndex("alias_biz_raw_uq").on(t.businessId, t.rawText),
    normIdx: index("alias_norm_idx").on(t.businessId, t.normKey),
  }),
);

/** Buyer mills. chargeConfig drives every number on the kaccha parcha. */
export const merchants = sqliteTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    nameHi: text("name_hi"),
    nameHinglish: text("name_hinglish"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    state: text("state"),
    pincode: text("pincode"),
    contactPerson: text("contact_person"),
    phone: text("phone"),
    gstin: text("gstin"),
    /** JSON blob validated by ChargeConfig zod schema in server/lib/charges.ts */
    chargeConfig: text("charge_config").notNull(),
    /** What this mill owed us before the app started. Positive = the mill owes us (लेना). */
    openingBalancePaise: integer("opening_balance_paise").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ uq: uniqueIndex("merchant_biz_code_uq").on(t.businessId, t.code) }),
);

/* ------------------------------------------------------- daily list & loads */

export const purchaseSlips = sqliteTable(
  "purchase_slips",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    slipDate: text("slip_date").notNull(),
    rstNo: text("rst_no").notNull(),
    adatiId: text("adati_id").notNull().references(() => adati.id),
    jinsId: text("jins_id").notNull().references(() => jins.id),
    /** Intended buyer from the sheet header; the actual load may differ. */
    merchantId: text("merchant_id").references(() => merchants.id),
    loadId: text("load_id"),
    grossGrams: integer("gross_grams").notNull(),
    /** The KATAUTI column: gross rounded to the nearest quintal, 1 kg each. */
    katautiUnits: integer("katauti_units").notNull(),
    /** Set only when the operator overrode the derived value. */
    katautiOverride: integer("katauti_override", { mode: "boolean" }).notNull().default(false),
    /** Physical bag count, if it is known at purchase time. Usually it is not. */
    bagsCount: integer("bags_count"),
    netGrams: integer("net_grams").notNull(),
    ratePaisePerQtl: integer("rate_paise_per_qtl").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: text("status").notNull().default("open"),
    scanBatchId: text("scan_batch_id"),
    ocrConfidence: real("ocr_confidence"),
    enteredBy: text("entered_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    // RST is the kanta slip no.; it can repeat, so it is indexed, not unique
    rstIdx: index("slip_rst_idx").on(t.businessId, t.slipDate, t.rstNo),
    dateIdx: index("slip_date_idx").on(t.businessId, t.slipDate),
    loadIdx: index("slip_load_idx").on(t.loadId),
    adatiIdx: index("slip_adati_idx").on(t.adatiId, t.slipDate),
  }),
);

/** A mill's order to us: how much of which commodity to send. The parcha
 *  rate comes from the slips, not from here; ratePaisePerQtl is for reference. */
export const purchaseOrders = sqliteTable(
  "purchase_orders",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id").notNull().references(() => merchants.id),
    jinsId: text("jins_id").notNull().references(() => jins.id),
    /** The mill's own number, when it gives one; "" when the PO is known only by its date. */
    poNo: text("po_no").notNull().default(""),
    poDate: text("po_date").notNull(),
    qtyGrams: integer("qty_grams").notNull(),
    ratePaisePerQtl: integer("rate_paise_per_qtl"),
    /** Last day the mill will take deliveries against it, if it says. */
    validTill: text("valid_till"),
    /** open | closed */
    status: text("status").notNull().default("open"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  // a number, when there is one, is unique per mill; POs without one are told apart by date
  (t) => ({ uq: uniqueIndex("po_uq").on(t.businessId, t.merchantId, t.poNo).where(sql`${t.poNo} <> ''`) }),
);

/** One truck to one mill. Slips are allocated to it; the mill's own
 *  weighbridge reading is what gets billed on the kaccha parcha. */
export const loads = sqliteTable(
  "loads",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    loadDate: text("load_date").notNull(),
    merchantId: text("merchant_id").notNull().references(() => merchants.id),
    poId: text("po_id").references(() => purchaseOrders.id),
    jinsId: text("jins_id").notNull().references(() => jins.id),
    truckNo: text("truck_no"),
    transporter: text("transporter"),
    driverPhone: text("driver_phone"),
    /** Weighbridge reading at the destination mill (the parcha's DHARAM KANTA). */
    millGrossGrams: integer("mill_gross_grams"),
    /** Total bardana; kept for older rows. New rows split it into katte + bore. */
    millBardanaGrams: integer("mill_bardana_grams"),
    millNetGrams: integer("mill_net_grams"),
    /** katte + bore */
    bags: integer("bags"),
    /** Plastic (PP) bags and jute (bore) bags weigh differently empty. */
    katteCount: integer("katte_count"),
    boreCount: integer("bore_count"),
    /** Set only when the operator typed a bardana weight instead of bags x kg. */
    katteBardanaGrams: integer("katte_bardana_grams"),
    boreBardanaGrams: integer("bore_bardana_grams"),
    advancePaise: integer("advance_paise").notNull().default(0),
    daraPaise: integer("dara_paise").notNull().default(0),
    /** Chosen before approval; the parcha row takes it over once approved. */
    invoiceNo: text("invoice_no"),
    invoiceDate: text("invoice_date"),
    ewayBillNo: text("eway_bill_no"),
    /** Weight the mill cut after receiving the truck (shortage, moisture), in grams.
     *  Valued at the truck's rate, it lowers what the mill owes; the parcha itself is not changed. */
    millDeductionGrams: integer("mill_deduction_grams").notNull().default(0),
    millDeductionNote: text("mill_deduction_note"),
    /** draft | billed */
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    dateIdx: index("load_date_idx").on(t.businessId, t.loadDate),
    poIdx: index("load_po_idx").on(t.poId),
  }),
);

/** An approved kaccha parcha. The snapshot freezes everything printed —
 *  names, weights, rate, charge terms, every line — so a later change to a
 *  mill's terms or a slip can never alter a bill already sent. Voiding keeps
 *  the row; re-approving the same load makes version 2 with the same number. */
/** What went on a truck: a weight taken from one purchase day's stock of
 *  the load's mill, priced at that day's average rate (the "dara") unless a
 *  rate is typed. These are the rows of the parcha's WEIGHT DETAILS table. */
export const loadLines = sqliteTable(
  "load_lines",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    loadId: text("load_id").notNull().references(() => loads.id, { onDelete: "cascade" }),
    poId: text("po_id").references(() => purchaseOrders.id),
    jinsId: text("jins_id").notNull().references(() => jins.id),
    /** The purchase day this weight is taken from; its average is the rate. */
    stockDate: text("stock_date").notNull(),
    /** null = whatever of the mill's net the other rows leave (one row only). */
    netGrams: integer("net_grams"),
    /** null = that day's weighted average for the mill. */
    ratePaisePerQtl: integer("rate_paise_per_qtl"),
    sort: integer("sort").notNull().default(0),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    loadIdx: index("load_line_load_idx").on(t.loadId),
    stockIdx: index("load_line_stock_idx").on(t.businessId, t.stockDate),
  }),
);

export const parchas = sqliteTable(
  "parchas",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    loadId: text("load_id").notNull().references(() => loads.id, { onDelete: "cascade" }),
    parchaNo: text("parcha_no").notNull(),
    version: integer("version").notNull().default(1),
    invoiceDate: text("invoice_date"),
    snapshot: text("snapshot").notNull(),
    grandTotalPaise: integer("grand_total_paise").notNull(),
    /** approved | void */
    status: text("status").notNull().default("approved"),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: integer("approved_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidedAt: integer("voided_at"),
    voidReason: text("void_reason"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({
    uq: uniqueIndex("parcha_no_uq").on(t.businessId, t.parchaNo, t.version),
    loadIdx: index("parcha_load_idx").on(t.loadId),
  }),
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    adatiId: text("adati_id").notNull().references(() => adati.id),
    payDate: text("pay_date").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    mode: text("mode").notNull().default("cash"),
    reference: text("reference"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    /** Cancelled payments stay on record, struck out, and count for nothing. */
    voidedAt: integer("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => ({ idx: index("payment_adati_idx").on(t.adatiId, t.payDate) }),
);

/**
 * Money a mill paid us against the kaccha parchas we billed it. What the mill
 * still owes = its opening + every approved parcha − every receipt (amount
 * plus anything the mill held back, e.g. TDS or a shortage claim).
 */
export const millReceipts = sqliteTable(
  "mill_receipts",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    merchantId: text("merchant_id").notNull().references(() => merchants.id),
    /** The truck (and so its parcha) this money is for, when the mill said so. */
    loadId: text("load_id").references(() => loads.id, { onDelete: "set null" }),
    receiptDate: text("receipt_date").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    /** Held back by the mill and accepted: settles the bill without money arriving. */
    deductionPaise: integer("deduction_paise").notNull().default(0),
    deductionNote: text("deduction_note"),
    mode: text("mode").notNull().default("bank"),
    reference: text("reference"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
    voidedAt: integer("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => ({
    idx: index("mill_receipt_mill_idx").on(t.merchantId, t.receiptDate),
    loadIdx: index("mill_receipt_load_idx").on(t.loadId),
  }),
);

/* --------------------------------------------------------------- scan / ocr */

export const scanBatches = sqliteTable(
  "scan_batches",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull().default("upload"),
    filePaths: text("file_paths").notNull(),
    slipDate: text("slip_date"),
    merchantId: text("merchant_id").references(() => merchants.id),
    jinsId: text("jins_id").references(() => jins.id),
    model: text("model"),
    rawResponse: text("raw_response"),
    parsedRows: text("parsed_rows"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costPaise: integer("cost_paise"),
    status: text("status").notNull().default("pending"),
    errorText: text("error_text"),
    /** Non-fatal: the read succeeded but something is worth saying. */
    warningText: text("warning_text"),
    /** Pages read so far; pages are read one at a time and shown as they land. */
    pagesDone: integer("pages_done").notNull().default(0),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({ idx: index("scan_biz_idx").on(t.businessId, t.createdAt) }),
);

/* ------------------------------------------------------------------- system */

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id"),
    userId: text("user_id"),
    userName: text("user_name"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    entityLabel: text("entity_label"),
    before: text("before"),
    after: text("after"),
    changedKeys: text("changed_keys"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: integer("at").notNull().$defaultFn(now),
  },
  (t) => ({
    bizIdx: index("audit_biz_idx").on(t.businessId, t.at),
    entIdx: index("audit_entity_idx").on(t.entity, t.entityId),
    userIdx: index("audit_user_idx").on(t.userId, t.at),
  }),
);

export const settings = sqliteTable(
  "settings",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value"),
    updatedAt: integer("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ uq: uniqueIndex("settings_uq").on(t.businessId, t.key) }),
);

/** One row per Gemini request, so the app can say how much of the daily
 *  quota is gone before Google refuses. The key itself is never stored. */
export const geminiCalls = sqliteTable(
  "gemini_calls",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id"),
    /** First 16 hex of sha256(key): quota is per key's project, shared across firms. */
    keyHash: text("key_hash").notNull(),
    model: text("model").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    /** Refused for quota; Google does not count these against the limit. */
    refused: integer("refused", { mode: "boolean" }).notNull().default(false),
    /** The daily limit Google reported, when it reported one. */
    reportedLimit: integer("reported_limit"),
    at: integer("at").notNull().$defaultFn(now),
  },
  (t) => ({ idx: index("gemini_calls_key_idx").on(t.keyHash, t.at) }),
);

/** Every local write queues here for the cloud push. */
export const syncOutbox = sqliteTable(
  "sync_outbox",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id"),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    op: text("op").notNull(),
    payload: text("payload"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    pushedAt: integer("pushed_at"),
    createdAt: integer("created_at").notNull().$defaultFn(now),
  },
  (t) => ({ pendingIdx: index("outbox_pending_idx").on(t.pushedAt, t.createdAt) }),
);
