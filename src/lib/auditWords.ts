import type { Formatter } from "@/lib/format.tsx";
import type { AuditRow } from "@/lib/api.ts";
import { dmy } from "@/lib/utils.ts";

/* The audit trail in plain words: what an action code means, what a field is
   called, and a stored value as it is shown on screen (paise as rupees, grams
   as quintals). Anything not listed falls back to the code itself, so nothing
   is ever hidden. */

const ACTIONS: Record<string, [string, string]> = {
  "slip.create": ["Slip added", "पर्ची जोड़ी"], "slip.update": ["Slip changed", "पर्ची बदली"], "slip.delete": ["Slip deleted", "पर्ची हटाई"],
  "slip.reassign": ["Slips moved to another mill", "पर्चियाँ दूसरी मिल में"], "slip.set_jins": ["Slips' commodity changed", "पर्चियों की जिंस बदली"], "slip.recompute": ["Day re-worked", "दिन फिर से निकाला"],
  "payment.create": ["Payment recorded", "भुगतान दर्ज"], "payment.update": ["Payment changed", "भुगतान बदला"], "payment.void": ["Payment cancelled", "भुगतान रद्द"],
  "mill_receipt.create": ["Money from mill recorded", "मिल से आया पैसा दर्ज"], "mill_receipt.update": ["Mill receipt changed", "मिल रसीद बदली"], "mill_receipt.void": ["Mill receipt cancelled", "मिल रसीद रद्द"],
  "parcha.approve": ["Parcha approved", "पर्चा स्वीकृत"], "parcha.void": ["Parcha voided", "पर्चा रद्द"],
  "load.create": ["Truck added", "ट्रक जोड़ा"], "load.update": ["Truck changed", "ट्रक बदला"], "load.delete": ["Truck deleted", "ट्रक हटाया"],
  "load.add_line": ["Truck row added", "ट्रक की पंक्ति जोड़ी"], "load.update_line": ["Truck row changed", "ट्रक की पंक्ति बदली"], "load.remove_line": ["Truck row removed", "ट्रक की पंक्ति हटाई"],
  "load.deduction": ["Mill weight cut entered", "मिल की वज़न कटौती भरी"], "load.resync": ["Truck put in step with its parcha after a sync", "सिंक के बाद ट्रक उसके पर्चे से मिलाया"],
  "po.create": ["PO added", "PO जोड़ा"], "po.update": ["PO changed", "PO बदला"], "po.delete": ["PO deleted", "PO हटाया"],
  "adati.create": ["Supplier added", "आढ़ती जोड़ा"], "adati.update": ["Supplier changed", "आढ़ती बदला"], "adati.delete": ["Supplier deleted", "आढ़ती हटाया"], "adati.deactivate": ["Supplier made inactive", "आढ़ती निष्क्रिय"],
  "adati.alias.create": ["Name spelling learned", "नाम की वर्तनी सीखी"], "adati.alias.reinforce": ["Name spelling confirmed", "नाम की वर्तनी पक्की"], "adati.alias.delete": ["Name spelling removed", "नाम की वर्तनी हटाई"], "adati.regenerate_hinglish": ["Hinglish names redone", "हिंग्लिश नाम फिर बनाए"],
  "merchant.create": ["Mill added", "मिल जोड़ी"], "merchant.update": ["Mill changed", "मिल बदली"], "merchant.delete": ["Mill deleted", "मिल हटाई"], "merchant.deactivate": ["Mill made inactive", "मिल निष्क्रिय"], "merchant.charges.update": ["Mill's charge terms changed", "मिल की शर्तें बदलीं"],
  "jins.create": ["Commodity added", "जिंस जोड़ी"], "jins.update": ["Commodity changed", "जिंस बदली"],
  "scan.upload": ["Sheet uploaded", "शीट अपलोड"], "scan.scanner": ["Sheet scanned", "शीट स्कैन"], "scan.read": ["Sheet read", "शीट पढ़ी"], "scan.read.fail": ["Sheet reading failed", "शीट पढ़ना असफल"], "scan.read.quota": ["Reading stopped: quota", "पढ़ना रुका: सीमा"], "scan.read.empty": ["Nothing read on the sheet", "शीट पर कुछ नहीं पढ़ा"],
  "scan.page_confirm": ["Page checked against paper", "पेज काग़ज़ से मिलाया"], "scan.commit": ["Sheet added to daily list", "शीट दैनिक सूची में"], "scan.delete": ["Scan deleted", "स्कैन हटाया"], "scan.reorder": ["Pages reordered", "पेज का क्रम बदला"], "scan.create_suppliers": ["Suppliers created from sheet", "शीट से आढ़ती बने"], "scan.try_model": ["Another reader model tried", "दूसरा मॉडल आज़माया"],
  "day.close": ["Day closed", "दिन बंद"], "day.reopen": ["Day reopened", "दिन फिर खुला"],
  "mill_followup.create": ["Mill call noted", "मिल को फ़ोन दर्ज"], "mill_followup.delete": ["Mill call note removed", "फ़ोन नोट हटाया"],
  "tally.export": ["Tally file made", "टैली फ़ाइल बनी"], "tally.mark": ["Entries marked as in Tally", "एंट्री टैली में गिनीं"], "tally.fixed": ["Entry put right in Tally", "एंट्री टैली में ठीक"],
  "books.check": ["Books checked", "किताबें जाँचीं"],
  "login": ["Signed in", "लॉग इन"], "login.failed": ["Wrong PIN", "ग़लत PIN"], "logout": ["Signed out", "लॉग आउट"], "signup": ["First set-up", "पहली बार सेट-अप"], "pin.change": ["PIN changed", "PIN बदला"],
  "user.create": ["User added", "उपयोगकर्ता जोड़ा"], "user.update": ["User changed", "उपयोगकर्ता बदला"], "user.pin.reset": ["User's PIN reset", "उपयोगकर्ता का PIN रीसेट"], "user.overrides.update": ["User's extra permissions changed", "उपयोगकर्ता की अतिरिक्त अनुमतियाँ बदलीं"],
  "role.create": ["Role added", "भूमिका जोड़ी"], "role.update": ["Role changed", "भूमिका बदली"], "role.delete": ["Role deleted", "भूमिका हटाई"],
  "business.create": ["Business added", "व्यापार जोड़ा"], "business.update": ["Business details changed", "व्यापार की जानकारी बदली"], "business.switch": ["Switched business", "व्यापार बदला"],
  "settings.display.update": ["Number settings changed", "अंक सेटिंग बदली"], "settings.supplier_charges.update": ["Supplier charges changed", "आढ़ती के ख़र्चे बदले"], "settings.tally.update": ["Tally names changed", "टैली के नाम बदले"],
  "settings.gemini.update": ["Reader settings changed", "रीडर सेटिंग बदली"], "settings.gemini.key.set": ["Gemini key saved", "Gemini कुंजी सहेजी"], "settings.gemini.key.clear": ["Gemini key removed", "Gemini कुंजी हटाई"], "settings.gemini.key.copy": ["Gemini key copied from other business", "Gemini कुंजी दूसरे व्यापार से"], "settings.gemini.test.ok": ["Gemini key tested: works", "Gemini कुंजी जाँची: ठीक"], "settings.gemini.test.fail": ["Gemini key tested: failed", "Gemini कुंजी जाँची: असफल"],
  "backup.run": ["Backup made", "बैकअप बना"], "backup.download": ["Backup downloaded", "बैकअप डाउनलोड"], "backup.restore": ["Backup restore ordered", "बैकअप वापस लाने का आदेश"], "backup.folder": ["Backup folder changed", "बैकअप फ़ोल्डर बदला"],
  "cloud.connect": ["Cloud sync started", "क्लाउड सिंक शुरू"], "cloud.disconnect": ["Cloud sync turned off", "क्लाउड सिंक बंद"], "cloud.join": ["Joined the cloud", "क्लाउड से जुड़े"], "cloud.restore": ["Data brought down from cloud", "क्लाउड से डेटा लाया"], "cloud.clashes_cleared": ["Sync clashes cleared", "सिंक टकराव साफ़"],
  "app.update": ["App updated", "ऐप अपडेट"], "app.update_folder": ["Update folder changed", "अपडेट फ़ोल्डर बदला"],
  "emandi.account": ["e-Mandi user name changed", "e-Mandi यूज़र नाम बदला"], "emandi.password": ["e-Mandi password changed", "e-Mandi पासवर्ड बदला"], "emandi.watch": ["e-Mandi commodities chosen", "e-Mandi की जिंसें चुनीं"], "emandi.forget": ["e-Mandi login removed", "e-Mandi लॉगिन हटाया"], "emandi.signin": ["Signed in to e-Mandi", "e-Mandi में साइन इन"], "emandi.signout": ["Signed out of e-Mandi", "e-Mandi से साइन आउट"],
};
export const actionWords = (action: string, lang: string) => { const w = ACTIONS[action]; return w ? (lang === "hi" ? w[1] : w[0]) : action; };

