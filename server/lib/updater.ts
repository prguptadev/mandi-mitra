import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DB_PATH } from "../db/client.ts";
import { backupNow } from "./backup.ts";

/* Updating the desktop app from an installer the owner downloaded.
 *
 * The owner saves the new MandiMitra-Setup-x.y.z.exe (from GitHub Releases)
 * into a folder — Downloads unless they pick another. "Check for update"
 * finds the newest one there that is newer than this version, and checks its
 * fingerprint against the one GitHub publishes for that release. "Install"
 * takes a backup, starts the installer quietly, and closes the app; the
 * installer opens the new version when it is done. Data is untouched: it
 * lives in AppData, not in the program folder.
 */

const DATA_DIR = path.dirname(DB_PATH);
const CFG_PATH = path.join(DATA_DIR, "update.json");
export const REPO = "prguptadev/mandi-mitra";
const NAME = /^MandiMitra-Setup-(\d+)\.(\d+)\.(\d+)\.exe$/i;

export const appVersion = () => process.env.MANDI_APP_VERSION
  ?? (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).version as string);
export const isDesktop = () => process.env.MANDI_DESKTOP === "1";

const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number(n) || 0);
export function newer(a: string, b: string) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export function updateFolder(): string {
  try {
    const f = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")).folder;
    if (f) return f;
  } catch { /* default */ }
  return path.join(os.homedir(), "Downloads");
}
export function setUpdateFolder(folder: string) {
  if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error("That folder does not exist");
  fs.writeFileSync(CFG_PATH, JSON.stringify({ folder }, null, 2));
}

/** The newest installer in the folder that is newer than this app, if any. */
export function findInstaller() {
  const folder = updateFolder();
  if (!fs.existsSync(folder)) return null;
  let best: { file: string; name: string; version: string } | null = null;
  for (const name of fs.readdirSync(folder)) {
    const m = name.match(NAME);
    if (!m) continue;
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    if (!newer(version, appVersion())) continue;
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

export async function checkForUpdate() {
  const found = findInstaller();
  const gh = await githubReleases();
  let verified: boolean | null = null;
  if (found && gh) {
    const want = gh.digests.get(found.name.toLowerCase());
    verified = want ? want === sha256(found.file) : false;
  }
  return {
    version: appVersion(), desktop: isDesktop(), folder: updateFolder(),
    found: found ? { name: found.name, version: found.version, verified } : null,
    latest: gh?.latest ?? null,
    releasesUrl: `https://github.com/${REPO}/releases`,
  };
}

/** Backs up, starts the installer quietly, and closes the app for it. */
export async function installUpdate(name: string) {
  if (!isDesktop() || process.platform !== "win32") throw new Error("Updates are installed from the Windows app.");
  const found = findInstaller();
  if (!found || found.name !== name) throw new Error("That installer is no longer in the folder, or is not newer than this version.");
  await backupNow("before-update");
  // /S = no questions; --force-run = open the new version when it is done
  spawn(found.file, ["/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  setTimeout(() => process.exit(0), 1500);
  return { installing: found.version };
}
