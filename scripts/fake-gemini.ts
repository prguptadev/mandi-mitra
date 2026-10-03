/* A stand-in for Google's Gemini API, for the end-to-end tests only. The
 * test server is pointed at it with MANDI_GEMINI_BASE, so no real key and no
 * real read is ever used. Each model behaves the way real ones do:
 *   gemini-2.5-flash       daily free limit used up (429, per minute + per day)
 *   gemini-2.5-pro         not free on this key (429, limit 0)
 *   gemini-3.5-flash-lite  rejects our thinking setting (400), then reads the page
 *   gemini-3.8-flash       reads the page, but one gross wrong
 *   gemini-test-pages      a two-page sheet: the PNG page reads whole (with
 *                          an odd cell or two), the JPEG page's answer is cut
 *                          short mid-line, as Google's is at its length limit
 *   gemini-test-pages-whole  the same sheet, the JPEG page read whole: what
 *                          reading that one page again brings back
 *   gemini-test-loose      the owner's sheet with loose packets: RST 1243 (a
 *                          truck), "2+45" and "1-64" with their net in kg (95, 64)
 *   gemini-test-loose-qtl  the same, the loose nets given in quintal (0.95, 0.64)
 *   gemini-test-loose-off  the same, "2+45" with 90 written as its net
 * GET /__calls lists every request, so tests can count them.
 */
import http from "node:http";

export const SHEET_ROWS = [
  { rstNo: "901", adatiName: "फूलसिंह वर्मा", grossQtl: 20.00, katauti: 20, netQtl: 19.80, rate: 3400, confidence: 0.95 },
  { rstNo: "902", adatiName: "शिवम ट्रेडिंग", grossQtl: 10.50, katauti: 11, netQtl: 10.39, rate: 3450, confidence: 0.92 },
  { rstNo: "903", adatiName: "पुष्पेन्द्र यादव", grossQtl: 5.00, katauti: 5, netQtl: 4.95, rate: 3500, confidence: 0.9 },
];

const quota429 = (model: string, limit: number, perDay: boolean) => ({
  error: {
    code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota.",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [
        { quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: String(limit === 0 ? 0 : 10), quotaDimensions: { model } },
        ...(perDay ? [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: String(limit), quotaDimensions: { model } }] : []),
      ] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" },
    ],
  },
});

const page = (rows: unknown[]) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ date: "21-09-2026", rows }) }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 },
});

/* Page 1 of a two-page sheet: where each line sits, a rate written "3450/-"
   and a gross with a letter O in it; page 2 carries on at line 4 and is cut. */
const PAGE_ONE = {
  date: "21-09-2026", millName: "G.R.M", jins: "1509",
  rows: [
    { page: 1, srNo: 1, rstNo: "931", adatiName: "फूलसिंह वर्मा", grossQtl: 20.00, katauti: 20, netQtl: 19.80, rate: 3400, struckThrough: false, lineY: 210, confidence: 0.95 },
    { page: 1, srNo: 2, rstNo: "932", adatiName: "शिवम ट्रेडिंग", grossQtl: 10.50, katauti: 11, netQtl: 10.39, rate: "3450/-", struckThrough: false, lineY: 240, confidence: 0.92 },
    { page: 1, srNo: 3, rstNo: "933", adatiName: "पुष्पेन्द्र यादव", grossQtl: "5.0O", katauti: 5, netQtl: 4.95, rate: 3500, struckThrough: false, lineY: 270, confidence: 0.9 },
  ],
  totalWeightWritten: null,
};
const PAGE_TWO_CUT = '{"date": null, "millName": null, "jins": null, "rows": ['
  + '{"page": 1, "srNo": 4, "rstNo": "934", "adatiName": "वीरेन्द्र जोशी", "grossQtl": 32.50, "katauti": 33, "netQtl": 32.17, "rate": 3500, "struckThrough": false, "lineY": 120, "confidence": 0.9}, '
  + '{"page": 1, "srNo": 5, "rstNo": "935", "adatiName": "अरविन्द ट्रेडिंग", "grossQtl": 14.85, "katauti": 15, "netQtl": 14.70, "rate": 3470, "struckThrough": false, "lineY": 150, "confidence": 0.9}, '
  + '{"page": 1, "srNo": 6, "rstNo": "9';
// page 2 read whole: line 6, with its rate written so it reads "35Z1", and the
// total at the bottom (32.50 + 14.85 + 26.40 gross)
const PAGE_TWO_WHOLE = {
  date: null, millName: null, jins: null,
  rows: [
    { page: 2, srNo: 4, rstNo: "934", adatiName: "वीरेन्द्र जोशी", grossQtl: 32.50, katauti: 33, netQtl: 32.17, rate: 3500, struckThrough: false, lineY: 120, confidence: 0.9 },
    { page: 2, srNo: 5, rstNo: "935", adatiName: "अरविन्द ट्रेडिंग", grossQtl: 14.85, katauti: 15, netQtl: 14.70, rate: 3470, struckThrough: false, lineY: 150, confidence: 0.9 },
    { page: 2, srNo: 6, rstNo: "936", adatiName: "अमित ट्रेडिंग", grossQtl: 26.40, katauti: 26, netQtl: 26.14, rate: "35Z1", struckThrough: false, lineY: 180, confidence: 0.9 },
  ],
  totalWeightWritten: 73.75,
};

