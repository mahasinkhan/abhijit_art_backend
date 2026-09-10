// backend/src/utils/invoicePdf.ts
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { drawUpiQr, upiPayload, upiConfigured, UPI_ID } from "./invoiceQr.js";

/* ══════════════════════════════════════════════════════════════
   INVOICE PDF BUILDER

   Renders a real vector PDF (selectable text, not a screenshot) with
   PDFKit — deliberately not Puppeteer, which would pull in ~300MB of
   Chromium and a slow cold start just to print one page.

   Layout mirrors the frontend print template (PrintUtils.ts) so an
   emailed or downloaded invoice looks like the one printed at the
   counter: warm header, Purpose row, Size/Pcs columns, QR + signature,
   grand-total box with Balance due, amount in words.

   Everything that CAN be vector is: the QR is drawn as rects (invoiceQr.ts)
   and the logo is embedded from SVG when one is present. Both used to be
   bitmaps sized around 200dpi at print height, which is what made paper
   copies look soft.

   ── The rupee glyph ──────────────────────────────────────────────
   PDFKit's built-in Helvetica has no ₹ (U+20B9); it renders blank.
   So: if a Unicode TTF is present at backend/assets/, we register it
   and print ₹ properly. Otherwise amounts fall back to "Rs." — wrong
   glyph is worse than a plain prefix on a document a client keeps.

   To get ₹ in the PDF, drop either of these into backend/assets/:
     NotoSans-Regular.ttf + NotoSans-Bold.ttf
     DejaVuSans.ttf       + DejaVuSans-Bold.ttf
   ══════════════════════════════════════════════════════════════ */

/* ── palette, matching the print template ──
   Deliberately much darker than it looks on a monitor. Ink and toner both
   lighten a shade or two on paper: the original terracotta on a near-white
   tint printed washed out, with the table head coming through as an almost
   invisible band. Judge these on paper, not on screen. */
const ACCENT = "#8f3517";   // terracotta
const DEEP   = "#542610";   // darker terracotta for small label text
const INK    = "#241d17";
const BODY   = "#332d26";
const MUTE   = "#5a534b";
const FAINT  = "#7a7168";
const LINE   = "#dbb9a4";   // warm hairline
const HAIR   = "#e8d5c8";   // row separator
const SOFT   = "#f5d3c0";   // table head / totals box fill
const GREEN  = "#0d5228";

export type PdfParty = {
  name?: string; address?: string; phone?: string; email?: string; gstin?: string; pan?: string;
};
export type PdfLine = {
  desc?: string; qty?: number; rate?: number; amount?: number;
  /** "3 × 2" style size label; blank for countable items */
  size?: string;
  /** sqft / piece / metre … printed after qty and rate */
  unit?: string;
  /** pieces at that size — only shown when > 1 */
  pcs?: number;
};
export type PdfInvoice = {
  invNo: string;
  date: string;          // already formatted for display
  time?: string;         // optional HH:MM:SS under the date
  biz: PdfParty;
  client: PdfParty;
  /** one-line job description shown above the items */
  purpose?: string;
  lines: PdfLine[];
  subtotal: number;
  discountAmt: number;
  discountLabel: string; // e.g. "Discount (10%)"
  taxAmt: number;
  taxLabel: string;      // e.g. "GST (9%)"
  /** tax rate — when > 0 the PDF splits it into CGST/SGST like the print copy */
  taxPct?: number;
  total: number;
  paidAmount?: number;   // money received so far — drives the Received line
                         // and the Balance due / Paid-in-full state
  notes?: string;
  warranty?: string;
  siteUrl?: string;
};

/* ── asset resolution ─────────────────────────────────────────
   In dev these live in the frontend's public folder; on a server the
   frontend may not sit next to the backend, so backend/assets/ is
   checked too and the env vars override both.
   ─────────────────────────────────────────────────────────── */
const ASSETS = path.resolve(process.cwd(), "assets");

