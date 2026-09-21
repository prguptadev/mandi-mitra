/** The permission catalogue. Every guarded action in the app is one of these. */
export const PERMISSIONS = [
  { key: "dashboard.view",  group: "general",  en: "View dashboard",            hi: "डैशबोर्ड देखें" },
  { key: "slip.read",       group: "daily",    en: "View daily list",           hi: "दैनिक सूची देखें" },
  { key: "slip.write",      group: "daily",    en: "Add / edit slips",          hi: "पर्ची जोड़ें / बदलें" },
  { key: "slip.delete",     group: "daily",    en: "Delete slips",              hi: "पर्ची हटाएँ" },
  { key: "rate.edit",       group: "daily",    en: "Edit purchase rate",        hi: "खरीद दर बदलें" },
  { key: "day.close",       group: "daily",    en: "Close a finished day",      hi: "दिन बंद करें" },
  { key: "day.reopen",      group: "daily",    en: "Reopen a closed day",       hi: "बंद दिन फिर खोलें" },
  { key: "scan.create",     group: "scan",     en: "Scan / upload sheets",      hi: "स्कैन / अपलोड करें" },
  { key: "scan.review",     group: "scan",     en: "Review & approve OCR",      hi: "OCR जाँचें और स्वीकारें" },
  { key: "load.read",       group: "load",     en: "View loads",                hi: "लोड देखें" },
  { key: "load.write",      group: "load",     en: "Create / edit loads",       hi: "लोड बनाएँ / बदलें" },
  { key: "load.delete",     group: "load",     en: "Delete loads",              hi: "लोड हटाएँ" },
  { key: "parcha.read",     group: "parcha",   en: "View kaccha parcha",        hi: "कच्चा पर्चा देखें" },
  { key: "parcha.create",   group: "parcha",   en: "Generate kaccha parcha",    hi: "कच्चा पर्चा बनाएँ" },
  { key: "parcha.approve",  group: "parcha",   en: "Approve kaccha parcha",     hi: "कच्चा पर्चा स्वीकारें" },
  { key: "parcha.void",     group: "parcha",   en: "Void kaccha parcha",        hi: "कच्चा पर्चा रद्द करें" },
  { key: "po.read",         group: "load",     en: "View purchase orders",      hi: "PO देखें" },
  { key: "po.write",        group: "load",     en: "Add / edit purchase orders",hi: "PO जोड़ें / बदलें" },
  { key: "challan.write",   group: "load",     en: "Enter the mill's weight cut (challan)", hi: "मिल की वज़न कटौती भरें (चालान)" },
  { key: "stock.read",      group: "stock",    en: "View stock",                hi: "स्टॉक देखें" },
  { key: "adati.read",      group: "masters",  en: "View suppliers",            hi: "आढ़ती देखें" },
  { key: "adati.write",     group: "masters",  en: "Add / edit suppliers",      hi: "आढ़ती जोड़ें / बदलें" },
  { key: "adati.delete",    group: "masters",  en: "Delete suppliers",          hi: "आढ़ती हटाएँ" },
  { key: "merchant.read",   group: "masters",  en: "View mills / merchants",    hi: "मिल / व्यापारी देखें" },
  { key: "merchant.write",  group: "masters",  en: "Add / edit mills",          hi: "मिल जोड़ें / बदलें" },
  { key: "merchant.delete", group: "masters",  en: "Delete mills",              hi: "मिल हटाएँ" },
  { key: "jins.read",       group: "masters",  en: "View commodities",          hi: "जिंस देखें" },
  { key: "jins.write",      group: "masters",  en: "Add / edit commodities",    hi: "जिंस जोड़ें / बदलें" },
  { key: "payment.read",    group: "accounts", en: "View payments to suppliers", hi: "आढ़तियों को भुगतान देखें" },
  { key: "payment.write",   group: "accounts", en: "Record / cancel payments to suppliers", hi: "आढ़तियों को भुगतान दर्ज / रद्द करें" },
  { key: "ledger.read",     group: "accounts", en: "View supplier ledger",      hi: "आढ़ती खाता देखें" },
  { key: "millledger.read", group: "accounts", en: "View mill accounts (what mills owe)", hi: "मिल खाता देखें (मिलों से लेना)" },
  { key: "millreceipt.write", group: "accounts", en: "Record / cancel money from mills", hi: "मिल से आया पैसा दर्ज / रद्द करें" },
  { key: "export.data",     group: "accounts", en: "Export CSV / Excel",        hi: "CSV / Excel निकालें" },
  { key: "users.read",      group: "admin",    en: "View users",                hi: "उपयोगकर्ता देखें" },
  { key: "users.manage",    group: "admin",    en: "Add / edit users",          hi: "उपयोगकर्ता प्रबंधित करें" },
  { key: "roles.manage",    group: "admin",    en: "Edit roles & permissions",  hi: "भूमिका व अनुमति बदलें" },
  { key: "business.read",   group: "admin",    en: "View business profile",     hi: "व्यापार प्रोफ़ाइल देखें" },
  { key: "business.write",  group: "admin",    en: "Edit business profile",     hi: "व्यापार प्रोफ़ाइल बदलें" },
  { key: "audit.read",      group: "admin",    en: "View audit trail",          hi: "ऑडिट देखें" },
  { key: "settings.write",  group: "admin",    en: "Change settings",           hi: "सेटिंग बदलें" },
  { key: "backup.manage",   group: "admin",    en: "Backups and the cloud copy (all data)", hi: "बैकअप और क्लाउड कॉपी (सारा डेटा)" },
  { key: "app.update",      group: "admin",    en: "Install app updates",       hi: "ऐप अपडेट करें" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];
export const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key) as Permission[];

