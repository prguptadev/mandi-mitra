import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DB_PATH } from "../db/client.ts";

/* Scanning straight from the scanner, on the computer the app runs on.
 *
 * Windows ships a scanner interface (WIA) that Canon's drivers — PIXMA and
 * imageCLASS/MF alike — plug into. PowerShell can drive it through COM with
 * nothing extra installed, so the app runs a small script: pick the scanner,
 * set colour and resolution, scan the whole glass, save a JPEG.
 *
 * Only Windows has WIA. Elsewhere scanning is reported as unavailable. For
 * tests, MANDI_FAKE_SCANNER=<image file> stands in for a scanner.
 */

export const SCRIPT = String.raw`param([string]$Out = "", [string]$DeviceId = "", [int]$Dpi = 300, [int]$Intent = 1, [switch]$List)
$ErrorActionPreference = "Stop"
$step = "start"
try {
  $step = "open Windows scanning (WIA)"
  $dm = New-Object -ComObject WIA.DeviceManager
  $infos = $dm.DeviceInfos
  # collections are walked by number: enumerating them with foreach fails on some drivers ("Specified cast is not valid")
  if ($List) {
    $found = @()
    for ($i = 1; $i -le $infos.Count; $i++) {
      $d = $infos.Item($i)
      if ($d.Type -eq 1) { $found += [pscustomobject]@{ id = [string]$d.DeviceID; name = [string]$d.Properties.Item("Name").Value } }
    }
    ConvertTo-Json -InputObject @($found) -Compress
    exit 0
  }
  $step = "find the scanner"
  $info = $null
  for ($i = 1; $i -le $infos.Count; $i++) {
    $d = $infos.Item($i)
    if ($d.Type -eq 1 -and ($DeviceId -eq "" -or [string]$d.DeviceID -eq $DeviceId)) { $info = $d; break }
  }
  if (-not $info) { [Console]::Error.WriteLine("NO_SCANNER"); exit 2 }
  $step = "connect to the scanner"
  $dev = $info.Connect()
  $item = $dev.Items.Item(1)
  # a property by its id, never by walking the list
  function Prop($id) { try { return $item.Properties.Item([string]$id) } catch { return $null } }
  function SetProp($id, $val) { $p = Prop $id; if ($p) { try { $p.Value = $val } catch {} } }
  function SetMax($id) { $p = Prop $id; if ($p) { try { $p.Value = $p.SubTypeMax } catch {} } }
  $step = "set colour, resolution and the scan area"
  SetProp 6146 $Intent   # 1 colour, 2 greyscale
  SetProp 6147 $Dpi      # horizontal resolution
  SetProp 6148 $Dpi      # vertical resolution
  SetProp 6149 0         # start at the left edge
  SetProp 6150 0         # start at the top edge
  SetMax 6151            # the whole width of the glass
  SetMax 6152            # the whole height of the glass
  $jpeg = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
  $bmp  = "{B96B3CAA-0728-11D3-9D7B-0000F81EF32E}"
  $step = "scan"
  $img = $null
  $tried = @()
  # drivers differ in what they hand over: ask for JPEG, then BMP, then whatever it gives,
  # then through Windows' own transfer window (the way some Canon drivers insist on)
  try { $img = $item.Transfer($jpeg) } catch { $tried += ("jpeg: " + $_.Exception.Message) }
  if (-not $img) { try { $img = $item.Transfer($bmp) } catch { $tried += ("bmp: " + $_.Exception.Message) } }
  if (-not $img) { try { $img = $item.Transfer() } catch { $tried += ("default: " + $_.Exception.Message) } }
  if (-not $img) { try { $cd = New-Object -ComObject WIA.CommonDialog; $img = $cd.ShowTransfer($item, $jpeg, $true) } catch { $tried += ("window: " + $_.Exception.Message) } }
  if (-not $img) { throw ("the scanner gave no image (" + ($tried -join " | ") + ")") }
  $step = "save the picture"
  if ([string]$img.FormatID -ne $jpeg) {
    $ip = New-Object -ComObject WIA.ImageProcess
    $ip.Filters.Add($ip.FilterInfos.Item("Convert").FilterID)
    $ip.Filters.Item(1).Properties.Item("FormatID").Value = $jpeg
    $ip.Filters.Item(1).Properties.Item("Quality").Value = 90
    $img = $ip.Apply($img)
  }
  if (Test-Path $Out) { Remove-Item $Out }
  $img.SaveFile($Out)
  Write-Output "OK"
} catch {
  $code = 0
  try { $code = $_.Exception.HResult } catch {}
  [Console]::Error.WriteLine(("WIA_FAIL " + $code + " " + $step + ": " + $_.Exception.Message))
  exit 3
}
`;