const FIELDS: Record<string, [string, string]> = {
  slipDate: ["Date", "तारीख़"], payDate: ["Date", "तारीख़"], receiptDate: ["Date", "तारीख़"], loadDate: ["Truck date", "ट्रक की तारीख़"], invoiceDate: ["Parcha date", "पर्चे की तारीख़"],
  rstNo: ["RST", "RST"], adatiId: ["Supplier", "आढ़ती"], merchantId: ["Mill", "मिल"], jinsId: ["Commodity", "जिंस"], loadId: ["Truck", "ट्रक"],
  grossGrams: ["Gross weight", "धर्म कांटा"], katautiUnits: ["Katauti", "कटौती"], katautiOverride: ["Katauti typed by hand", "कटौती हाथ से"], netGrams: ["Net weight", "शुद्ध वज़न"], bagsCount: ["Bags", "बोरे"],
  ratePaisePerQtl: ["Rate", "दर"], amountPaise: ["Amount", "राशि"], commissionPaise: ["Commission", "कमीशन"], gaushalaPaise: ["Gaushala", "गौशाला"], payablePaise: ["Net amount", "कुल देय"],
  mode: ["Mode", "तरीका"], reference: ["Reference", "संदर्भ"], notes: ["Notes", "टिप्पणी"], voucherNo: ["Voucher no.", "वाउचर नं"], deductionPaise: ["Held back", "काटा"], deductionNote: ["Held back for", "काटने का कारण"],
  voidedAt: ["Cancelled at", "रद्द किया"], voidReason: ["Reason", "कारण"], status: ["Status", "स्थिति"],
  openingBalancePaise: ["Opening balance", "प्रारंभिक शेष"], nameHi: ["Name (Hindi)", "नाम (हिन्दी)"], nameHinglish: ["Name (Hinglish)", "नाम (हिंग्लिश)"], name: ["Name", "नाम"], village: ["Village", "गाँव"], phone: ["Phone", "फ़ोन"], active: ["Active", "सक्रिय"], code: ["Code", "कोड"],
  truckNo: ["Truck no.", "ट्रक नं"], invoiceNo: ["Parcha no.", "पर्चा नं"], advancePaise: ["Advance", "एडवांस"], daraPaise: ["Dara", "दारा"], millGrossGrams: ["Mill gross", "मिल धर्म कांटा"], millNetGrams: ["Mill net", "मिल शुद्ध"], millBardanaGrams: ["Bardana", "बारदाना"],
  katteCount: ["Katte", "कट्टे"], boreCount: ["Bore", "बोरे"], millDeductionGrams: ["Mill cut", "मिल कटौती"], millDeductionNote: ["Cut for", "कटौती का कारण"], ewayBillNo: ["E-way bill", "ई-वे बिल"], transporter: ["Transporter", "ट्रांसपोर्टर"],
  chargeConfig: ["Charge terms", "शर्तें"], stockDate: ["Purchase day", "खरीद का दिन"], poId: ["PO", "PO"], qtyGrams: ["Quantity", "मात्रा"], poNo: ["PO no.", "PO नं"], validTill: ["Valid till", "मान्य तक"],
  commissionPct: ["Commission %", "कमीशन %"], gaushalaPerQtl: ["Gaushala ₹/qtl", "गौशाला ₹/क्विं"], roleId: ["Role", "भूमिका"], permission: ["Permission", "अनुमति"], label: ["Label", "नाम"],
};
export const fieldWords = (key: string, lang: string) => { const w = FIELDS[key]; return w ? (lang === "hi" ? w[1] : w[0]) : key; };

