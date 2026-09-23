/* Prints the PowerShell the app hands to Windows scanning (WIA), so the
 * Windows build can check it parses and runs: npx tsx scripts/print-scanner-script.ts > scanner-wia.ps1 */
import { SCRIPT } from "../server/lib/scanner.ts";
process.stdout.write(SCRIPT);
