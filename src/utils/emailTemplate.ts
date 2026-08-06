// backend/src/utils/emailTemplate.ts
//
// Professional, email-client-safe HTML for customer emails (offers, replies,
// thank-yous). Table-based layout with inline styles so it renders correctly
// in Gmail, Outlook, Apple Mail and the rest.
//
// A note on "animation": Gmail strips <style> animations and JS, so email can
// never behave like a web page. This template looks premium *statically*, and
// adds tasteful motion (a soft fade-in, a shimmering accent bar, a button
// hover) as PROGRESSIVE ENHANCEMENT — clients that support it (Apple Mail)
// show it; Gmail simply shows the clean static version. GIFs are the only
// universally-animated element in email; say the word if you want an animated
// logo and I'll prep one.
//
// IMPORTANT: logoUrl and siteUrl must be PUBLIC https URLs (your deployed
// domain / a hosted logo). localhost URLs are dead in a real inbox and a
// localhost-hosted logo shows as a broken image.

type EmailOpts = {
  subject: string;                 // used as the headline + <title> + preview
  message: string;                 // personalized plain text ({{name}} already replaced)
  recipientName?: string;          // only used to derive the hidden preview text
  headline?: string;               // override the big headline (defaults to subject)
  showHeadline?: boolean;          // default true — set false to drop the H1
  preheader?: string;              // hidden inbox-preview text (defaults to a soft line)
  buttonText?: string;
  buttonLink?: string;             // must start with https://
  businessName?: string;           // default "Abhijit Art"
  tagline?: string;                // default "PRINTING & DESIGN STUDIO"
  addressLine?: string;            // default "Berhampore, West Bengal"
  phone?: string;                  // e.g. "7405179066"
  email?: string;                  // e.g. "abhijitart85@gmail.com"
  siteUrl?: string;                // PUBLIC url, e.g. https://abhijitart.com
  siteLabel?: string;              // link text (defaults to the bare domain)
  logoUrl?: string;                // PUBLIC https url to a (ideally white) logo PNG
  unsubscribeNote?: string;        // footer legal line
};

/* palette (literal hex — email needs inline values, no CSS vars) */
const INK = "#241d17";
const INK_2 = "#332a20";
const TERRA = "#d9542f";
const TERRA_DK = "#b23f1e";
const GOLD = "#c9a15a";
const IVORY = "#efeae0";
const CARD = "#ffffff";
const TEXT = "#3c352d";
const MUTE = "#8f8577";
const LINE = "#ece4d6";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* personalized plain text → paragraphs.
   A blank line starts a new paragraph; a single newline becomes a <br>. */
function messageToHtml(message: string): string {
  return String(message ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const html = esc(block.trim()).replace(/\n/g, "<br/>");
      if (!html) return "";
      return `<p style="margin:0 0 18px 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15.5px;line-height:1.7;color:${TEXT};">${html}</p>`;
    })
    .join("");
}