/** Fields that only the computer cares about: not worth a line in the plain view. */
const NOISE = new Set(["id", "businessId", "createdAt", "updatedAt", "createdBy", "enteredBy", "voidedBy", "approvedBy", "reviewedBy", "katautiTerms", "supplierTerms", "snapshot", "rawResponse", "parsedRows", "pageMeta", "filePaths", "pinHash", "pinSalt", "prefs", "nameHinglishLocked", "scanBatchId", "ocrConfidence"]);

export function fmtValue(key: string, v: unknown, f: Formatter, lang: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return lang === "hi" ? (v ? "हाँ" : "नहीं") : (v ? "yes" : "no");
  if (typeof v === "number") {
    if (key === "ratePaisePerQtl") return f.rate(v);
    if (/Paise$/.test(key)) return f.money(v);
    if (/Grams$/.test(key)) return f.weight(v, { unit: true });
    if (/(At|Date)$/.test(key) && v > 1_000_000_000) return new Date(v * 1000).toLocaleString(lang === "hi" ? "hi-IN" : "en-IN");
    return String(v);
  }
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return dmy(v);
    return v.length > 90 ? v.slice(0, 90) + "…" : v;
  }
  const s = JSON.stringify(v);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

export interface PlainChange { key: string; before: unknown; after: unknown }
/** The rows of the plain view: what changed (before → after), or, for a create/delete, what the record held. */
export function plainChanges(r: AuditRow): PlainChange[] {
  const b = r.before ?? null, a = r.after ?? null;
  if (b && a && r.changedKeys.length) return r.changedKeys.filter((k) => !NOISE.has(k)).map((k) => ({ key: k, before: b[k], after: a[k] }));
  const one = a ?? b;
  if (!one) return [];
  return Object.keys(one).filter((k) => !NOISE.has(k) && one[k] !== null && one[k] !== undefined && one[k] !== "")
    .slice(0, 24).map((k) => ({ key: k, before: a ? undefined : one[k], after: a ? one[k] : undefined }));
}
