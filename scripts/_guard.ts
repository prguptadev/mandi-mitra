/* Every script that writes or deletes data imports this first.
 *
 * The end-to-end scripts once pointed at the owner's real database and cleared
 * "today" before running — deleting 72 real slips across two days. They now
 * refuse to start unless they are pointed at a throwaway test database AND a
 * test server, and `npm run test:e2e` is the only supported way to run them.
 */
import path from "node:path";

export const TEST_API = process.env.MANDI_API ?? "";
const dataDir = process.env.MANDI_DATA_DIR ?? "";

const realData = path.resolve(process.cwd(), "data");
const pointsAtReal = !dataDir || path.resolve(dataDir) === realData;
const port = (() => { try { return new URL(TEST_API).port; } catch { return ""; } })();

if (pointsAtReal || !/test/i.test(dataDir) || !TEST_API || port === "8787") {
  console.error(
    "\n  REFUSING TO RUN: this script writes and deletes data.\n" +
    "  It must never touch the real database (data/mandi.db) or the dev server on :8787.\n" +
    "  Run it through:  npm run test:e2e\n",
  );
  process.exit(2);
}
