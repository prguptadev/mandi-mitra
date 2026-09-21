/* Bundles the API server into one file for the desktop app, and copies the
 * database migrations beside it. better-sqlite3 stays outside the bundle:
 * it is a native module, rebuilt for Electron by electron-builder.
 * Usage: node scripts/build-desktop-server.mjs
 */
import { build } from "esbuild";
import fs from "node:fs";

fs.rmSync("desktop-build", { recursive: true, force: true });
await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "desktop-build/server/index.mjs",
  external: ["better-sqlite3"],
  // some bundled packages still call require(); give them one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
fs.cpSync("server/db/migrations", "desktop-build/migrations", { recursive: true });
console.log("desktop-build/server/index.mjs and desktop-build/migrations written");
