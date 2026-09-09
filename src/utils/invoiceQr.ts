// backend/src/utils/invoiceQr.ts
// Draws a UPI payment QR straight into the PDF as vector rectangles. PDFKit has
// no SVG support, but a QR is just a grid of squares — emitting them as filled
// rects gives true vector output that stays crisp at any zoom or print size,
// unlike embedding a bitmap.
import QRCode from "qrcode";

/** ⚠️ FILL THIS IN — must match the frontend's UPI_ID. */
export const UPI_ID   = process.env.UPI_ID || "REPLACE_WITH_UPI_ID";
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
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const data = qr.modules.data;
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