/* The common WIA failures, said the way the operator can act on them. */
const WIA_ERRORS: Record<string, string> = {
  "-2145320958": "Paper jam in the scanner. Clear it and scan again.",                                  // 0x80210002
  "-2145320957": "The feeder is empty. Put the sheet in and scan again.",                                // 0x80210003
  "-2145320955": "The scanner is switched off or offline. Check its power and cable, then scan again.",  // 0x80210005
  "-2145320954": "The scanner is busy. Wait a moment and scan again.",                                    // 0x80210006
  "-2145320953": "The scanner is warming up. Wait a few seconds and scan again.",                         // 0x80210007
  "-2145320952": "The scanner needs attention — check its screen or error light.",                        // 0x80210008
  "-2145320950": "The computer lost contact with the scanner. Check the cable or Wi-Fi and scan again.",  // 0x8021000A
  "-2145320947": "The scanner is in use by another program. Close the other scan window and try again.", // 0x8021000D
  "-2145320939": "The scanner was not found. Check it is switched on and connected.",                    // 0x80210015
  "-2145320938": "The scanner lid is open. Close it and scan again.",                                     // 0x80210016
  "-2145320937": "The scanner lamp is off. Switch the scanner off and on, then scan again.",              // 0x80210017
};

const DATA_DIR = path.dirname(DB_PATH);
const scriptPath = () => {
  const p = path.join(DATA_DIR, "scanner-wia.ps1");
  if (!fs.existsSync(p) || fs.readFileSync(p, "utf8") !== SCRIPT) fs.writeFileSync(p, SCRIPT);
  return p;
};

const fake = () => process.env.MANDI_FAKE_SCANNER || null;
export const scannerAvailable = () => process.platform === "win32" || Boolean(fake());

function runScript(args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath(), ...args], { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { p.kill(); err += "TIMEOUT"; }, timeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }); });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: "", err: e.message }); });
  });
}

export class ScanError extends Error {}

function explain(err: string): string {
  if (err.includes("NO_SCANNER")) return "No scanner is connected to this computer. Switch the Canon on, check its cable or Wi-Fi, and try again.";
  if (err.includes("TIMEOUT")) return "The scanner did not answer in time. Check it is on and not showing an error, then scan again.";
  const code = err.match(/WIA_FAIL (-?\d+)/)?.[1];
  if (code && WIA_ERRORS[code]) return WIA_ERRORS[code];
  if (/ComObject|80040154|class not registered/i.test(err)) return "Windows scanning (WIA) is not available on this computer. Install the Canon scanner driver (IJ Scan Utility / MF Scan Utility package) and try again.";
  // "WIA_FAIL <code> <step>: <message>" — the step says how far it got
  return `The scanner reported a problem while trying to ${err.replace(/^WIA_FAIL -?\d+ /, "").slice(0, 240) || "scan (no details)"}`;
}

/** Scanners connected to this computer. */
export async function listScanners(): Promise<{ id: string; name: string }[]> {
  if (fake()) return [{ id: "fake", name: "Test scanner" }];
  if (process.platform !== "win32") return [];
  const r = await runScript(["-List"], 30_000);
  if (r.code !== 0) throw new ScanError(explain(r.err));
  try {
    const list = JSON.parse(r.out || "[]");
    return (Array.isArray(list) ? list : [list]).filter(Boolean).map((d: { id: string; name: string }) => ({ id: String(d.id), name: String(d.name) }));
  } catch {
    return [];
  }
}

let busy = false;
/** One page from the glass, as JPEG bytes. One scan at a time. */
export async function scanPage(o: { deviceId?: string; dpi: number; color: boolean }): Promise<Buffer> {
  if (busy) throw new ScanError("The scanner is already scanning. Wait for that page to finish.");
  busy = true;
  try {
    const f = fake();
    if (f) {
      await new Promise((r) => setTimeout(r, 150));
      return fs.readFileSync(f);
    }
    if (process.platform !== "win32") throw new ScanError("Scanning from the scanner works in the Windows app. On this computer, upload the scan as a file.");
    const out = path.join(os.tmpdir(), `mandi-scan-${process.pid}-${Date.now()}.jpg`);
    const r = await runScript(["-Out", out, "-Dpi", String(o.dpi), "-Intent", o.color ? "1" : "2", ...(o.deviceId ? ["-DeviceId", o.deviceId] : [])], 180_000);
    if (r.code !== 0 || !fs.existsSync(out)) throw new ScanError(explain(r.err || r.out));
    const bytes = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return bytes;
  } finally {
    busy = false;
  }
}
