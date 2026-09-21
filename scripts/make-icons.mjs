/* Draws the app icon from build/icon.svg:
 *   build/icon.ico     Windows (app, installer, shortcuts): 16–256 px
 *   build/icon.png     512 px
 *   electron/icon.png  256 px, for the window and the splash
 *   public/favicon.png 64 px and public/favicon.svg, for the web app
 * Small sizes get a bolder stroke so the wheat still reads at 16 px.
 * Usage: node scripts/make-icons.mjs   (needs the @resvg/resvg-js dev dependency)
 */
import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const src = fs.readFileSync("build/icon.svg", "utf8");
// at 16 and 24 px the full ear of wheat blurs: draw a bigger stalk with three grains
const SMALL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="0" y="0" width="24" height="24" rx="5" fill="#1a7a56"/>
  <line x1="5" y1="19.5" x2="11" y2="13.5" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
  <ellipse cx="14.2" cy="9.8" rx="3.6" ry="6.6" transform="rotate(45 14.2 9.8)" fill="#ffffff"/>
  <path d="M10.8 13.2 17.6 6.4" stroke="#1a7a56" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;
const draw = (size) => {
  const stroke = size <= 32 ? 2.6 : size <= 48 ? 2.3 : 2;
  const svg = size <= 24 ? SMALL : src.replace("STROKE", String(stroke));
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
};

// an .ico is a small directory followed by PNG images, one per size
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(draw);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
  head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync("build/icon.ico", Buffer.concat([head, ...pngs]));
fs.writeFileSync("build/icon.png", draw(512));
fs.writeFileSync("electron/icon.png", draw(256));
fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/favicon.png", draw(64));
fs.writeFileSync("public/favicon.svg", src.replace("STROKE", "2"));
console.log("icons written:", sizes.join(", "), "px");
