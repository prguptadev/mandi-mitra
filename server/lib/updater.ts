import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DB_PATH, closeBooks, sqlite } from "../db/client.ts";
import { isDiskFull, readJsonFile, renameDurable, writeJsonFile, DISK_FULL } from "../db/durable.ts";
import { backupNow } from "./backup.ts";

/* Updating the desktop app from an installer the owner downloaded.
 *
 * The owner saves the new MandiMitra-Setup-x.y.z.exe (from GitHub Releases)
 * into a folder — Downloads unless they pick another. "Check for update"
 * finds the newest one there that is newer than this version, and checks its
 * fingerprint against the one GitHub publishes for that release. "Install"
 * checks there is room, takes a backup, starts the installer quietly, closes
 * the books and the app; the installer opens the new version when it is done.
 * Data is untouched: it lives in AppData, not in the program folder.
 *
 * The checked installers of the version running now and of the new one are
 * kept on this computer, so a version that cannot open the books can go back
 * to the one before (from its start-up message, or from Settings while that
 * is still safe for the books).
 */

const DATA_DIR = path.dirname(DB_PATH);
const CFG_PATH = path.join(DATA_DIR, "update.json");
export const REPO = "prguptadev/mandi-mitra";
const NAME = /^MandiMitra-Setup-(\d+)\.(\d+)\.(\d+)\.exe$/i;
/** Kept installers: outside the roaming profile on Windows, never in %TEMP% (cleaned by Windows). */
export const INSTALLERS_DIR = process.env.MANDI_INSTALLERS_DIR
  ?? (process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "mandi-mitra-updater", "installers")
    : path.join(DATA_DIR, "installers"));
/** Which version's books (how many database updates) each kept installer opens. */
const KEPT_PATH = path.join(INSTALLERS_DIR, "kept.json");

export const appVersion = () => process.env.MANDI_APP_VERSION
  ?? (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).version as string);
export const isDesktop = () => process.env.MANDI_DESKTOP === "1";

const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
export function newer(a: string, b: string) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

interface UpdateCfg { folder?: string; skip?: string[] }
const readCfg = () => readJsonFile<UpdateCfg>(CFG_PATH).value ?? {};

export function updateFolder(): string {
  return readCfg().folder || path.join(os.homedir(), "Downloads");
}
export function setUpdateFolder(folder: string) {
  if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error("That folder does not exist");
  writeJsonFile(CFG_PATH, { ...readCfg(), folder });
}
/** A version that could not open the books here is not offered again (a newer one is). */
export function rememberBadVersion(version: string) {
  const c = readCfg();
  writeJsonFile(CFG_PATH, { ...c, skip: [...new Set([...(c.skip ?? []), version])].slice(-5) });
}

/** The newest installer in the folder that is newer than this app, if any. */
export function findInstaller() {
  const folder = updateFolder();
  if (!fs.existsSync(folder)) return null;
  const skip = new Set(readCfg().skip ?? []);
  let best: { file: string; name: string; version: string } | null = null;
  for (const name of fs.readdirSync(folder)) {
    const m = name.match(NAME);
    if (!m) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (!newer(version, appVersion()) || skip.has(version)) continue;
    if (!best || newer(version, best.version)) best = { file: path.join(folder, name), name, version };
  }
  return best;
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Newest release on GitHub, and every release's installer fingerprint. Null when offline. */
export async function githubReleases(): Promise<{ latest: { version: string; url: string } | null; digests: Map<string, string> } | null> {
  if (process.env.MANDI_NO_GITHUB === "1") return null; // tests stay offline
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "MandiMitra" }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const list = await res.json() as { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: { name: string; digest?: string | null }[] }[];
    const digests = new Map<string, string>();
    for (const r of list) for (const a of r.assets) if (NAME.test(a.name) && a.digest?.startsWith("sha256:")) digests.set(a.name.toLowerCase(), a.digest.slice(7));
    const rel = list.filter((r) => !r.draft && !r.prerelease).sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : 1))[0];
    return { latest: rel ? { version: rel.tag_name.replace(/^v/, ""), url: rel.html_url } : null, digests };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ kept installers */

