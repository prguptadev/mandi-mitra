/* Before a sheet photo is uploaded: turn it the right way up (phones store
   rotation as a tag the model may ignore), scale the long side to at most
   3000 px — plenty for handwriting, and far smaller than a 12 MP photo —
   and re-encode as JPEG. PDFs, HEIC (which the browser cannot decode) and
   anything that fails to decode are sent untouched. */

const MAX_SIDE = 3000;

export async function prepareImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#fff"; // a transparent PNG becomes white paper, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.9));
    if (!blob) return file;
    // never make a small, already-upright file bigger
    if (scale === 1 && blob.size >= file.size && /jpe?g/i.test(file.type)) return file;
    return new File([blob], file.name.replace(/\.(png|webp|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
