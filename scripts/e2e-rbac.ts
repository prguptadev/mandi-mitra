import "./_guard.ts";
/* End-to-end: who may do what, on the test database only. Logs in as the
 * seeded operator (Munshi Ji) and accountant (Accounts) and checks each
 * money feature answers 403 or not, exactly as the role presets say.
 * Run through: npm run test:e2e
 */
const BASE = process.env.MANDI_API!;
let bad = 0;
const check = (label: string, ok: boolean, got?: unknown) => {
  if (!ok) bad++;
  console.log(` ${ok ? "PASS" : "FAIL"}  ${label}${got === undefined ? "" : `   ${JSON.stringify(got)}`}`);
};

async function session(name: string, pin: string) {
  let cookie = "";
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const users = (await req("GET", "/auth/users")).json;
  const u = users.find((x: any) => x.name === name);
  const login = await req("POST", "/auth/login", { userId: u.id, pin });
  if (login.status !== 200) throw new Error(`login ${name}: ${login.status}`);
  const me = (await req("GET", "/auth/me")).json;
  const vldm = me.businesses.find((b: any) => b.shortCode === "VLDM");
  if (vldm && me.activeBusinessId !== vldm.businessId) await req("POST", "/auth/switch-business", { businessId: vldm.businessId });
  return { req, perms: new Set<string>((await req("GET", "/auth/me")).json.permissions ?? []) };
}

const owner = await session("Test Owner", process.env.MANDI_PIN ?? "482915");
const op = await session("Munshi Ji", "271830");
const acc = await session("Accounts", "394726");
const loadId = (await owner.req("GET", "/challan")).json.rows[0]?.loadId;

console.log("Owner");
check("sees mill accounts, backups and the money picture", (await owner.req("GET", "/mill-ledger")).status === 200
  && (await owner.req("GET", "/backup")).status === 200 && (await owner.req("GET", "/dashboard/money")).status === 200);
check("has every permission, including the newest", ["challan.write", "millledger.read", "millreceipt.write", "backup.manage", "app.update"].every((p) => owner.perms.has(p)));

console.log("\nOperator (Munshi Ji)");
check("cannot see what mills owe", (await op.req("GET", "/mill-ledger")).status === 403);
check("cannot record money from a mill", (await op.req("POST", "/mill-receipts", { merchantId: "x", receiptDate: "2026-09-27", amountPaise: 100 })).status === 403);
check("can see the challan (trucks)", (await op.req("GET", "/challan")).status === 200);
check("cannot enter the mill's weight cut", !loadId || (await op.req("PUT", `/challan/${loadId}`, { deductionGrams: 1000 })).status === 403);
check("cannot take or download backups", (await op.req("GET", "/backup")).status === 403 && (await op.req("POST", "/backup/run")).status === 403);
check("cannot see the money picture", (await op.req("GET", "/dashboard/money")).status === 403);
const opReg = (await op.req("GET", "/parchas")).json as any[];
check("the parcha register shows it no money received or due", opReg.every((p) => p.receivedPaise === null && p.duePaise === null));
const opDash = (await op.req("GET", "/dashboard")).json;
check("the dashboard shows it no mill balances", opDash.kpis.toReceivePaise === null && opDash.mills.every((m: any) => m.owedPaise === null));
check("can still scan", (await op.req("GET", "/scanner")).status === 200);
check("can read the supplier charges (for the daily list)", (await op.req("GET", "/settings/supplier-charges")).status === 200);
check("cannot change them", (await op.req("PUT", "/settings/supplier-charges", { commissionPct: 0, gaushalaPerQtl: 0 })).status === 403);

console.log("\nAccountant (Accounts)");
check("sees mill accounts and the money picture", (await acc.req("GET", "/mill-ledger")).status === 200 && (await acc.req("GET", "/dashboard/money")).status === 200);
check("may record money from mills", acc.perms.has("millreceipt.write"));
check("cannot enter the mill's weight cut", !loadId || (await acc.req("PUT", `/challan/${loadId}`, { deductionGrams: 1000 })).status === 403);
check("cannot manage backups", (await acc.req("GET", "/backup")).status === 403);
check("cannot change settings", (await acc.req("PUT", "/settings/gemini", { model: "gemini-2.5-flash" })).status === 403);

console.log(bad === 0 ? "\nPermissions hold." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