interface Kept { versions: Record<string, { migrations: number | null }> }
const readKept = (): Kept => {
  const k = readJsonFile<Kept>(KEPT_PATH).value;
  return { versions: k?.versions ?? {} };
};
/** How many database updates a version's books carry (said by that version at its start, or when it updates). */
export function rememberSchema(version: string, migrations: number) {
  if (!isDesktop()) return;
  const k = readKept();
  if (k.versions[version]?.migrations === migrations) return;
  fs.mkdirSync(INSTALLERS_DIR, { recursive: true });
  writeJsonFile(KEPT_PATH, { versions: { ...k.versions, [version]: { migrations } } });
}
const keptName = (version: string) => `MandiMitra-Setup-${version}.exe`;
const appliedNow = () => {
  try { return (sqlite.prepare("select count(*) as n from __drizzle_migrations").get() as { n: number }).n; } catch { return null; }
};

/**
 * The newest kept installer older than this version. With `schemaNow`, only
 * one that opens books with that many database updates (an older app cannot
 * read tables a newer one changed); `strict` also refuses a version whose
 * books are not known.
 */
export function previousInstaller(schemaNow?: number, strict = false): { version: string; file: string } | null {
  let names: string[];
  try { names = fs.readdirSync(INSTALLERS_DIR); } catch { return null; }
  const kept = readKept().versions;
  const cur = appVersion();
  let best: { version: string; file: string } | null = null;
  for (const name of names) {
    const m = name.match(NAME);
    if (!m) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (!newer(cur, version)) continue;
    const known = kept[version]?.migrations ?? null;
    if (schemaNow !== undefined && (known === null ? strict : known < schemaNow)) continue;
    if (!best || newer(version, best.version)) best = { version, file: path.join(INSTALLERS_DIR, name) };
  }
  return best;
}

/** A checked copy into the kept folder: whole and matching GitHub's fingerprint, or not there at all. */
function keepInstaller(from: string, version: string, digest: string) {
  fs.mkdirSync(INSTALLERS_DIR, { recursive: true });
  const to = path.join(INSTALLERS_DIR, keptName(version));
  const tmp = `${to}.tmp`;
  try {
    fs.copyFileSync(from, tmp);
    if (sha256(tmp) !== digest) return null;
    renameDurable(tmp, to);
    return to;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
/** Only the installers of these versions stay; old ones (about 130 MB each) go. */
function pruneInstallers(keep: string[]) {
  for (const name of fs.readdirSync(INSTALLERS_DIR)) {
    const m = name.match(NAME);
    if (m && !keep.includes(`${m[1]}.${m[2]}.${m[3]}`)) fs.rmSync(path.join(INSTALLERS_DIR, name), { force: true });
  }
}
/** Installer copies earlier versions left in %TEMP% (one per update, never removed). */
export function sweepTempInstallers(dir = os.tmpdir()) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^MandiMitra-Setup-\d+\.\d+\.\d+-[0-9a-f]{8}\.exe$/i.test(name)) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); n++; } catch { /* still running: next time */ }
    }
  } catch { /* no temp folder */ }
  return n;
}

/** An update needs room for the new program, a copy of the books now and one at its first start. */
export function spaceProblem(dir = DATA_DIR, dbBytes = (() => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } })()) {
  let free: number;
  try { const s = fs.statfsSync(dir); free = s.bavail * s.bsize; } catch { return null; } // cannot tell: go ahead
  const need = 2 * dbBytes + 600 * 1024 ** 2;
  if (free >= need) return null;
  return `The disk is nearly full: free at least ${Math.ceil((need - free) / 1024 ** 2)} MB on this computer, then press Install again.`;
}

export const INSTALLER_DID_NOT_START = "Windows did not start the installer, so nothing was changed and the app keeps working. Try again in a minute.";

/**
 * Starts an installer and closes the app for it. Nothing is closed until
 * Windows has actually started it: if it cannot, the app keeps working and
 * says so. Once it runs, the books are closed (everything folded into the
 * main file) at once, well inside the second the installer waits for the app
 * to leave by itself (--updated), and the app exits.
 */