const firstExisting = (names: string[]) => {
  for (const n of names) {
    const p = path.join(ASSETS, n);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
};

const resolveAsset = (envVar: string, file: string) => {
  const candidates = [
    process.env[envVar] || "",
    path.resolve(process.cwd(), `../frontend/public/images/${file}`),
    path.resolve(process.cwd(), `assets/${file}`),
    path.resolve(process.cwd(), `public/images/${file}`),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
};

/* Deliberately null: the traced SVG came out worse than the bitmap it was
   traced from, so the PDF uses the PNG until a real vector source turns up.
   Set INVOICE_LOGO_SVG to re-enable it. */
const LOGO_SVG_PATH = process.env.INVOICE_LOGO_SVG || null;
const LOGO_PATH     = resolveAsset("INVOICE_LOGO",     "abhijit_art_logo.png");
const QR_PATH       = resolveAsset("INVOICE_QR",       "QR.jpeg");
const SIG_PATH      = resolveAsset("INVOICE_SIGNATURE","Signature.png");

/* svg-to-pdfkit is loaded lazily: if it isn't installed the invoice still
   builds, just with the PNG logo, rather than the whole route failing. */
const SVGtoPDF: ((doc: any, svg: string, x: number, y: number, opts?: any) => void) | null = (() => {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("svg-to-pdfkit");
    return (mod?.default || mod) as any;
  } catch {
    return null;
  }
})();

/** Reads the traced SVG once at boot — it's a few KB and never changes at
 *  runtime, so re-reading it per invoice would just be disk churn. */
const LOGO_SVG: string | null = (() => {
  if (!LOGO_SVG_PATH || !SVGtoPDF) return null;
  try { return fs.readFileSync(LOGO_SVG_PATH, "utf8"); } catch { return null; }
})();

/** The artwork's own width/height ratio, read from its viewBox (or width and
 *  height attributes). svg-to-pdfkit stretches the drawing to fill whatever
 *  box it's handed, so a box with a different ratio squashes the mark — the
 *  ratio has to come from the file rather than being guessed. */
const LOGO_RATIO: number = (() => {
  const FALLBACK = 600 / 418;
  if (!LOGO_SVG) return FALLBACK;
  const vb = LOGO_SVG.match(/viewBox\s*=\s*["']\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  if (vb) {
    const w = parseFloat(vb[1]), h = parseFloat(vb[2]);
    if (w > 0 && h > 0) return w / h;
  }
  const wA = LOGO_SVG.match(/\bwidth\s*=\s*["']([\d.]+)/i);
  const hA = LOGO_SVG.match(/\bheight\s*=\s*["']([\d.]+)/i);
  if (wA && hA) {
    const w = parseFloat(wA[1]), h = parseFloat(hA[1]);
    if (w > 0 && h > 0) return w / h;
  }
  return FALLBACK;
})();

const UNICODE_REG  = firstExisting(["NotoSans-Regular.ttf", "DejaVuSans.ttf"]);
const UNICODE_BOLD = firstExisting(["NotoSans-Bold.ttf", "DejaVuSans-Bold.ttf"]);
/* only claim ₹ support when BOTH weights are available, so regular and
   bold text can't silently use different typefaces */
const HAS_RUPEE_FONT = Boolean(UNICODE_REG && UNICODE_BOLD);

const F_REG  = HAS_RUPEE_FONT ? "Body"     : "Helvetica";
const F_BOLD = HAS_RUPEE_FONT ? "BodyBold" : "Helvetica-Bold";

const RS = HAS_RUPEE_FONT ? "\u20B9" : "Rs.";

/* money formatter — glyph depends on what fonts are available */
const money = (n: number) => {
  const v = (Number.isFinite(n) ? n : 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${RS}${v}`;
};
/* whole-rupee variant used inside the items table, like the print copy */
const money0 = (n: number) =>
  `${RS}${Math.round(Number.isFinite(n) ? n : 0).toLocaleString("en-IN")}`;

const qtyFmt = (n: number) => {
  const v = Number.isFinite(n) ? n : 0;
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
};

/* ── amount in words (Indian numbering) ── */
function amountInWords(n: number): string {
  const ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  const m = Math.round(Number.isFinite(n) ? n : 0);
  if (m === 0) return "Zero Only";
  const b = (x: number): string => {
    if (x < 20) return ones[x];
    if (x < 100) return tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "");
    return ones[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " + b(x % 100) : "");
  };
  let r = "";
  if (m >= 10000000) r += b(Math.floor(m / 10000000)) + " Crore ";
  if (m >= 100000)   r += b(Math.floor((m % 10000000) / 100000)) + " Lakh ";
  if (m >= 1000)     r += b(Math.floor((m % 100000) / 1000)) + " Thousand ";
  r += b(m % 1000);
  return r.trim() + " Only";
}

/* ── page geometry (A4) ── */
const PW  = 595.28;
const PH  = 841.89;
const PAD = 36;                 // horizontal padding of every band
const RIGHT = PW - PAD;
const CW  = RIGHT - PAD;

/* the bottom block (terms + totals) and the thank-you rule are anchored to
   the foot of the page, the way the printed copy fills the sheet */
const THANK_H = 34;
const BOT_MIN = 210;
const PAGE_BOTTOM = PH - 26;

export function buildInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      if (HAS_RUPEE_FONT) {
        doc.registerFont("Body", UNICODE_REG!);
        doc.registerFont("BodyBold", UNICODE_BOLD!);
      }

      const bizName  = (inv.biz.name || "Abhijit Art").trim();
      const paid     = Number.isFinite(inv.paidAmount as number) ? Number(inv.paidAmount) : 0;
      const balance  = Math.max(Number(inv.total) - paid, 0);
      const hasDue   = balance > 0.005;
      const paidFull = !hasDue && Number(inv.total) > 0;
      const hasDisc  = inv.discountAmt > 0.005;
      const taxPct   = Number(inv.taxPct) || 0;
      const hasTax   = inv.taxAmt > 0.005;

      /* ══ HEADER ══════════════════════════════════════════════ */
      let y = 26;
      /* Width follows from the artwork's own ratio, so the mark can't be
         stretched or squashed by the box it's drawn into. */
      const LOGO_H = 58;
      const LOGO_W = Math.round(LOGO_H * LOGO_RATIO);
      let logoW = 0;

      if (LOGO_SVG && SVGtoPDF) {
        try {
          SVGtoPDF(doc, LOGO_SVG, PAD, y + 2, {
            width: LOGO_W, height: LOGO_H,
            assumePt: false,
          });
          logoW = LOGO_W;
        } catch (e) {
          console.warn("[pdf] SVG logo failed, falling back to bitmap:", (e as Error).message);
          logoW = 0;
        }
      }
      if (!logoW && LOGO_PATH) {
        try {
          doc.image(LOGO_PATH, PAD, y + 2, { height: LOGO_H });
          logoW = LOGO_W;                   // reserve; ratio kept by PDFKit
        } catch { logoW = 0; }
      }
      if (!logoW) {
        doc.font(F_BOLD).fontSize(18).fillColor(ACCENT).text(bizName.slice(0, 2).toUpperCase(), PAD, y + 20);
        logoW = 40;
      } else {
        // hairline divider between the mark and the address block
        doc.moveTo(PAD + logoW + 10, y + 4).lineTo(PAD + logoW + 10, y + LOGO_H)
          .lineWidth(0.8).stroke(LINE);
      }

      const bizX = PAD + logoW + 22;
      const bizW = 240;
      let byy = y + 2;

      /* The wordmark is already IN the logo, so repeating the name as text
         here doubles it — the counter print doesn't. Only fall back to a text
         name when no logo could be drawn at all. */
      if (logoW <= 40) {
        doc.font(F_BOLD).fontSize(15).fillColor(INK).text(bizName, bizX, byy, { width: bizW });
        byy = doc.y + 3;
      }

      doc.font(F_REG).fontSize(7.2).fillColor(MUTE);
      const bizLines = [
        ...(inv.biz.address || "").split(/\r?\n/).filter(Boolean),
        inv.biz.phone ? inv.biz.phone : "",
        inv.biz.email ? inv.biz.email : "",
        inv.biz.gstin ? `GSTIN: ${inv.biz.gstin}` : "",
        inv.biz.pan   ? `PAN: ${inv.biz.pan}`     : "",
      ].filter(Boolean);
      for (const l of bizLines) {
        doc.text(l, bizX, byy, { width: bizW });
        byy = doc.y + 0.5;
      }

      // right meta block
      const metaW = 150;
      const metaX = RIGHT - metaW;
      doc.font(F_BOLD).fontSize(13).fillColor(ACCENT)
        .text("INVOICE", metaX, y + 2, { width: metaW, align: "right", characterSpacing: 2.4 });
      let my = y + 24;
      doc.font(F_BOLD).fontSize(6.6).fillColor(MUTE)
        .text("INVOICE NO", metaX, my, { width: metaW, align: "right", characterSpacing: 0.5 });
      doc.font(F_BOLD).fontSize(10).fillColor(INK)
        .text(inv.invNo, metaX, my + 8, { width: metaW, align: "right" });
      my += 26;
      doc.font(F_BOLD).fontSize(6.6).fillColor(MUTE)
        .text("INVOICE DATE", metaX, my, { width: metaW, align: "right", characterSpacing: 0.5 });
      doc.font(F_BOLD).fontSize(10).fillColor(INK)
        .text(inv.date, metaX, my + 8, { width: metaW, align: "right" });
      if (inv.time) {
        doc.font(F_REG).fontSize(6.4).fillColor(FAINT)
          .text(inv.time, metaX, my + 20, { width: metaW, align: "right" });
      }

      y = Math.max(byy, my + 30, y + LOGO_H) + 8;
      doc.rect(0, y, PW, 2).fill(ACCENT);
      y += 2;

      /* ══ BILL TO ═════════════════════════════════════════════ */
      y += 10;
      doc.font(F_BOLD).fontSize(6.6).fillColor(ACCENT)
        .text("BILL TO", PAD, y, { characterSpacing: 1 });
      y = doc.y + 3;
      doc.font(F_BOLD).fontSize(11).fillColor(INK).text(inv.client.name || "—", PAD, y, { width: CW });
      y = doc.y + 1;

      const clientLines = [
        ...(inv.client.address || "").split(/\r?\n/).filter(Boolean),
        inv.client.phone ? inv.client.phone : "",
        inv.client.email ? inv.client.email : "",
        inv.client.gstin ? `GSTIN: ${inv.client.gstin}` : "",
      ].filter(Boolean);
      doc.font(F_REG).fontSize(7.2).fillColor(MUTE);
      for (const l of clientLines) {
        doc.text(l, PAD, y, { width: 330 });
        y = doc.y + 0.5;
      }
      y += 9;
      doc.moveTo(0, y).lineTo(PW, y).lineWidth(0.7).stroke(LINE);

      /* ══ PURPOSE ═════════════════════════════════════════════ */
      if ((inv.purpose || "").trim()) {
        y += 8;
        doc.font(F_BOLD).fontSize(6.6).fillColor(ACCENT)
          .text("PURPOSE", PAD, y + 1.5, { width: 54, characterSpacing: 1 });
        doc.font(F_BOLD).fontSize(9.5).fillColor(INK)
          .text(inv.purpose!.trim(), PAD + 58, y, { width: CW - 58 });
        y = Math.max(doc.y, y + 12) + 7;
        doc.moveTo(0, y).lineTo(PW, y).lineWidth(0.7).stroke(LINE);
      }

      /* ══ ITEMS TABLE ═════════════════════════════════════════ */
      y += 10;

      const W_NUM  = 20;
      const W_SIZE = 54;
      const W_PCS  = 30;
      const W_QTY  = 50;
      const W_RATE = 62;
      const W_DISC = hasDisc ? 46 : 0;
      const W_TAX  = hasTax  ? 42 : 0;
      const W_AMT  = 70;
      const W_DESC = CW - (W_NUM + W_SIZE + W_PCS + W_QTY + W_RATE + W_DISC + W_TAX + W_AMT);

      const X_NUM  = PAD;
      const X_DESC = X_NUM  + W_NUM;
      const X_SIZE = X_DESC + W_DESC;
      const X_PCS  = X_SIZE + W_SIZE;
      const X_QTY  = X_PCS  + W_PCS;
      const X_RATE = X_QTY  + W_QTY;
      const X_DISC = X_RATE + W_RATE;
      const X_TAX  = X_DISC + W_DISC;
      const X_AMT  = X_TAX  + W_TAX;

      const drawHead = (ty: number) => {
        doc.rect(0, ty, PW, 18).fill(SOFT);
        doc.moveTo(0, ty).lineTo(PW, ty).lineWidth(0.8).stroke(LINE);
        doc.font(F_BOLD).fontSize(6.4).fillColor(DEEP);
        const th = ty + 6;
        doc.text("NO.",         X_NUM,  th, { width: W_NUM,  align: "center" });
        doc.text("DESCRIPTION", X_DESC, th, { width: W_DESC });
        doc.text("SIZE",        X_SIZE, th, { width: W_SIZE, align: "center" });
        doc.text("PCS",         X_PCS,  th, { width: W_PCS,  align: "center" });
        doc.text("QTY",         X_QTY,  th, { width: W_QTY,  align: "right" });
        doc.text("RATE",        X_RATE, th, { width: W_RATE, align: "right" });
        if (hasDisc) doc.text("DISC.", X_DISC, th, { width: W_DISC, align: "right" });
        if (hasTax)  doc.text("TAX",   X_TAX,  th, { width: W_TAX,  align: "right" });
        doc.text("AMOUNT",      X_AMT,  th, { width: W_AMT,  align: "right" });
        doc.moveTo(0, ty + 18).lineTo(PW, ty + 18).lineWidth(0.8).stroke(LINE);
        return ty + 18;
      };

      y = drawHead(y);

      const lines = Array.isArray(inv.lines) ? inv.lines : [];
      let totalQty = 0;
      const sub = Number(inv.subtotal) || 0;

      // the items must stop before the anchored bottom block
      const ITEMS_LIMIT = PH - THANK_H - BOT_MIN - 16;

      lines.forEach((it, i) => {
        const desc = (it.desc || "—").trim() || "—";
        const q    = Number(it.qty)  || 0;
        const rate = Number(it.rate) || 0;
        const lt   = q * rate;
        const ld   = hasDisc && sub > 0 ? (lt / sub) * inv.discountAmt : 0;
        const lx   = hasTax  && sub > 0 ? (lt / sub) * inv.taxAmt      : 0;
        totalQty  += q;

        doc.font(F_REG).fontSize(8);
        const h = Math.max(doc.heightOfString(desc, { width: W_DESC - 6 }), 10) + 10;

        if (y + h > ITEMS_LIMIT) {
          doc.addPage();
          y = drawHead(26);
        }

        const ty = y + 5;
        doc.fillColor(MUTE).font(F_REG).fontSize(7.6)
          .text(`${i + 1}.`, X_NUM, ty, { width: W_NUM, align: "center" });
        doc.fillColor(INK).font(F_REG).fontSize(8)
          .text(desc, X_DESC, ty, { width: W_DESC - 6 });
        doc.fontSize(7.6)
          .text(it.size ? String(it.size) : "—", X_SIZE, ty, { width: W_SIZE, align: "center" })
          .text(it.size && Number(it.pcs) > 1 ? String(it.pcs) : "—", X_PCS, ty, { width: W_PCS, align: "center" })
          .text(`${qtyFmt(q)}${it.unit ? " " + it.unit : ""}`, X_QTY, ty, { width: W_QTY, align: "right" })
          .text(`${money0(rate)}${it.unit ? "/" + it.unit : ""}`, X_RATE, ty, { width: W_RATE, align: "right" });
        if (hasDisc) doc.text(money0(ld), X_DISC, ty, { width: W_DISC, align: "right" });
        if (hasTax)  doc.text(money0(lx), X_TAX,  ty, { width: W_TAX,  align: "right" });
        doc.font(F_BOLD).fontSize(8)
          .text(money0(lt - ld + lx), X_AMT, ty, { width: W_AMT, align: "right" });

        y += h;
        doc.moveTo(PAD, y).lineTo(RIGHT, y).lineWidth(0.4).stroke(HAIR);
      });

      if (!lines.length) {
        doc.font(F_REG).fontSize(8).fillColor("#a49a8f")
          .text("No items", PAD, y + 12, { width: CW, align: "center" });
        y += 34;
      }

      /* subtotal strip */
      doc.rect(0, y, PW, 18).fill(SOFT);
      doc.moveTo(0, y).lineTo(PW, y).lineWidth(0.8).stroke(LINE);
      const sy = y + 5.5;
      doc.font(F_BOLD).fontSize(8).fillColor(INK)
        .text("Subtotal", X_DESC, sy, { width: W_DESC })
        .text(qtyFmt(totalQty), X_QTY, sy, { width: W_QTY, align: "right" })
        .text(money0(inv.subtotal), X_RATE, sy, { width: W_RATE, align: "right" });
      if (hasDisc) doc.text(money0(inv.discountAmt), X_DISC, sy, { width: W_DISC, align: "right" });
      if (hasTax)  doc.text(money0(inv.taxAmt),      X_TAX,  sy, { width: W_TAX,  align: "right" });
      doc.text(money0(inv.subtotal - inv.discountAmt), X_AMT, sy, { width: W_AMT, align: "right" });
      y += 18;

      /* ══ BOTTOM BLOCK — anchored to the foot of the page ═════ */
      let botTop = Math.max(y + 14, PH - THANK_H - BOT_MIN);
      if (botTop + BOT_MIN + THANK_H > PH) {
        doc.addPage();
        botTop = PH - THANK_H - BOT_MIN;
      }

      doc.moveTo(0, botTop).lineTo(PW, botTop).lineWidth(0.7).stroke(LINE);

      const L_W = CW * 0.54;
      const L_X = PAD;
      const R_X = PAD + L_W + 16;
      const R_W = CW - L_W - 16;
      doc.moveTo(PAD + L_W + 4, botTop).lineTo(PAD + L_W + 4, PH - THANK_H).lineWidth(0.7).stroke(LINE);

      /* left: terms, warranty, QR + signature */
      let ly = botTop + 10;
      doc.font(F_BOLD).fontSize(7).fillColor(ACCENT).text("Terms & Conditions", L_X, ly);
      ly = doc.y + 1;
      doc.font(F_REG).fontSize(6.6).fillColor(MUTE)
        .text((inv.notes || "").trim() || "Keep the invoices for Future References", L_X, ly, { width: L_W - 10 });
      ly = doc.y + 7;

      if ((inv.warranty || "").trim()) {
        doc.font(F_BOLD).fontSize(7).fillColor(ACCENT).text("Warranty", L_X, ly);
        ly = doc.y + 1;
        doc.font(F_REG).fontSize(6.6).fillColor(MUTE)
          .text(inv.warranty!.trim(), L_X, ly, { width: L_W - 10 });
        ly = doc.y + 7;
      }

      const artBottom = PH - THANK_H - 10;
      const QR = 62;
      const qrY = artBottom - QR - 8;   // leaves a line for the UPI id below
      let qrDrawn = false;

      if (upiConfigured) {
        // vector QR carrying this bill's outstanding amount
        qrDrawn = drawUpiQr(doc, upiPayload(balance, `Invoice ${inv.invNo}`), L_X + 6, qrY, QR);
      }
      if (!qrDrawn && QR_PATH) {
        try { doc.image(QR_PATH, L_X + 6, qrY, { width: QR, height: QR }); qrDrawn = true; }
        catch { /* unreadable QR — skip it rather than fail the invoice */ }
      }
      if (qrDrawn) {
        doc.font(F_BOLD).fontSize(6.4).fillColor(ACCENT)
          .text("Scan to pay", L_X, qrY - 11, { width: QR + 12, align: "center" });
        if (upiConfigured) {
          doc.font(F_REG).fontSize(5.2).fillColor(MUTE)
            .text(UPI_ID, L_X, qrY + QR + 3, { width: QR + 12, align: "center" });
        }
      }

      const sigX = L_X + L_W * 0.48;
      const sigW = L_W * 0.48;
      if (SIG_PATH) {
        try { doc.image(SIG_PATH, sigX + sigW / 2 - 26, artBottom - 40, { height: 26 }); } catch { /* skip */ }
      }
      doc.moveTo(sigX + 8, artBottom - 10).lineTo(sigX + sigW - 8, artBottom - 10).lineWidth(0.6).stroke(FAINT);
      doc.font(F_REG).fontSize(6.2).fillColor(MUTE)
        .text("Authorised Signatory", sigX, artBottom - 6, { width: sigW, align: "center" });

      /* right: tax split, grand total box, amount in words */
      let ry = botTop + 10;
      if (taxPct > 0 && hasTax) {
        const half = inv.taxAmt / 2;
        for (const label of [`CGST @${taxPct / 2}%`, `SGST @${taxPct / 2}%`]) {
          doc.font(F_REG).fontSize(7).fillColor(MUTE)
            .text(label, R_X, ry, { width: R_W / 2 })
            .text(half.toFixed(2), R_X + R_W / 2, ry, { width: R_W / 2, align: "right" });
          ry += 11;
          doc.moveTo(R_X, ry - 2).lineTo(R_X + R_W, ry - 2).lineWidth(0.4).stroke(HAIR);
        }
        ry += 4;
      }

      /* Total, then Received (only when money has come in) and the Balance due
         — which the counter print shows on every unpaid bill, not just partly
         paid ones, so a ₹0-received invoice must still print its due. */
      const showRecv = paid > 0.005;
      const boxH = 40 + (showRecv ? 16 : 0) + (hasDue || paidFull ? 13 : 0);
      doc.rect(R_X, ry, R_W, boxH).fillAndStroke(SOFT, LINE);
      let gy = ry + 9;
      doc.font(F_BOLD).fontSize(8).fillColor(DEEP)
        .text("Total Amount", R_X + 9, gy + 4, { width: R_W * 0.45 });
      doc.font(F_BOLD).fontSize(13).fillColor(ACCENT)
        .text(money(inv.total), R_X + R_W * 0.42, gy - 1, { width: R_W * 0.58 - 9, align: "right" });
      gy += 24;

      if (showRecv) {
        doc.moveTo(R_X + 8, gy - 3).lineTo(R_X + R_W - 8, gy - 3).lineWidth(0.5).stroke(LINE);
        doc.font(F_BOLD).fontSize(6.8).fillColor(GREEN)
          .text("Amount Received", R_X + 9, gy, { width: R_W * 0.55 })
          .text(`-${money(paid)}`, R_X + R_W * 0.45, gy, { width: R_W * 0.55 - 9, align: "right" });
        gy += 13;
      }

      if (hasDue) {
        doc.font(F_BOLD).fontSize(7.6).fillColor(DEEP)
          .text("Balance Due", R_X + 9, gy, { width: R_W * 0.5 })
          .text(money(balance), R_X + R_W * 0.45, gy, { width: R_W * 0.55 - 9, align: "right" });
      } else if (paidFull) {
        doc.font(F_BOLD).fontSize(7.2).fillColor(GREEN)
          .text("PAID IN FULL", R_X, gy, { width: R_W, align: "center", characterSpacing: 0.8 });
      }

      ry += boxH + 8;
      doc.font(F_BOLD).fontSize(6.4).fillColor(ACCENT)
        .text("Total Amount (in words)", R_X, ry, { width: R_W });
      doc.font(F_BOLD).fontSize(7.4).fillColor(INK)
        .text(amountInWords(inv.total), R_X, doc.y + 1, { width: R_W });

      /* ══ THANK YOU ═══════════════════════════════════════════ */
      const tyY = PH - THANK_H + 8;
      doc.font(F_BOLD).fontSize(9).fillColor(ACCENT)
        .text("Thank you for your business!", PAD, tyY, { width: CW, align: "center" });
      const tw = doc.widthOfString("Thank you for your business!");
      const gap = 12;
      doc.opacity(0.7)
        .moveTo(PAD, tyY + 5).lineTo(PAD + CW / 2 - tw / 2 - gap, tyY + 5)
        .moveTo(PAD + CW / 2 + tw / 2 + gap, tyY + 5).lineTo(RIGHT, tyY + 5)
        .lineWidth(0.7).stroke(ACCENT)
        .opacity(1);

      /* ── footer on every page ──────────────────────────────────────────
         The footer sits below the content area. PDFKit auto-paginates as
         soon as text crosses the bottom margin, so writing here naively
         ADDS a page per call — which turned a one-page invoice into three.
         Zero the bottom margin for the duration of the write and restore it
         after, and pass lineBreak:false so nothing can wrap onto a new page.
         ──────────────────────────────────────────────────────────────── */
      const range = doc.bufferedPageRange();
      const pageCount = range.count; // capture before writing; must not grow
      if (pageCount > 1) {
        for (let i = 0; i < pageCount; i++) {
          doc.switchToPage(range.start + i);
          const prevBottom = doc.page.margins.bottom;
          doc.page.margins.bottom = 0;
          doc.font(F_REG).fontSize(6.4).fillColor(FAINT).text(
            `Page ${i + 1} of ${pageCount}`,
            PAD, PH - 14, { width: CW, align: "right", lineBreak: false },
          );
          doc.page.margins.bottom = prevBottom;
        }
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* exported so the route can warn once if ₹ will render as "Rs." */
export const pdfHasRupeeGlyph = HAS_RUPEE_FONT;

/* exported so the email can attach the very same logo file inline (cid).
   Emails need a bitmap — no mail client renders an SVG attachment reliably. */
export const invoiceLogoPath = LOGO_PATH;