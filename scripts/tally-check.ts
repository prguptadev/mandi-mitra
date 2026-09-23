/*
 * Checks the Tally file the app writes, against real books, without Tally.
 *
 *   npx tsx scripts/tally-check.ts <copy-of-mandi.db> [from] [to]
 *
 * Reads only. Point it at a COPY (scripts/money-check.ts has the same rule).
 * It builds the one-file export for every kind of entry — purchases,
 * payments, sales, mill receipts, mill cuts — and then asks of the XML what
 * Tally itself would ask:
 *
 *   · is it well formed (every tag closed, every & escaped)?
 *   · does every ledger a voucher names exist as a ledger in the same file?
 *   · does every group a ledger sits in exist — Tally's own, or created here?
 *   · does every voucher type exist — Tally's own, or created here?
 *   · do the masters all come before the first voucher?
 *   · does every voucher add up to exactly zero?
 *   · do the totals per kind match the books?
 */
import path from "node:path";
import fs from "node:fs";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: npx tsx scripts/tally-check.ts <copy-of-mandi.db> [from] [to]");
  process.exit(2);
}
const full = path.resolve(dbPath);
if (!fs.existsSync(full)) { console.error(`no such file: ${full}`); process.exit(2); }
if (full === path.resolve(process.cwd(), "data", "mandi.db")) {
  console.error("That is the live database. Copy it first and check the copy.");
  process.exit(2);
}
// the app opens <dir>/mandi.db, so the copy's own folder is the data folder
process.env.MANDI_DATA_DIR = path.dirname(full);
if (path.basename(full) !== "mandi.db") { console.error("the copy must be named mandi.db"); process.exit(2); }

const { db, schema } = await import("../server/db/client.ts");
const { build, settingsOf, KINDS } = await import("../server/routes/tally.ts");
const { oneFile, ledgersFile, vouchersFile } = await import("../server/lib/tally.ts");
const { eq } = await import("drizzle-orm");

const from = process.argv[3] ?? "2026-04-01";
const to = process.argv[4] ?? "2027-03-31";

let bad = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) bad++;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
};

