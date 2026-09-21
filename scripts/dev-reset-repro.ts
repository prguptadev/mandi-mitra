import { sqlite } from "../server/db/client.ts";
const id = process.argv[2];
const b = sqlite.prepare("select parsed_rows from scan_batches where id=?").get(id) as any;
const rows = JSON.parse(b.parsed_rows).map((r: any) => ({ ...r, adatiId: null, nameCorrected: false }));
sqlite.prepare("update scan_batches set parsed_rows=? where id=?").run(JSON.stringify(rows), id);
console.log("reset", rows.length, "rows to unfilled");
