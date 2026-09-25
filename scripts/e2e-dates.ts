/* Dates are the office's own dates, never UTC dates.
 *
 * "Yesterday" once jumped two days and "tomorrow" did nothing, because the day
 * was read in local time and written back through toISOString(). These run in
 * whatever zone the machine is in, and also pinned to Kolkata, so the mistake
 * cannot come back on a laptop set to London. */
import { shiftDay } from "../server/lib/parchaLabels.ts";

let bad = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? " PASS " : " FAIL "} ${label}${ok ? "" : `   got ${String(got)}, wanted ${String(want)}`}`);
};

console.log("A day either side, in the office's own time");
check("yesterday is one day back, not two", shiftDay("2026-09-25", -1), "2026-09-24");
check("tomorrow is one day on", shiftDay("2026-09-25", 1), "2026-09-26");
check("back over a month end", shiftDay("2026-10-01", -1), "2026-09-30");
check("on over a month end", shiftDay("2026-09-30", 1), "2026-10-01");
check("back over a year end", shiftDay("2027-01-01", -1), "2026-12-31");
check("a leap day is not skipped", shiftDay("2028-02-28", 1), "2028-02-29");
check("nothing moves by zero", shiftDay("2026-09-25", 0), "2026-09-25");

console.log(bad === 0 ? "\nA day either side lands on the right day." : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