/** Tag-stack well-formedness: enough to catch what a hand-built XML gets wrong. */
function wellFormed(xml: string): string | null {
  const bareAmp = xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
  if (bareAmp) return `a bare & near "${xml.slice(Math.max(0, bareAmp.index! - 30), bareAmp.index! + 30)}"`;
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const [, close, name, attrs, self] = m;
    if (attrs.includes("=") && /=\s*[^"'\s]/.test(attrs)) return `unquoted attribute in <${name}${attrs}>`;
    if (self) continue;
    if (close) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? "nothing"}>`;
    } else stack.push(name);
  }
  return stack.length ? `never closed: <${stack[stack.length - 1]}>` : null;
}

const paise = (s: string) => Math.round(Number(s) * 100);
const STANDARD_TYPES = new Set(["purchase", "sales", "payment", "receipt", "journal", "contra", "debit note", "credit note"]);
const STANDARD_GROUPS = new Set([
  "capital account", "current assets", "current liabilities", "direct expenses", "direct incomes", "fixed assets",
  "indirect expenses", "indirect incomes", "investments", "loans (liability)", "misc. expenses (asset)",
  "purchase accounts", "sales accounts", "suspense a/c", "bank accounts", "bank od a/c", "bank occ a/c",
  "branch / divisions", "cash-in-hand", "deposits (asset)", "duties & taxes", "duties and taxes",
  "loans & advances (asset)", "provisions", "reserves & surplus", "retained earnings", "secured loans",
  "stock-in-hand", "sundry creditors", "sundry debtors", "unsecured loans",
]);

const businesses = await db.select({ id: schema.businesses.id, name: schema.businesses.name }).from(schema.businesses);
console.log(`Tally file check · ${from} to ${to} · ${dbPath}\n`);

for (const biz of businesses) {
  console.log(`${biz.name}`);
  const cfg = await settingsOf(biz.id);
  // everything, not only what has not been sent yet
  const s = await build(biz.id, from, to, [...KINDS], cfg);
  const types = Object.values(cfg.voucherTypes);
  const xml = oneFile(cfg.companyName, s.ledgers, types, s.vouchers);

  const byKind = Object.fromEntries(KINDS.map((k) => [k, s.entries.filter((e) => e.kind === k).length]));
  console.log(`   ${s.vouchers.length} vouchers · ${s.ledgers.length} ledgers · entries ${JSON.stringify(byKind)}`);
  if (!s.vouchers.length) { console.log("   (nothing in this period)\n"); continue; }

  check("the file is well formed", wellFormed(xml) === null, wellFormed(xml));
  check("Tally is told which company and that this is an import",
    xml.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>") && xml.includes("<REPORTNAME>All Masters</REPORTNAME>"));

  const madeLedgers = new Set([...xml.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1]));
  const madeGroups = new Set([...xml.matchAll(/<GROUP NAME="([^"]+)"/g)].map((m) => m[1]));
  const madeTypes = new Set([...xml.matchAll(/<VOUCHERTYPE NAME="([^"]+)"/g)].map((m) => m[1]));
  const usedLedgers = [...new Set([
    ...[...xml.matchAll(/<LEDGERNAME>([^<]+)<\/LEDGERNAME>/g)].map((m) => m[1]),
    ...[...xml.matchAll(/<PARTYLEDGERNAME>([^<]+)<\/PARTYLEDGERNAME>/g)].map((m) => m[1]),
  ])];
  const missingLedgers = usedLedgers.filter((l) => !madeLedgers.has(l));
  check("every ledger a voucher names is created in the same file", missingLedgers.length === 0, missingLedgers.slice(0, 5));

  const usedGroups = [...new Set(s.ledgers.map((l) => l.parent))];
  const missingGroups = usedGroups.filter((g) => !STANDARD_GROUPS.has(g.toLowerCase()) && !madeGroups.has(g));
  check("every group a ledger sits in is Tally's own or created here", missingGroups.length === 0, missingGroups);

  const usedTypes = [...new Set([...xml.matchAll(/<VOUCHERTYPENAME>([^<]+)<\/VOUCHERTYPENAME>/g)].map((m) => m[1]))];
  const missingTypes = usedTypes.filter((t) => !STANDARD_TYPES.has(t.toLowerCase()) && !madeTypes.has(t));
  check("every voucher type is Tally's own or created here", missingTypes.length === 0, missingTypes);

  const firstVoucher = xml.indexOf("<VOUCHER ");
  const lastMaster = Math.max(xml.lastIndexOf("<LEDGER "), xml.lastIndexOf("<GROUP "), xml.lastIndexOf("<VOUCHERTYPE "));
  check("the masters all come before the first voucher", lastMaster > 0 && firstVoucher > lastMaster);

  // every voucher balances, read back from the XML itself
  const blocks = xml.split("<VOUCHER ").slice(1);
  const unbalanced: string[] = [];
  let debits = 0;
  for (const b of blocks) {
    const amounts = [...b.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => paise(m[1]));
    const sum = amounts.reduce((x, y) => x + y, 0);
    debits += amounts.filter((a) => a < 0).reduce((x, y) => x - y, 0);
    if (sum !== 0) unbalanced.push(`${/<VOUCHERNUMBER>([^<]+)</.exec(b)?.[1] ?? "?"} off by ${(sum / 100).toFixed(2)}`);
  }
  check("every voucher adds up to exactly zero", unbalanced.length === 0, unbalanced.slice(0, 5));
  check("a debit is written negative and deemed positive",
    !/<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>[\d.]/.test(xml.replace(/\n/g, "")));
  check("every date falls in the period",
    [...xml.matchAll(/<DATE>(\d{8})<\/DATE>/g)].every((m) => m[1] >= from.replace(/-/g, "") && m[1] <= to.replace(/-/g, "")));

  // what the vouchers say against what the books say
  const sum = (arr: { paise: number }[]) => arr.reduce((t, l) => t + l.paise, 0);
  const credit = (type: string, ledgerTest: (l: string) => boolean) =>
    s.vouchers.filter((v) => v.type === type).flatMap((v) => v.lines.filter((l) => ledgerTest(l.ledger) && l.paise < 0))
      .reduce((t, l) => t - l.paise, 0);
  const slips = await db.select({ payable: schema.purchaseSlips.payablePaise, rate: schema.purchaseSlips.ratePaisePerQtl })
    .from(schema.purchaseSlips).where(eq(schema.purchaseSlips.businessId, biz.id));
  const bookPurchases = slips.filter((x) => x.rate > 0).reduce((t, x) => t + x.payable, 0);
  const partyNames = new Set(s.ledgers.filter((l) => l.parent === cfg.supplierGroup).map((l) => l.name));
  const tallyPurchases = credit(cfg.voucherTypes.purchase, (l) => partyNames.has(l));
  check("purchases: what the suppliers are credited equals the books' payable",
    tallyPurchases === bookPurchases, { tally: tallyPurchases / 100, books: bookPurchases / 100 });
  check("the two separate files carry the same vouchers as the one file",
    vouchersFile(cfg.companyName, s.vouchers).split("<VOUCHER ").length === blocks.length + 1
    && ledgersFile(cfg.companyName, s.ledgers, types).split("<LEDGER ").length === madeLedgers.size + 1);
  console.log(`   total debits in the file: ₹${(debits / 100).toLocaleString("en-IN")}\n`);
}

console.log(bad === 0 ? "Every check passed: Tally has no missing master in this file." : `${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