export async function runInstaller(file: string, args: string[]) {
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } catch (e) {
    console.error("[update] the installer did not start:", e);
    throw new Error(INSTALLER_DID_NOT_START);
  }
  const g = globalThis as { __mandiShutdown?: () => void; __mandiExit?: () => void };
  try { (g.__mandiShutdown ?? closeBooks)(); } catch { /* closed already */ }
  // a moment for this request's answer to reach the screen
  setTimeout(() => (g.__mandiExit ? g.__mandiExit() : process.exit(0)), 400);
}

export async function checkForUpdate() {
  const found = findInstaller();
  const gh = await githubReleases();
  let verified: boolean | null = null;
  if (found && gh) {
    const want = gh.digests.get(found.name.toLowerCase());
    verified = want ? want === sha256(found.file) : false;
  }
  const applied = appliedNow();
  const prev = applied === null ? null : previousInstaller(applied, true);
  return {
    version: appVersion(), desktop: isDesktop(), folder: updateFolder(),
    found: found ? { name: found.name, version: found.version, verified } : null,
    latest: gh?.latest ?? null,
    releasesUrl: `https://github.com/${REPO}/releases`,
    /** A kept earlier version this computer can safely go back to. */
    previous: prev ? { version: prev.version } : null,
  };
}

/**
 * Checks there is room, keeps checked copies of this version's installer and
 * the new one, backs up, starts the installer quietly, and closes the app for
 * it. Only an installer whose fingerprint matches the one GitHub published
 * runs: the kept copy is checked and run, so the file cannot be swapped
 * between the check and the start.
 */
export async function installUpdate(name: string) {
  if (!isDesktop() || process.platform !== "win32") throw new Error("Updates are installed from the Windows app.");
  const found = findInstaller();
  if (!found || found.name !== name) throw new Error("That installer is no longer in the folder, or is not newer than this version.");
  const room = spaceProblem();
  if (room) throw new Error(room);
  const gh = await githubReleases();
  if (!gh) throw new Error("The installer can only be checked against GitHub with the internet on. Connect and press Install again.");
  const want = gh.digests.get(found.name.toLowerCase());
  if (!want) throw new Error(`GitHub has no ${found.name} to check this file against. Download it again from the Releases page.`);
  const current = appVersion();
  let copy: string | null;
  try {
    copy = keepInstaller(found.file, found.version, want);
    // this version's own installer, if it is kept or still in the folder: the way back
    const mine = path.join(updateFolder(), keptName(current));
    const mineDigest = gh.digests.get(keptName(current).toLowerCase());
    if (!fs.existsSync(path.join(INSTALLERS_DIR, keptName(current))) && mineDigest && fs.existsSync(mine)) keepInstaller(mine, current, mineDigest);
    const applied = appliedNow();
    if (applied !== null) rememberSchema(current, applied);
    pruneInstallers([current, found.version]);
  } catch (e) {
    throw new Error(isDiskFull(e) ? DISK_FULL : `The installer could not be copied: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!copy) throw new Error(`${found.name} is not the file GitHub published (damaged or changed). Delete it and download it again from the Releases page.`);
  sweepTempInstallers();
  try {
    await backupNow("before-update");
  } catch (e) {
    // the new version copies the books as they are at its own start; only a full disk stops the update here
    if (isDiskFull(e)) throw new Error(DISK_FULL);
  }
  // /S = no questions; --force-run = open the new version when it is done; --updated = it waits for the app to close itself
  await runInstaller(copy, ["/S", "--force-run", "--updated"]);
  return { installing: found.version };
}

/** Settings › "Go back to version X": only while that version can open these books. */
export async function goBack() {
  if (!isDesktop() || process.platform !== "win32") throw new Error("Updates are installed from the Windows app.");
  const applied = appliedNow();
  const prev = applied === null ? null : previousInstaller(applied, true);
  if (!prev) throw new Error("No earlier version that can open these books is kept on this computer.");
  rememberBadVersion(appVersion());
  await runInstaller(prev.file, ["/S", "--force-run", "--updated"]);
  return { installing: prev.version };
}