/* The owner's sheet: RST 1243 is a truck over the dharam kanta (11.90 qtl,
   katauti 12, net 11.78); "2+45" is 2 loose packets (50 + 45 kg) and "1-64"
   one packet of 64 kg, with no kanta and no katauti, their net written in kg. */
export const LOOSE_ROWS = [
  { page: 1, srNo: 1, rstNo: "1243", adatiName: "जय भारत ट्रेडिंग कंपनी", grossQtl: 11.90, katauti: 12, netQtl: 11.78, rate: 3451, struckThrough: false, lineY: 420, confidence: 0.93 },
  { page: 1, srNo: 2, rstNo: "2+45", adatiName: "विशाल बन्धु जैन", grossQtl: null, katauti: null, netQtl: 95, rate: 3200, struckThrough: false, lineY: 450, confidence: 0.9 },
  { page: 1, srNo: 3, rstNo: "1-64", adatiName: "लोकपाल सिंह", grossQtl: null, katauti: null, netQtl: 64, rate: 3481, struckThrough: false, lineY: 490, confidence: 0.9 },
];
const LOOSE_NET_QTL: Record<string, number> = { "2+45": 0.95, "1-64": 0.64 };
const loosePage = (model: string) => ({
  date: "17/08/26", millName: "A-1", jins: "धान 1509", totalWeightWritten: null,
  rows: LOOSE_ROWS.map((r) => model === "gemini-test-loose-qtl" && r.rstNo in LOOSE_NET_QTL ? { ...r, netQtl: LOOSE_NET_QTL[r.rstNo] }
    : model === "gemini-test-loose-off" && r.rstNo === "2+45" ? { ...r, netQtl: 90 } : r),
});

export function startFakeGemini(port: number) {
  const calls: { model: string; thinking: boolean; at: number }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const url = req.url ?? "";
      if (url === "/__calls") return send(200, calls);
      if (req.method === "GET" && url.startsWith("/v1beta/models?")) {
        return send(200, { models: [
          "gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001",
        ].map((id) => ({
          name: `models/${id}`, displayName: id.toUpperCase(), inputTokenLimit: 1048576,
          supportedGenerationMethods: id.includes("embedding") ? ["embedContent"] : ["generateContent"],
        })) });
      }
      if (req.method === "GET" && url.startsWith("/v1beta/models/")) return send(200, { displayName: url.split("/").pop() });
      const m = url.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
      if (!m) return send(404, { error: { code: 404, message: "not found" } });
      const model = decodeURIComponent(m[1]);
      const cfg = (JSON.parse(body || "{}").generationConfig ?? {}) as Record<string, unknown>;
      calls.push({ model, thinking: "thinkingConfig" in cfg, at: Date.now() });
      if (model === "gemini-2.5-flash") return send(429, quota429(model, 20, true));
      if (model === "gemini-2.5-pro") return send(429, quota429(model, 0, true));
      if (model === "gemini-3.5-flash-lite") {
        if ("thinkingConfig" in cfg) return send(400, { error: { code: 400, message: "thinking_level is not supported by this model." } });
        return send(200, page(SHEET_ROWS));
      }
      if (model === "gemini-3.8-flash") return send(200, page(SHEET_ROWS.map((r) => r.rstNo === "902" ? { ...r, grossQtl: 16.50, netQtl: 16.33 } : r)));
      if (model.startsWith("gemini-test-loose")) {
        return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(loosePage(model)) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 } });
      }
      if (model === "gemini-test-pages" || model === "gemini-test-pages-whole") {
        const parts = (JSON.parse(body || "{}").contents?.[0]?.parts ?? []) as { inlineData?: { mimeType?: string } }[];
        const png = parts.find((x) => x.inlineData)?.inlineData?.mimeType === "image/png";
        const whole = (o: unknown) => send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 } });
        if (png) return whole(PAGE_ONE);
        if (model === "gemini-test-pages-whole") return whole(PAGE_TWO_WHOLE);
        return send(200, { candidates: [{ content: { parts: [{ text: PAGE_TWO_CUT }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 32768 } });
      }
      return send(404, { error: { code: 404, message: `models/${model} is not found` } });
    });
  });
  return new Promise<{ close: () => void }>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ close: () => server.close() }));
  });
}

// run on its own: npx tsx scripts/fake-gemini.ts 8797 (the test runner blocks while a test runs, so it lives in its own process)
if (process.argv[1]?.endsWith("fake-gemini.ts") && process.argv[2]) {
  await startFakeGemini(Number(process.argv[2]));
  console.log(`fake gemini on ${process.argv[2]}`);
}
