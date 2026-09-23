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

export const SCRIPT = String.raw`param([string]$Out = "", [string]$DeviceId = "", [int]$Dpi = 300, [int]$Intent = 1, [switch]$List, [switch]$Diag)
$ErrorActionPreference = "Stop"
$step = "start"
$tried = @()
# the picture formats WIA names; a driver says which of them it can hand over
$jpeg = "{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}"
$bmp  = "{B96B3CAA-0728-11D3-9D7B-0000F81EF32E}"
$png  = "{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}"
$gif  = "{B96B3CB0-0728-11D3-9D7B-0000F81EF32E}"
$tiff = "{B96B3CB1-0728-11D3-9D7B-0000F81EF32E}"
function FormatName($id) {
  if ($id -eq $jpeg) { return "jpeg" } elseif ($id -eq $bmp) { return "bmp" } elseif ($id -eq $png) { return "png" }
  elseif ($id -eq $gif) { return "gif" } elseif ($id -eq $tiff) { return "tiff" } else { return [string]$id }
}
# every read from a driver goes through this: a property some drivers do not have
# must not stop the scan ("Specified cast is not valid" comes from exactly that)
function Try1($block, $what) {
  try { return (& $block) } catch { $script:tried += ($what + ": " + $_.Exception.Message); return $null }
}
try {
  $step = "open Windows scanning (WIA)"
  $dm = New-Object -ComObject WIA.DeviceManager
  $infos = $dm.DeviceInfos
  $step = "look at what is connected"
  # collections are walked by number: enumerating them with foreach fails on some drivers
  $devs = @()
  for ($i = 1; $i -le $infos.Count; $i++) {
    $d = Try1 { $infos.Item($i) } ("device " + $i)
    if (-not $d) { continue }
    $type = Try1 { [int]$d.Type } ("device " + $i + " type")
    $id = Try1 { [string]$d.DeviceID } ("device " + $i + " id")
    $name = Try1 { [string]$d.Properties.Item("Name").Value } ("device " + $i + " name")
    if ($null -eq $type) { $type = 1 }  # a driver that will not say is taken as a scanner
    $devs += [pscustomobject]@{ index = $i; type = $type; id = $id; name = $name; info = $d }
  }
  $scanners = @($devs | Where-Object { $_.type -eq 1 })
  if ($List) {
    ConvertTo-Json -InputObject @($scanners | ForEach-Object { [pscustomobject]@{ id = $_.id; name = $_.name } }) -Compress
    exit 0
  }
  $step = "find the scanner"
  $pick = $null
  foreach ($s in $scanners) { if ($DeviceId -eq "" -or $s.id -eq $DeviceId) { $pick = $s; break } }
  if (-not $pick -and $Diag) {
    ConvertTo-Json -Depth 4 -Compress -InputObject ([pscustomobject]@{ ok = $false; windows = [string]$PSVersionTable.PSVersion;
      devices = @($devs | ForEach-Object { [pscustomobject]@{ index = $_.index; type = $_.type; id = $_.id; name = $_.name } }); notes = $tried })
    exit 0
  }
  if (-not $pick) { [Console]::Error.WriteLine("NO_SCANNER"); exit 2 }
  $step = "connect to the scanner"
  $dev = $pick.info.Connect()
  $step = "find the page to scan"
  $items = Try1 { [int]$dev.Items.Count } "pages"
  $item = Try1 { $dev.Items.Item(1) } "page 1"
  if (-not $item) { throw "the scanner did not offer a page to scan" }
  $step = "ask the scanner what it can give"
  $formats = @()
  $fc = Try1 { [int]$item.Formats.Count } "format list"
  if ($fc) { for ($i = 1; $i -le $fc; $i++) { $f = Try1 { [string]$item.Formats.Item($i) } ("format " + $i); if ($f) { $formats += $f } } }
  # a property by its id, never by walking the list
  function Prop($id) { try { return $item.Properties.Item([string]$id) } catch { return $null } }
  function SetProp($id, $val) { $p = Prop $id; if ($p) { try { $p.Value = $val } catch { $script:tried += ("set " + $id + ": " + $_.Exception.Message) } } }
  function SetMax($id) { $p = Prop $id; if ($p) { try { $p.Value = $p.SubTypeMax } catch { $script:tried += ("set max " + $id + ": " + $_.Exception.Message) } } }
  if ($Diag) {
    $props = @()
    foreach ($id in @(6146, 6147, 6148, 6149, 6150, 6151, 6152, 4104)) {
      $p = Prop $id
      if ($p) {
        $props += [pscustomobject]@{ id = $id; name = (Try1 { [string]$p.Name } ("name of " + $id)); value = (Try1 { [string]$p.Value } ("value of " + $id));
          max = (Try1 { [string]$p.SubTypeMax } ("max of " + $id)) }
      }
    }
    ConvertTo-Json -Depth 4 -Compress -InputObject ([pscustomobject]@{ ok = $true; windows = [string]$PSVersionTable.PSVersion;
      devices = @($devs | ForEach-Object { [pscustomobject]@{ index = $_.index; type = $_.type; id = $_.id; name = $_.name } });
      chosen = [pscustomobject]@{ id = $pick.id; name = $pick.name }; pages = $items;
      canGive = @($formats | ForEach-Object { FormatName $_ }); properties = $props; notes = $tried })
    exit 0
  }
  $step = "set colour, resolution and the scan area"
  SetProp 6146 $Intent   # 1 colour, 2 greyscale
  SetProp 6147 $Dpi      # horizontal resolution
  SetProp 6148 $Dpi      # vertical resolution
  SetProp 6149 0         # start at the left edge
  SetProp 6150 0         # start at the top edge
  SetMax 6151            # the whole width of the glass
  SetMax 6152            # the whole height of the glass
  $step = "scan"
  # ask for what the driver said it can give, JPEG first; then BMP and the rest,
  # then with no format named, then through Windows' own transfer and scan windows
  $order = @()
  foreach ($f in @($jpeg, $bmp, $png, $tiff, $gif)) { if ($formats -contains $f) { $order += $f } }
  foreach ($f in $formats) { if ($order -notcontains $f) { $order += $f } }
  if ($order.Count -eq 0) { $order = @($jpeg, $bmp) }
  $img = $null
  foreach ($f in $order) {
    if (-not $img) { try { $img = $item.Transfer($f) } catch { $tried += ((FormatName $f) + ": " + $_.Exception.Message) } }
  }
  if (-not $img) { try { $img = $item.Transfer() } catch { $tried += ("default: " + $_.Exception.Message) } }
  if (-not $img) { try { $cd = New-Object -ComObject WIA.CommonDialog; $img = $cd.ShowTransfer($item, $jpeg, $true) } catch { $tried += ("transfer window: " + $_.Exception.Message) } }
  if (-not $img) { try { $cd2 = New-Object -ComObject WIA.CommonDialog; $img = $cd2.ShowAcquireImage(1, $Intent, 0, $jpeg, $false, $true, $false) } catch { $tried += ("scan window: " + $_.Exception.Message) } }
  if (-not $img) { throw ("the scanner gave no image (" + ($tried -join " | ") + ")") }
  $step = "save the picture"
  $fmt = Try1 { [string]$img.FormatID } "picture format"
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out }
  $done = $false
  if ($fmt -eq $jpeg) {
    try { $img.SaveFile($Out); $done = $true } catch { $tried += ("save jpeg: " + $_.Exception.Message) }
  }
  if (-not $done) {
    # the driver gave BMP, PNG or TIFF (Canon does): keep what it gave, then make the
    # JPEG with Windows' own picture library, which every PC has
    $step = "keep the picture the scanner gave"
    $ext = ".bmp"
    if ($fmt -eq $png) { $ext = ".png" } elseif ($fmt -eq $tiff) { $ext = ".tif" } elseif ($fmt -eq $gif) { $ext = ".gif" } elseif ($fmt -eq $jpeg) { $ext = ".jpg" }
    $raw = $Out + ".scan" + $ext
    if (Test-Path -LiteralPath $raw) { Remove-Item -LiteralPath $raw }
    $kept = $false
    try { $img.SaveFile($raw); $kept = $true } catch { $tried += ("save as given: " + $_.Exception.Message) }
    if (-not $kept) {
      try { [System.IO.File]::WriteAllBytes($raw, [byte[]]$img.FileData.BinaryData); $kept = $true }
      catch { $tried += ("write bytes: " + $_.Exception.Message) }
    }
    if (-not $kept) { throw ("the picture could not be written (" + ($tried -join " | ") + ")") }
    $step = "turn the picture into a JPEG"
    try {
      Add-Type -AssemblyName System.Drawing
      $pic = [System.Drawing.Image]::FromFile($raw)
      try {
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
        $ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]90)
        $pic.Save($Out, $codec, $ps)
      } finally { $pic.Dispose() }
      $done = $true
    } catch { $tried += ("jpeg via Windows: " + $_.Exception.Message) }
    if (-not $done) {
      # WIA's own converter, last: it is the one that fails on some drivers
      try {
        $ip = New-Object -ComObject WIA.ImageProcess
        $ip.Filters.Add($ip.FilterInfos.Item("Convert").FilterID)
        $ip.Filters.Item(1).Properties.Item("FormatID").Value = $jpeg
        $ip.Filters.Item(1).Properties.Item("Quality").Value = 90
        $img2 = $ip.Apply($img)
        $img2.SaveFile($Out)
        $done = $true
      } catch { $tried += ("jpeg via WIA: " + $_.Exception.Message) }
    }
    try { Remove-Item -LiteralPath $raw } catch { }
    if (-not $done) { throw ("the picture could not be turned into a JPEG (" + ($tried -join " | ") + ")") }
  }
  if (-not (Test-Path -LiteralPath $Out)) { throw ("no picture was written (" + ($tried -join " | ") + ")") }
  Write-Output "OK"
} catch {
  $code = 0
  try { $code = $_.Exception.HResult } catch { }
  $note = ""
  if ($tried.Count -gt 0) { $note = " (tried: " + ($tried -join " | ") + ")" }
  [Console]::Error.WriteLine(("WIA_FAIL " + $code + " " + $step + ": " + $_.Exception.Message + $note))
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
  if (err.includes("NO_SCANNER")) return "No scanner is connected to this computer. Switch the Canon on; on Wi-Fi, add it in Windows Settings → Printers & scanners and install the Canon scanner software (IJ Scan Utility / MF Scan Utility) — a printer added on its own does not scan.";
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
/** What the scanner and its driver say about themselves, for fixing a problem on the spot. */
export async function scannerDetails(): Promise<string> {
  if (fake()) return JSON.stringify({ ok: true, windows: "test", devices: [{ index: 1, type: 1, id: "fake", name: "Test scanner" }], canGive: ["jpeg"] }, null, 1);
  if (process.platform !== "win32") throw new ScanError("The scanner check runs in the Windows app.");
  const r = await runScript(["-Diag"], 60_000);
  if (r.code !== 0) throw new ScanError(explain(r.err || r.out));
  try { return JSON.stringify(JSON.parse(r.out), null, 1); } catch { return r.out || "(the scanner said nothing)"; }
}

/** One page from the glass, as JPEG bytes (or as the driver gave it). One scan at a time. */
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
    // only JPEG and PNG can be read further; anything else means the driver gave
    // something Windows could not convert, and a half-readable page helps nobody
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!jpg && !png) throw new ScanError("The scanner gave the page in a form Windows could not turn into a picture the app can read. Press \"What the scanner says\" below and send those details.");
    return bytes;
  } finally {
    busy = false;
  }
}
