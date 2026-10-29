const nodemailer = require('nodemailer');

let transporter = null;
let warnedOnce = false;

function getTransporter() {
  if (transporter) return transporter;

  // Preferred: a real SMTP server — a mailbox on the site's own domain
  // (e.g. no-reply@abrehottutoring.com.et) or any transactional-email relay.
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    return transporter;
  }

  // Fallback: plain Gmail (legacy setup, GMAIL_USER/GMAIL_APP_PASSWORD).
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

// Sender identity: MAIL_FROM wins (the domain address people should see),
// otherwise fall back to the Gmail user.
function mailFrom() {
  return process.env.MAIL_FROM || `"Abrehot Online Tutorials" <${process.env.GMAIL_USER || ''}>`;
}

// Fire-and-forget email to the admin. Never throws — a broken mail setup
// should never break the actual API request (submitting a booking, contact
// message, etc. still has to succeed even if the email fails).
async function notifyAdmin(subject, text) {
  const t = getTransporter();
  if (!t || !process.env.ADMIN_EMAIL) {
    if (!warnedOnce) {
      console.log('[mailer] Email notifications are off — set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM (or GMAIL_USER/GMAIL_APP_PASSWORD) and ADMIN_EMAIL in .env to enable them.');
      warnedOnce = true;
    }
    return;
  }
  try {
    await t.sendMail({
      from: mailFrom(),
      to: process.env.ADMIN_EMAIL,
      subject,
      text,
    });
  } catch (err) {
    console.error('[mailer] Failed to send notification email:', err.message);
  }
}

// Fire-and-forget confirmation email to a user (e.g. "your payment was
// approved"). Same contract as notifyAdmin: never throws and never blocks
// the caller when mail isn't configured.
async function sendToUser(to, subject, text) {
  if (!to) return { sent: false, reason: 'no-recipient' };
  const t = getTransporter();
  if (!t) {
    if (!warnedOnce) {
      console.log('[mailer] Email notifications are off — set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM (or GMAIL_USER/GMAIL_APP_PASSWORD) in .env to enable them.');
      warnedOnce = true;
    }
    return { sent: false, reason: 'not-configured' };
  }
  try {
    await t.sendMail({
      from: mailFrom(),
      to,
      subject,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Failed to send user email:', err.message);
    return { sent: false, reason: 'send-failed', message: err.message };
  }
}

module.exports = { notifyAdmin, sendToUser };
