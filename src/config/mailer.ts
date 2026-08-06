// backend/src/config/mailer.ts
import nodemailer from "nodemailer";

/* ══════════════════════════════════════════════════════════════
   TRANSACTIONAL EMAIL

   Env driven (backend/.env):
     SMTP_HOST=smtp.gmail.com
     SMTP_PORT=465
     SMTP_USER=abhijitart85@gmail.com
     SMTP_PASS=<16-char Gmail App Password, NOT the account password>
     MAIL_FROM=Abhijit Art <abhijitart85@gmail.com>
     SITE_URL=http://localhost:5173

   Gmail notes: 465 = implicit SSL, 587 = STARTTLS. The App Password needs
   2-Step Verification on the account, and MAIL_FROM's address must be
   SMTP_USER or a verified "send mail as" alias, or Gmail rewrites/rejects it.

   IMPORTANT — everything here reads process.env LAZILY, on first send.
   ESM hoists all `import` statements above module body code, so
   `dotenv.config()` in server.ts runs AFTER this file has been evaluated.
   Reading env at module top level would capture empty strings and disable
   email even with a correct .env. Deferring the read sidesteps import order
   entirely, so it works however env gets loaded (dotenv, dotenvx, tsx,
   --env-file, or real environment variables in production).
   ══════════════════════════════════════════════════════════════ */

type MailEnv = { host: string; port: number; user: string; pass: string };

const readEnv = (): MailEnv => ({
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
});

/* read at call time, never cached at import time */
export const mailFrom = () =>
  process.env.MAIL_FROM || (process.env.SMTP_USER ? `Abhijit Art <${process.env.SMTP_USER}>` : "Abhijit Art");
export const siteUrl = () => process.env.SITE_URL || "https://abhijitart.com";
export const mailerConfigured = () => {
  const e = readEnv();
  return Boolean(e.host && e.user && e.pass);
};

let cached: nodemailer.Transporter | null = null;
let warned = false;

function getTransporter(): nodemailer.Transporter {
  if (cached) return cached;

  const e = readEnv();
  if (!e.host || !e.user || !e.pass) {
    if (!warned) {
      console.warn("⚠️  Email disabled — SMTP_HOST / SMTP_USER / SMTP_PASS missing from .env");
      warned = true;
    }
    // not cached, so it starts working the moment the env is fixed
    throw new Error(
      "Email is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS in backend/.env, then restart the server.",
    );
  }

  cached = nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.port === 465,
    auth: { user: e.user, pass: e.pass },
    pool: true,        // reuse one connection across a bulk send
    maxConnections: 3,
    maxMessages: 50,
  });
  return cached;
}

/* A stable export that defers to the real transporter on first use, so
   callers can keep doing `transporter.sendMail(...)` unchanged. */
export const transporter = {
  sendMail: (options: nodemailer.SendMailOptions) => getTransporter().sendMail(options),
  verify: () => getTransporter().verify(),
} as unknown as nodemailer.Transporter;

/* Optional boot check — safe to call from server.ts; never throws. */
export async function verifyMailer(): Promise<boolean> {
  try {
    await getTransporter().verify();
    console.log("✅ SMTP ready:", process.env.SMTP_USER);
    return true;
  } catch (err) {
    console.error("❌ SMTP check failed:", (err as Error).message);
    return false;
  }
}

const escapeHtml = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/* ── branded welcome email, sent on signup ──────────────────────────────
   Table-based markup so it survives Gmail and Outlook.
   ─────────────────────────────────────────────────────────────────────── */
export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const first = escapeHtml((name || "there").split(/\s+/)[0]);
  const site = siteUrl();

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f6f8">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:28px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #f0e6dc;font-family:'DM Sans',Arial,Helvetica,sans-serif">
          <tr><td style="background:#2a231d;padding:22px 28px">
            <div style="font-size:19px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">Abhijit Art</div>
            <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#c2974a;margin-top:4px">Printing &amp; Design Studio</div>
          </td></tr>
          <tr><td style="padding:28px">
            <p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#2a231d">Welcome, ${first}!</p>
            <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#2a231d">
              Thanks for creating an account with Abhijit Art. You can now book printing and design
              work online and follow every order from your dashboard.
            </p>
            <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#2a231d">
              Flex banners, visiting cards, LED signage, stickers, mugs, acrylic boards — if it can be
              printed, we can make it.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px">
              <tr><td style="background:#d9542f">
                <a href="${escapeHtml(site)}/services" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none">Browse our services</a>
              </td></tr>
            </table>
            <p style="margin:18px 0 0;font-size:13.5px;line-height:1.6;color:#8a8f9a">
              Need something urgently? Call us on 7405179066 and we'll sort it out.
            </p>
          </td></tr>
          <tr><td style="padding:18px 28px;border-top:1px solid #f0e6dc;background:#fffcf9">
            <div style="font-size:12px;color:#8a8f9a;line-height:1.6">
              Abhijit Art · Berhampore, West Bengal<br/>
              <a href="${escapeHtml(site)}" style="color:#d9542f;text-decoration:none">${escapeHtml(site)}</a>
            </div>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;

  await transporter.sendMail({
    from: mailFrom(),
    to,
    subject: "Welcome to Abhijit Art",
    html,
    text:
      `Welcome, ${name || "there"}!\n\n` +
      `Thanks for creating an account with Abhijit Art. You can now book printing and design work online and follow every order from your dashboard.\n\n` +
      `Browse our services: ${site}/services\n\n` +
      `Need something urgently? Call us on 7405179066.\n\n` +
      `Abhijit Art · Berhampore, West Bengal`,
  });
}