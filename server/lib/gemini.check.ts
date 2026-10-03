/* Run: npx tsx server/lib/gemini.check.ts — no network, no real database.
   Google is replaced by a stub, so this checks only how the reader reacts:
   busy and network failures are retried, limits and bad keys are not. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// gemini.ts opens the database on import; point it at a throwaway folder first
process.env.MANDI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mandi-check-"));
const { readSheetReliably, parseQuota, thinkingFor, explainGeminiError } = await import("./gemini.ts");
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

// quota: Google lists the per-minute and the per-day limit together; the daily one decides
const both = (m: string, d: string) => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
  { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: m, quotaDimensions: { model: "gemini-2.5-pro" } },
  { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: d, quotaDimensions: { model: "gemini-2.5-pro" } },
] }] } });
let q = parseQuota(both("10", "20"));
check("minute + day listed: read as the daily limit of 20", q?.kind === "per_day" && q.limit === 20 && !q.notFree, q);
q = parseQuota(both("0", "0"));
check("an allowance of 0: not free on this key, and not worth waiting for", q?.kind === "per_day" && q.limit === 0 && q.notFree === true, q);
check("…and the message says so", /no free reads/.test(explainGeminiError(429, "quota", "AIzaX", both("0", "0"))), explainGeminiError(429, "quota", "AIzaX", both("0", "0")));
/* The project's monthly spend cap in AI Studio: Google sends a 429 with no
   quota violations at all, and no model or wait helps. It must be told apart
   from a daily allowance, and said in words the owner can act on. */
const capped = { error: { code: 429, status: "RESOURCE_EXHAUSTED",
  message: "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap." } };
const qc = parseQuota(capped);
check("a spend cap is not read as a daily quota", qc?.kind === "spend_cap" && qc.spendCap === true, qc);
// a project Google has stopped (its billing account closed): say so plainly, not "this model"
const stopped = explainGeminiError(403, "Your project has been denied access. Please contact support.", "AIzaX");
check("a stopped project is named as such, with where to fix it", /stopped this key's project/.test(stopped) && /Billing/.test(stopped), stopped);
check("…an ordinary refusal keeps the model/billing wording", /may not have access to this model/.test(explainGeminiError(403, "Permission denied on model", "AIzaX")), null);
const capMsg = explainGeminiError(429, "Your project has exceeded its monthly spending cap.", "AIzaX", capped);
check("…and the message names the spend limit and where to raise it",
  /monthly spending limit/.test(capMsg) && /ai\.studio\/spend/.test(capMsg) && /no other model/.test(capMsg), capMsg);
calls = stub([[429, capped]]);
r = await readSheetReliably({ ...opts, model: "gemini-2.5-flash" }, async () => {}, noSleep);
check("a capped project is asked once, not four times", !r.ok && r.attempts === 1 && r.transient === false, { attempts: r.attempts });

calls = stub([[429, both("0", "0")]]);
r = await readSheetReliably({ ...opts, model: "gemini-2.5-pro" }, async () => {}, noSleep);
check("a model with no free use is asked once, not four times", !r.ok && r.attempts === 1 && r.transient === false, { attempts: r.attempts });

// thinking: the least each family allows
check("2.5 Flash: thinking off", JSON.stringify(thinkingFor("gemini-2.5-flash")) === '{"thinkingBudget":0}', thinkingFor("gemini-2.5-flash"));
check("2.5 Pro: its minimum 128", JSON.stringify(thinkingFor("gemini-2.5-pro")) === '{"thinkingBudget":128}', thinkingFor("gemini-2.5-pro"));
check("3.x Flash: a level, not a budget", JSON.stringify(thinkingFor("gemini-3.5-flash-lite")) === '{"thinkingLevel":"low"}', thinkingFor("gemini-3.5-flash-lite"));
check("an unknown family: no thinking setting sent", thinkingFor("gemma-4-27b") === undefined, thinkingFor("gemma-4-27b"));
const sent: boolean[] = [];
let n = 0;
(globalThis as any).fetch = async (_u: string, init: any) => {
  sent.push("thinkingConfig" in JSON.parse(init.body).generationConfig);
  return n++ === 0
    ? new Response(JSON.stringify({ error: { code: 400, message: "thinking_level is not supported by this model." } }), { status: 400 })
    : new Response(JSON.stringify(good), { status: 200 });
};
r = await readSheetReliably({ ...opts, model: "gemini-3.1-flash-lite" }, async () => {}, noSleep);
check("a model that refuses the thinking setting is asked again without it, and reads", r.ok && JSON.stringify(sent) === "[true,false]", sent);
r = await readSheetReliably({ ...opts, model: "gemini-3.1-flash-lite" }, async () => {}, noSleep);
check("…and is not sent it again", r.ok && JSON.stringify(sent) === "[true,false,false]", sent);

console.log(bad === 0 ? "\nAll Gemini retry checks passed." : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
