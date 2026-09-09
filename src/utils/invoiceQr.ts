// backend/src/utils/invoiceQr.ts
// Draws a UPI payment QR straight into the PDF as vector rectangles. PDFKit has
// no SVG support, but a QR is just a grid of squares — emitting them as filled
// rects gives true vector output that stays crisp at any zoom or print size,
// unlike embedding a bitmap.
import QRCode from "qrcode";

/** Falls back to the studio's own UPI address when the env vars are unset. */
export const UPI_ID   = process.env.UPI_ID   || "9932913826@okbizaxis";
export const UPI_NAME = process.env.UPI_NAME || "Abhijit Art";

export const upiConfigured = Boolean(UPI_ID) && !UPI_ID.startsWith("REPLACE_");

export function upiPayload(amount?: number, note?: string): string {
  const p = new URLSearchParams({ pa: UPI_ID, pn: UPI_NAME, cu: "INR" });
  if (amount && amount > 0.005) p.set("am", amount.toFixed(2));
  if (note) p.set("tn", note.slice(0, 50));
  return `upi://pay?${p.toString()}`;
}

/** Returns false when the QR couldn't be produced, so the caller can fall back
 *  to the bitmap instead of leaving a blank square on the invoice. */
export function drawUpiQr(doc: any, payload: string, x: number, y: number, size: number): boolean {
  try {
    // QRCode.create is the only sync API that exposes the raw module grid.
    // Under ESM the package's shape varies between builds — the named export
    // works locally but can arrive wrapped in .default once bundled — so both
    // are checked before giving up.
    const api: any = (QRCode as any)?.create ? QRCode : (QRCode as any)?.default;
    if (!api?.create) throw new Error("qrcode.create unavailable");

    const qr = api.create(payload, { errorCorrectionLevel: "M" });
    const n: number = qr?.modules?.size;
    const data: ArrayLike<number> = qr?.modules?.data;
    if (!n || !data) throw new Error("empty module grid");

    const cell = size / n;
    doc.save().fillColor("#000000");
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // merge each run of dark modules into one rect — far fewer path ops
        if (!data[r * n + c]) continue;
        let run = 1;
        while (c + run < n && data[r * n + c + run]) run++;
        doc.rect(x + c * cell, y + r * cell, cell * run, cell).fill();
        c += run - 1;
      }
    }
    doc.restore();
    return true;
  } catch (e) {
    console.error("[qr] PDF draw failed:", (e as Error).message);
    return false;
  }
}