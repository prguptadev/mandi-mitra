import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "../db/client.ts";
import { DailyListPrefsSchema, type DailyListPrefs } from "./prefs.ts";

/* How each person likes the daily list laid out, kept on this computer (a
   small file next to the database). Not in the database, so it never syncs
   to the other computers, and not in the browser, so it survives the desktop
   app starting on a different local port. */

const FILE = path.join(path.dirname(DB_PATH), "device-prefs.json");

function readAll(): Record<string, { dailyList?: unknown }> {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
}

export function readDevicePrefs(userId: string): DailyListPrefs | null {
  const raw = readAll()[userId]?.dailyList;
  if (!raw) return null;
  const p = DailyListPrefsSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export function writeDevicePrefs(userId: string, dailyList: DailyListPrefs | null) {
  const all = readAll();
  if (dailyList) all[userId] = { dailyList };
  else delete all[userId];
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE);
}
