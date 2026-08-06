// backend/src/utils/invoicePdf.ts
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";

/* ══════════════════════════════════════════════════════════════
   INVOICE PDF BUILDER

   Renders a real vector PDF (selectable text, not a screenshot) with
   PDFKit — deliberately not Puppeteer, which would pull in ~300MB of
   Chromium and a slow cold start just to print one page.

   ── The rupee glyph ──────────────────────────────────────────────
   PDFKit's built-in Helvetica has no ₹ (U+20B9); it renders blank.
   So: if a Unicode TTF is present at backend/assets/, we register it
   and print ₹ properly. Otherwise amounts fall back to "Rs." — wrong
   glyph is worse than a plain prefix on a document a client keeps.

   To get ₹ in the PDF, drop either of these into backend/assets/:
     NotoSans-Regular.ttf + NotoSans-Bold.ttf
     DejaVuSans.ttf       + DejaVuSans-Bold.ttf
   ══════════════════════════════════════════════════════════════ */

/* ── palette, matching the admin UI ── */
const INK = "#1f2430";
const BODY = "#545a67";
const MUTE = "#8a8f9a";
const FAINT = "#b6bac3";
const LINE = "#ececf1";
const SOFT = "#fafbfc";
const TERRA = "#d9542f";

export type PdfParty = {
  name?: string; address?: string; phone?: string; email?: string; gstin?: string; pan?: string;
};
export type PdfLine = { desc?: string; qty?: number; rate?: number; amount?: number };
export type PdfInvoice = {
  invNo: string;
  date: string;          // already formatted for display
  biz: PdfParty;
  client: PdfParty;
  lines: PdfLine[];
  subtotal: number;
  discountAmt: number;
  discountLabel: string; // e.g. "Discount (10%)"
  taxAmt: number;
  taxLabel: string;      // e.g. "GST (9%)"
  total: number;
  notes?: string;
  warranty?: string;
  siteUrl?: string;
};

