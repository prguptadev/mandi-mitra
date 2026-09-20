import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* API keys are encrypted at rest with AES-256-GCM. The key lives in a
 * 0600 file next to the database, generated on first use.
 *
 * Honest limitation: the key file sits on the same disk as the database, so
 * this protects against a leaked DB copy or a backup landing somewhere it
 * shouldn't — not against someone with full access to the machine. Moving the
 * key into the Windows Credential Store is a later step for the Electron build.
 */

const DATA_DIR = process.env.MANDI_DATA_DIR ?? path.resolve(process.cwd(), "data");
const KEY_PATH = path.join(DATA_DIR, ".secret.key");

function masterKey(): Buffer {
  if (fs.existsSync(KEY_PATH)) {
    const buf = fs.readFileSync(KEY_PATH);
    if (buf.length === 32) return buf;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  try { fs.chmodSync(KEY_PATH, 0o600); } catch { /* windows */ }
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(blob: string): string | null {
  try {
    const [v, ivB, tagB, dataB] = blob.split(":");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"));
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Never show a whole key back to the browser. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}
