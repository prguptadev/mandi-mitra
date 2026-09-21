/* Run: npx tsx server/lib/gemini.check.ts — no network, no real database.
   Google is replaced by a stub, so this checks only how the reader reacts:
   busy and network failures are retried, limits and bad keys are not. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// gemini.ts opens the database on import; point it at a throwaway folder first
process.env.MANDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-check-"));
const { readSheetReliably } = await import("./gemini.ts");
const good = { candidates: [{ content: { parts: [{ text: JSON.stringify({ rows: [{ rstNo: "630", adatiName: "राम", grossQtl: 28.6, katautiUnits: 29, netQtl: 28.31, rate: 3450, confidence: 0.9, struckThrough: false }] }) }] }, finishReason: "STOP" }] };
const busy = { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } };
const perDay = { error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }] } };
const badKey = { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } };
function stub(seq: [number, unknown][]) {
  let i = 0;
  (globalThis as any).fetch = async () => { const [s, b] = seq[Math.min(i++, seq.length - 1)]; return new Response(JSON.stringify(b), { status: s }); };
  return () => i;
}
const opts = { apiKey: "AIzaTEST", model: "gemini-2.5-flash", images: [{ base64: "", mimeType: "image/jpeg" }] };
const noSleep = { sleep: async () => {} };
let bad = 0;
const check = (label: string, ok: boolean, got: unknown) => { if (!ok) bad++; console.log(` ${ok ? "PASS" : "FAIL"}  ${label}   ${JSON.stringify(got)}`); };
let calls = stub([[503, busy], [503, busy], [200, good]]);
let r = await readSheetReliably(opts, async () => {}, noSleep);
check("busy twice, then read: succeeds on attempt 3", r.ok && r.attempts === 3 && calls() === 3, { ok: r.ok, attempts: r.attempts });
calls = stub([[503, busy]]);
r = await readSheetReliably(opts, async () => {}, noSleep);
check("busy every time: gives up after 4 attempts, marked transient", !r.ok && r.attempts === 4 && r.transient === true, { attempts: r.attempts, err: r.error });
calls = stub([[429, perDay]]);
r = await readSheetReliably(opts, async () => {}, noSleep);
check("daily limit: no retry (would only spend reads)", !r.ok && r.attempts === 1 && r.quota?.kind === "per_day", { attempts: r.attempts });
calls = stub([[400, badKey]]);
r = await readSheetReliably(opts, async () => {}, noSleep);
check("bad key: no retry", !r.ok && r.attempts === 1, { attempts: r.attempts });
calls = stub([[200, { candidates: [{ content: { parts: [{ text: "not json at all" }] }, finishReason: "STOP" }] }], [200, good]]);
r = await readSheetReliably(opts, async () => {}, noSleep);
check("garbled reply: one more try, then fine", r.ok && r.attempts === 2, { attempts: r.attempts });
(globalThis as any).fetch = async () => { throw new TypeError("fetch failed"); };
r = await readSheetReliably(opts, async () => {}, noSleep);
check("network down: retried, then a plain message", !r.ok && r.attempts === 4 && /network/.test(r.error ?? ""), { attempts: r.attempts, err: r.error });
let recorded = 0;
stub([[503, busy], [200, good]]);
await readSheetReliably(opts, async () => { recorded++; }, noSleep);
check("every attempt is counted in today's usage", recorded === 2, recorded);
console.log(bad === 0 ? "\nAll Gemini retry checks passed." : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
