/**
 * Send a one-off SMTP test message using the same config as email.service.js.
 *
 * Usage:
 *   node scripts/send-test-email.js --to you@example.com
 *   node scripts/send-test-email.js --to you@example.com --subject "Custom subject"
 *
 * Env: loads backend .env via config.js (SMTP_*, EMAIL_FROM, EMAIL_REPLY_TO).
 */
import nodemailer from 'nodemailer';
import config from '../src/config/config.js';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = { to: '', subject: '' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--to' && args[i + 1]) {
      out.to = args[i + 1].trim();
      i += 1;
    } else if (args[i] === '--subject' && args[i + 1]) {
      out.subject = args[i + 1].trim();
      i += 1;
    } else if (args[i] === '--help' || args[i] === '-h') {
      out.help = true;
    }
  }
  return out;
};

const { to, subject, help } = parseArgs();

if (help || !to) {
  // eslint-disable-next-line no-console
  console.log(`Usage: node scripts/send-test-email.js --to recipient@example.com [--subject "Optional subject"]

Uses SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, EMAIL_FROM from .env`);
  process.exit(help ? 0 : 1);
}

const smtp = config.email?.smtp || {};
const missing = ['host', 'port', 'auth'].filter((key) => {
  if (key === 'auth') return !smtp.auth?.user || !smtp.auth?.pass;
  return !smtp[key];
});
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(`Missing SMTP config: ${missing.join(', ')}. Check SMTP_* and EMAIL_FROM in .env`);
  process.exit(1);
}

const fromRaw = config.email.from;
const from =
  fromRaw && String(fromRaw).includes('<')
    ? fromRaw
    : `Dharwin Business Solutions <${fromRaw}>`;
const replyTo = config.email.replyTo || fromRaw;
const mailSubject = subject || `Dharwin SMTP test — ${new Date().toISOString()}`;
const sentAt = new Date().toLocaleString('en-US', { timeZone: 'UTC' });

const text = [
  'This is a test message from the Dharwin backend SMTP script.',
  '',
  `Sent at (UTC): ${sentAt}`,
  `SMTP host: ${smtp.host}`,
  `SMTP port: ${smtp.port}`,
  `From: ${fromRaw}`,
  '',
  'If you received this, Outlook/Microsoft 365 SMTP is configured correctly.',
].join('\n');

const html = `
  <p>This is a test message from the <strong>Dharwin</strong> backend SMTP script.</p>
  <ul>
    <li><strong>Sent at (UTC):</strong> ${sentAt}</li>
    <li><strong>SMTP host:</strong> ${smtp.host}</li>
    <li><strong>SMTP port:</strong> ${smtp.port}</li>
    <li><strong>From:</strong> ${fromRaw}</li>
  </ul>
  <p>If you received this, Outlook/Microsoft 365 SMTP is configured correctly.</p>
`;

const logSmtpError = (err) => {
  // eslint-disable-next-line no-console
  console.error('SMTP send failed:', err?.message || err);
  if (err?.code) {
    // eslint-disable-next-line no-console
    console.error('  code:', err.code);
  }
  if (err?.responseCode) {
    // eslint-disable-next-line no-console
    console.error('  responseCode:', err.responseCode);
  }
  if (err?.response) {
    // eslint-disable-next-line no-console
    console.error('  response:', err.response);
  }
};

const main = async () => {
  const transporter = nodemailer.createTransport(smtp);

  // eslint-disable-next-line no-console
  console.log(`Verifying SMTP (${smtp.host}:${smtp.port})…`);
  try {
    await transporter.verify();
    // eslint-disable-next-line no-console
    console.log('SMTP connection OK.');
  } catch (err) {
    logSmtpError(err);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Sending test email to ${to}…`);
  try {
    const info = await transporter.sendMail({
      from,
      replyTo,
      to,
      subject: mailSubject,
      text,
      html,
    });
    // eslint-disable-next-line no-console
    console.log('Test email sent.');
    // eslint-disable-next-line no-console
    console.log('  messageId:', info.messageId);
    // eslint-disable-next-line no-console
    console.log('  accepted:', info.accepted?.join(', ') || to);
  } catch (err) {
    logSmtpError(err);
    process.exit(1);
  }
};

main();