export function renderCustomerEmail(o: EmailOpts): string {
  const biz = o.businessName || "Abhijit Art";
  const tagline = o.tagline || "PRINTING & DESIGN STUDIO";
  const addressLine = o.addressLine || "Berhampore, West Bengal";
  const site = (o.siteUrl || "https://abhijitart.com").replace(/\/$/, "");
  const siteLabel = o.siteLabel || site.replace(/^https?:\/\//, "");
  const showHeadline = o.showHeadline !== false;
  const headline = o.headline || o.subject || "";
  const preheader = o.preheader || `A note from ${biz}${o.recipientName ? ` for ${esc(o.recipientName)}` : ""}.`;

  const contactBits = [
    o.phone ? `<a href="tel:${esc(o.phone)}" style="color:${MUTE};text-decoration:none;">☎ ${esc(o.phone)}</a>` : "",
    o.email ? `<a href="mailto:${esc(o.email)}" style="color:${MUTE};text-decoration:none;">✉ ${esc(o.email)}</a>` : "",
  ].filter(Boolean).join('<span style="color:#cfc6b6;">&nbsp;&nbsp;·&nbsp;&nbsp;</span>');

  /* header brand block — logo image if a public URL is given, else a styled
     wordmark. Image is wrapped so a blocked/broken image still shows the name. */
  const brand = o.logoUrl
    ? `<img src="${esc(o.logoUrl)}" width="150" alt="${esc(biz)}" style="display:block;margin:0 auto 6px;max-width:150px;height:auto;border:0;outline:none;" />
       <div style="font-family:Georgia,'Times New Roman',serif;font-size:13px;letter-spacing:4px;color:${GOLD};text-transform:uppercase;">${esc(tagline)}</div>`
    : `<div style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;letter-spacing:.5px;color:#ffffff;line-height:1;">${esc(biz)}</div>
       <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;letter-spacing:4px;color:${GOLD};text-transform:uppercase;margin-top:8px;">${esc(tagline)}</div>`;

  /* bulletproof CTA button (VML for Outlook, styled anchor everywhere else) */
  const button =
    o.buttonText && o.buttonLink
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px;">
           <tr><td align="center" bgcolor="${TERRA}" style="border-radius:2px;">
             <!--[if mso]>
             <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(o.buttonLink)}" style="height:46px;v-text-anchor:middle;width:230px;" arcsize="4%" strokecolor="${TERRA}" fillcolor="${TERRA}">
             <w:anchorlock/><center style="color:#ffffff;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;">${esc(o.buttonText)}</center>
             </v:roundrect>
             <![endif]-->
             <!--[if !mso]><!-->
             <a class="aa-btn" href="${esc(o.buttonLink)}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:2px;background:${TERRA};">${esc(o.buttonText)}</a>
             <!--<![endif]-->
           </td></tr>
         </table>`
      : "";

  const headlineHtml = showHeadline && headline
    ? `<h1 style="margin:0 0 20px 0;font-family:Georgia,'Times New Roman',serif;font-size:23px;line-height:1.3;font-weight:700;color:${INK};">${esc(headline)}</h1>`
    : "";

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(o.subject)}</title>
  <!--[if mso]><style>* { font-family: Arial, sans-serif !important; }</style><![endif]-->
  <style>
    /* progressive enhancement — Gmail strips most of this, which is fine */
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    a { text-decoration:none; }
    .aa-btn:hover { background:${TERRA_DK} !important; }
    @media (prefers-reduced-motion: no-preference) {
      @keyframes aaFade { from { opacity:0; transform: translateY(10px); } to { opacity:1; transform:none; } }
      @keyframes aaShine { 0% { background-position:0% 0; } 100% { background-position:200% 0; } }
      .aa-card { animation: aaFade .6s ease both; }
      .aa-accent { background-size:200% 100% !important; animation: aaShine 3.2s linear infinite; }
    }
    @media only screen and (max-width:620px) {
      .aa-container { width:100% !important; }
      .aa-pad { padding-left:24px !important; padding-right:24px !important; }
      .aa-head-pad { padding:30px 24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${IVORY};">
  <!-- hidden inbox-preview text -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${IVORY};font-size:1px;line-height:1px;">${esc(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${IVORY};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" class="aa-container aa-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${CARD};border:1px solid ${LINE};border-radius:4px;overflow:hidden;">

          <!-- header -->
          <tr>
            <td class="aa-head-pad" align="center" style="background:${INK};background:linear-gradient(135deg,${INK} 0%,${INK_2} 100%);padding:38px 40px 34px;">
              ${brand}
            </td>
          </tr>
          <!-- terracotta→gold accent bar -->
          <tr>
            <td class="aa-accent" style="height:4px;line-height:4px;font-size:0;background:${TERRA};background:linear-gradient(90deg,${TERRA} 0%,${GOLD} 50%,${TERRA} 100%);">&nbsp;</td>
          </tr>

          <!-- body -->
          <tr>
            <td class="aa-pad" style="padding:38px 44px 30px;">
              ${headlineHtml}
              ${messageToHtml(o.message)}
              ${button ? `<div style="height:8px;line-height:8px;">&nbsp;</div>${button}` : ""}
            </td>
          </tr>

          <!-- divider -->
          <tr>
            <td class="aa-pad" style="padding:0 44px;">
              <div style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</div>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td class="aa-pad" align="center" style="padding:26px 44px 34px;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;color:${INK};margin-bottom:4px;">${esc(biz)}</div>
              <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:${MUTE};margin-bottom:8px;">${esc(addressLine)}</div>
              ${contactBits ? `<div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;margin-bottom:10px;">${contactBits}</div>` : ""}
              <div style="margin-bottom:14px;"><a href="${esc(site)}" target="_blank" style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:700;color:${TERRA};text-decoration:none;">${esc(siteLabel)}</a></div>
              <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#a89e8d;max-width:400px;margin:0 auto;">
                ${o.unsubscribeNote ? esc(o.unsubscribeNote) : `You're receiving this because you're a customer of ${esc(biz)}. Reply with "unsubscribe" and we'll take you off our list.`}
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}