/* ── font resolution ─────────────────────────────────────────── */
const ASSETS = path.resolve(process.cwd(), "assets");
const firstExisting = (names: string[]) => {
  for (const n of names) {
    const p = path.join(ASSETS, n);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
};
/* ── logo ─────────────────────────────────────────────────────────────
   In dev the file lives in the frontend's public folder; on a server the
   frontend may not sit next to the backend, so backend/assets/ is checked
   too and INVOICE_LOGO can override both.
   ─────────────────────────────────────────────────────────────────────── */
const LOGO_PATH = (() => {
  const candidates = [
    process.env.INVOICE_LOGO || "",
    path.resolve(process.cwd(), "../frontend/public/images/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "assets/abhijit_art_logo.png"),
    path.resolve(process.cwd(), "public/images/abhijit_art_logo.png"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
})();

const UNICODE_REG = firstExisting(["NotoSans-Regular.ttf", "DejaVuSans.ttf"]);
const UNICODE_BOLD = firstExisting(["NotoSans-Bold.ttf", "DejaVuSans-Bold.ttf"]);
/* only claim ₹ support when BOTH weights are available, so regular and
   bold text can't silently use different typefaces */
const HAS_RUPEE_FONT = Boolean(UNICODE_REG && UNICODE_BOLD);

const F_REG = HAS_RUPEE_FONT ? "Body" : "Helvetica";
const F_BOLD = HAS_RUPEE_FONT ? "BodyBold" : "Helvetica-Bold";

/* money formatter — glyph depends on what fonts are available */
const money = (n: number) => {
  const v = (Number.isFinite(n) ? n : 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return HAS_RUPEE_FONT ? `\u20B9${v}` : `Rs.${v}`;
};

const qtyFmt = (n: number) => {
  const v = Number.isFinite(n) ? n : 0;
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
};

/* ── page geometry (A4) ── */
const M = 44;                 // margin
const PW = 595.28;            // A4 width in points
const RIGHT = PW - M;         // 551.28
const CW = RIGHT - M;         // content width

/* item table columns */
const C_NUM = M;
const C_DESC = M + 22;
const C_QTY_R = M + 349;      // right edge of Qty
const C_RATE_R = M + 423;     // right edge of Rate
const C_AMT_R = RIGHT;        // right edge of Amount
const DESC_W = C_QTY_R - C_DESC - 46;

/* last y a content row may occupy; the strip below it belongs to the footer */
const PH = 841.89;            // A4 height in points
const PAGE_BOTTOM = PH - M - 34;

export function buildInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      if (HAS_RUPEE_FONT) {
        doc.registerFont("Body", UNICODE_REG!);
        doc.registerFont("BodyBold", UNICODE_BOLD!);
      }

      const bizName = (inv.biz.name || "Abhijit Art").trim();

      /* ── letterhead: logo left, INVOICE right, on plain white ── */
      const LOGO_H = 48;
      let y = M;
      let headBottom = y + 30;

      let logoDrawn = false;
      if (LOGO_PATH) {
        try {
          // height only — PDFKit keeps the aspect ratio from the image itself
          doc.image(LOGO_PATH, M, y, { height: LOGO_H });
          headBottom = y + LOGO_H;
          logoDrawn = true;
        } catch {
          logoDrawn = false; // unreadable/corrupt file — fall through to text
        }
      }
      if (!logoDrawn) {
        doc.font(F_BOLD).fontSize(21).fillColor(TERRA).text(bizName, M, y + 8);
        headBottom = doc.y;
      }

      doc.fillColor(INK).font(F_BOLD).fontSize(20).text("INVOICE", M, y + 4, { width: CW, align: "right" });
      doc.font(F_REG).fontSize(9).fillColor(MUTE)
        .text(`No: ${inv.invNo}`, M, y + 31, { width: CW, align: "right" })
        .text(`Date: ${inv.date}`, M, y + 44, { width: CW, align: "right" });

      const bizLines = [
        ...(inv.biz.address || "").split(/\r?\n/).filter(Boolean),
        inv.biz.phone ? `Phone: ${inv.biz.phone}` : "",
        inv.biz.email ? `Email: ${inv.biz.email}` : "",
        inv.biz.gstin ? `GSTIN: ${inv.biz.gstin}` : "",
        inv.biz.pan ? `PAN: ${inv.biz.pan}` : "",
      ].filter(Boolean);

      y = Math.max(headBottom, y + 58) + 18;

      doc.font(F_REG).fontSize(9).fillColor(MUTE);
      let by = y;
      for (const l of bizLines) {
        doc.text(l, M, by, { width: 300 });
        by = doc.y + 1;
      }

      /* ── bill to ── */
      y = by + 18;
      doc.font(F_BOLD).fontSize(7.5).fillColor(FAINT)
        .text("BILL TO", M, y, { characterSpacing: 1.2 });
      y = doc.y + 4;
      doc.font(F_BOLD).fontSize(12).fillColor(INK).text(inv.client.name || "—", M, y);
      y = doc.y + 2;

      const clientLines = [
        ...(inv.client.address || "").split(/\r?\n/).filter(Boolean),
        inv.client.phone ? `Phone: ${inv.client.phone}` : "",
        inv.client.email ? `Email: ${inv.client.email}` : "",
        inv.client.gstin ? `GSTIN: ${inv.client.gstin}` : "",
      ].filter(Boolean);

      doc.font(F_REG).fontSize(9).fillColor(MUTE);
      for (const l of clientLines) {
        doc.text(l, M, y, { width: 320 });
        y = doc.y + 1;
      }

      /* ── items table ── */
      y += 20;

      const drawTableHead = (ty: number) => {
        doc.rect(M, ty, CW, 22).fill(SOFT);
        doc.font(F_BOLD).fontSize(7.5).fillColor(MUTE);
        doc.text("#", C_NUM + 4, ty + 7.5, { characterSpacing: 0.7 });
        doc.text("DESCRIPTION", C_DESC, ty + 7.5, { characterSpacing: 0.7 });
        doc.text("QTY", C_QTY_R - 46, ty + 7.5, { width: 46, align: "right", characterSpacing: 0.7 });
        doc.text("RATE", C_RATE_R - 74, ty + 7.5, { width: 74, align: "right", characterSpacing: 0.7 });
        doc.text("AMOUNT", C_AMT_R - 84, ty + 7.5, { width: 84, align: "right", characterSpacing: 0.7 });
        doc.moveTo(M, ty + 22).lineTo(RIGHT, ty + 22).lineWidth(0.7).stroke(LINE);
        return ty + 22;
      };

      y = drawTableHead(y);

      inv.lines.forEach((it, i) => {
        const desc = (it.desc || "—").trim() || "—";
        doc.font(F_REG).fontSize(9.5);
        const h = Math.max(doc.heightOfString(desc, { width: DESC_W }), 12) + 13;

        // page break: repeat the header on the new page so columns stay labelled
        if (y + h > PAGE_BOTTOM) {
          doc.addPage();
          y = drawTableHead(M);
        }

        const ty = y + 7;
        doc.fillColor(MUTE).font(F_REG).fontSize(9)
          .text(String(i + 1), C_NUM, ty, { width: 18, align: "center" });
        doc.fillColor(INK).font(F_REG).fontSize(9.5)
          .text(desc, C_DESC, ty, { width: DESC_W });
        doc.fillColor(INK).font(F_REG).fontSize(9.5)
          .text(qtyFmt(it.qty ?? 0), C_QTY_R - 46, ty, { width: 46, align: "right" });
        doc.text(money(it.rate ?? 0), C_RATE_R - 74, ty, { width: 74, align: "right" });
        doc.text(money((it.qty ?? 0) * (it.rate ?? 0)), C_AMT_R - 84, ty, { width: 84, align: "right" });

        y += h;
        doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.5).stroke("#f4f5f7");
      });

      /* ── totals ── */
      y += 14;
      if (y + 90 > PAGE_BOTTOM) { doc.addPage(); y = M; }

      const TL = M + 300;              // label column left edge
      const row = (label: string, value: string, strong = false) => {
        doc.font(strong ? F_BOLD : F_REG).fontSize(strong ? 12 : 9.5)
          .fillColor(strong ? INK : MUTE)
          .text(label, TL, y, { width: 120 });
        doc.font(F_BOLD).fontSize(strong ? 13 : 9.5)
          .fillColor(strong ? TERRA : INK)
          .text(value, C_AMT_R - 120, y, { width: 120, align: "right" });
        y += strong ? 20 : 15;
      };

      row("Subtotal", money(inv.subtotal));
      if (inv.discountAmt > 0) row(inv.discountLabel, `- ${money(inv.discountAmt)}`);
      if (inv.taxAmt > 0) row(inv.taxLabel, money(inv.taxAmt));

      doc.moveTo(TL, y + 2).lineTo(RIGHT, y + 2).lineWidth(0.8).stroke(LINE);
      y += 10;
      row("Total", money(inv.total), true);

      /* ── notes / warranty ── */
      if ((inv.notes || "").trim() || (inv.warranty || "").trim()) {
        y += 12;
        if (y + 60 > PAGE_BOTTOM) { doc.addPage(); y = M; }
        doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.5).stroke(LINE);
        y += 10;
        if ((inv.notes || "").trim()) {
          doc.font(F_BOLD).fontSize(8.5).fillColor(BODY).text("Notes:", M, y, { continued: true });
          doc.font(F_REG).fillColor(MUTE).text(` ${inv.notes!.trim()}`, { width: CW });
          y = doc.y + 4;
        }
        if ((inv.warranty || "").trim()) {
          doc.font(F_BOLD).fontSize(8.5).fillColor(BODY).text("Warranty:", M, y, { continued: true });
          doc.font(F_REG).fillColor(MUTE).text(` ${inv.warranty!.trim()}`, { width: CW });
          y = doc.y + 4;
        }
      }

      /* ── signature ── */
      y += 26;
      if (y + 60 > PAGE_BOTTOM) { doc.addPage(); y = M + 20; }
      doc.font(F_REG).fontSize(8.5).fillColor(MUTE)
        .text(`For ${bizName}`, RIGHT - 170, y, { width: 170, align: "right" });
      y += 34;
      doc.moveTo(RIGHT - 150, y).lineTo(RIGHT, y).lineWidth(0.8).stroke(INK);
      doc.font(F_BOLD).fontSize(8.5).fillColor(INK)
        .text("Authorized Signatory", RIGHT - 170, y + 5, { width: 170, align: "right" });

      /* ── footer on every page ──────────────────────────────────────────
         The footer sits in the margin strip below the content area. PDFKit
         auto-paginates as soon as text crosses the bottom margin, so writing
         here naively ADDS a page per call — which turned a one-page invoice
         into three. Zero the bottom margin for the duration of the write and
         restore it after, and pass lineBreak:false so nothing can wrap into
         a new page either.
         ──────────────────────────────────────────────────────────────── */
      const range = doc.bufferedPageRange();
      const pageCount = range.count; // capture before writing; must not grow
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(range.start + i);

        const prevBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        const fy = doc.page.height - 30;
        doc.font(F_REG).fontSize(7.5).fillColor(FAINT).text(
          `${bizName} · Berhampore, West Bengal${inv.siteUrl ? "  ·  " + inv.siteUrl : ""}`,
          M, fy, { width: CW / 2, align: "left", lineBreak: false },
        );
        doc.text(
          `Page ${i + 1} of ${pageCount}`,
          M + CW / 2, fy, { width: CW / 2, align: "right", lineBreak: false },
        );

        doc.page.margins.bottom = prevBottom;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* exported so the route can warn once if ₹ will render as "Rs." */
export const pdfHasRupeeGlyph = HAS_RUPEE_FONT;

/* exported so the email can attach the very same logo file inline (cid) */
export const invoiceLogoPath = LOGO_PATH;