export const PERMISSION_GROUPS = [
  { key: "general",  en: "General",        hi: "सामान्य" },
  { key: "daily",    en: "Daily list",     hi: "दैनिक सूची" },
  { key: "scan",     en: "Scan & OCR",     hi: "स्कैन व OCR" },
  { key: "load",     en: "Loads & PO",     hi: "लोड व PO" },
  { key: "parcha",   en: "Kaccha parcha",  hi: "कच्चा पर्चा" },
  { key: "stock",    en: "Stock",          hi: "स्टॉक" },
  { key: "masters",  en: "Masters",        hi: "मास्टर" },
  { key: "accounts", en: "Accounts",       hi: "खाता" },
  { key: "admin",    en: "Administration", hi: "प्रशासन" },
] as const;

const P = (...keys: Permission[]) => keys;

/** Seeded roles. All of this is editable later from the Roles screen. */
export const ROLE_PRESETS = [
  {
    key: "owner", label: "Owner", labelHi: "स्वामी", rank: 10,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "manager", label: "Manager", labelHi: "प्रबंधक", rank: 20,
    permissions: P(
      "dashboard.view", "slip.read", "slip.write", "slip.delete", "rate.edit",
      "scan.create", "scan.review", "load.read", "load.write", "load.delete",
      "parcha.read", "parcha.create", "parcha.approve", "po.read", "po.write",
      "stock.read", "adati.read", "adati.write", "merchant.read", "merchant.write",
      "jins.read", "jins.write", "payment.read", "payment.write", "ledger.read",
      "millledger.read", "millreceipt.write", "challan.write", "day.close",
      "export.data", "users.read", "business.read", "audit.read",
    ),
  },
  {
    key: "accountant", label: "Accountant", labelHi: "लेखाकार", rank: 30,
    permissions: P(
      "dashboard.view", "slip.read", "load.read", "parcha.read", "po.read",
      "stock.read", "adati.read", "merchant.read", "jins.read",
      "payment.read", "payment.write", "ledger.read", "export.data", "business.read",
      "millledger.read", "millreceipt.write", "day.close",
    ),
  },
  {
    key: "operator", label: "Operator", labelHi: "संचालक", rank: 40,
    permissions: P(
      "dashboard.view", "slip.read", "slip.write", "rate.edit",
      "scan.create", "scan.review", "load.read", "load.write",
      "parcha.read", "parcha.create", "po.read", "stock.read",
      "adati.read", "adati.write", "merchant.read", "jins.read", "export.data",
    ),
  },
  {
    key: "viewer", label: "Viewer", labelHi: "दर्शक", rank: 50,
    permissions: P(
      "dashboard.view", "slip.read", "load.read", "parcha.read", "po.read",
      "stock.read", "adati.read", "merchant.read", "jins.read", "ledger.read",
      "millledger.read",
    ),
  },
] as const;

/** Role grants, then per-user overrides. An explicit deny always wins. */
export function effectivePermissions(
  rolePerms: string[],
  overrides: { permission: string; effect: string }[],
): Set<string> {
  const set = new Set(rolePerms);
  for (const o of overrides) if (o.effect === "allow") set.add(o.permission);
  for (const o of overrides) if (o.effect === "deny") set.delete(o.permission);
  return set;
}

/** Every permission a preset role should have, by role key. */
export function presetPermissions(roleKey: string): readonly string[] {
  return ROLE_PRESETS.find((r) => r.key === roleKey)?.permissions ?? [];
}
