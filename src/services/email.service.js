import nodemailer from 'nodemailer';
import config from '../config/config.js';
import logger from '../config/logger.js';
import EmailLog from '../models/emailLog.model.js';
import { getFrontendBaseUrl } from '../utils/emailLinks.js';


const transport = nodemailer.createTransport(config.email.smtp);
/* istanbul ignore next */
if (config.env !== 'test') {
  transport
    .verify()
    .then(() => logger.info('Connected to email server'))
    .catch(() => logger.warn('Unable to connect to email server. Make sure you have configured the SMTP options in .env'));
}

const BRAND_NAME = 'Dharwin Business Solutions';
const DEFAULT_FOOTER_NOTE =
  'This email was sent automatically by Dharwin Business Solutions because of an action in your account or a workflow initiated for you.';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const stripHtml = (value) =>
  String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const truncateText = (value, limit = 280) => {
  const plain = stripHtml(value);
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
};

const compactMetadata = (metadata = {}) =>
  Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'string' && !value.trim()) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );

const formatDateTime = (value, timezone) => {
  if (!value) return 'TBD';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'TBD';
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return 'TBD';
    }
  }
};

const renderParagraphs = (lines = [], fontSize = '15px', color = '#4b5563') =>
  lines
    .filter((line) => line !== undefined && line !== null && String(line).trim())
    .map(
      (line) =>
        `<p style="margin:0 0 12px 0;font-size:${fontSize};line-height:1.7;color:${color};">${escapeHtml(line)}</p>`
    )
    .join('');

const renderDetailRows = (rows = []) => {
  const validRows = rows.filter((row) => row && String(row.value ?? '').trim());
  if (validRows.length === 0) return '';
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 0 0;border:1px solid #e5e7eb;border-radius:12px;background-color:#f8fafc;">
      ${validRows
        .map(
          (row, index) => `
            <tr>
              <td style="padding:12px 16px;font-size:13px;color:#6b7280;font-weight:600;vertical-align:top;${index < validRows.length - 1 ? 'border-bottom:1px solid #e5e7eb;' : ''}">${escapeHtml(row.label)}</td>
              <td style="padding:12px 16px;font-size:13px;color:#111827;vertical-align:top;${index < validRows.length - 1 ? 'border-bottom:1px solid #e5e7eb;' : ''}">${escapeHtml(row.value)}</td>
            </tr>`
        )
        .join('')}
    </table>
  `;
};

const SECTION_TONES = {
  neutral: { bg: '#f8fafc', border: '#e5e7eb', title: '#111827', text: '#475569' },
  info: { bg: '#eff6ff', border: '#bfdbfe', title: '#1d4ed8', text: '#1e3a8a' },
  success: { bg: '#f0fdf4', border: '#bbf7d0', title: '#166534', text: '#166534' },
  warning: { bg: '#fffbeb', border: '#fde68a', title: '#b45309', text: '#92400e' },
};

const renderSectionCard = (section) => {
  if (!section) return '';
  const {
    title = '',
    bodyLines = [],
    detailRows = [],
    bulletItems = [],
    tone = 'neutral',
  } = section;
  const palette = SECTION_TONES[tone] || SECTION_TONES.neutral;
  const validBullets = bulletItems.filter((item) => String(item ?? '').trim());
  const body = renderParagraphs(bodyLines, '14px', palette.text);
  const rows = renderDetailRows(detailRows);
  const bullets =
    validBullets.length > 0
      ? `<ul style="margin:0;padding-left:20px;color:${palette.text};font-size:14px;line-height:1.7;">
          ${validBullets.map((item) => `<li style="margin:0 0 8px 0;">${escapeHtml(item)}</li>`).join('')}
        </ul>`
      : '';
  if (!title && !body && !rows && !bullets) return '';
  return `
    <div style="margin:20px 0;padding:18px 20px;border:1px solid ${palette.border};border-radius:14px;background-color:${palette.bg};">
      ${title ? `<p style="margin:0 0 10px 0;font-size:15px;font-weight:700;color:${palette.title};">${escapeHtml(title)}</p>` : ''}
      ${body}
      ${rows}
      ${bullets}
    </div>
  `;
};

const renderActionButtons = (actions = []) => {
  const validActions = actions.filter((action) => action?.label && action?.href);
  if (validActions.length === 0) return '';
  return `
    <div style="padding:8px 0 0 0;text-align:center;">
      ${validActions
        .map((action, index) => {
          const bg = action.variant === 'secondary' ? '#0f766e' : '#2563eb';
          return `<a href="${escapeHtml(action.href)}" style="display:inline-block;margin:${index === 0 ? '0 8px 8px 0' : '0 8px 8px 0'};padding:13px 24px;background-color:${bg};color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:700;">${escapeHtml(action.label)}</a>`;
        })
        .join('')}
    </div>
  `;
};

const renderFallbackLink = (href, label = 'Open this link in your browser') => {
  if (!href) return '';
  return `
    <div style="margin:20px 0 0 0;padding:16px 18px;border:1px dashed #cbd5e1;border-radius:12px;background-color:#f8fafc;">
      <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#6b7280;">${escapeHtml(label)}</p>
      <p style="margin:0;word-break:break-all;font-size:13px;line-height:1.6;">
        <a href="${escapeHtml(href)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(href)}</a>
      </p>
    </div>
  `;
};

const buildEmailHTML = ({
  badgeText,
  title,
  greeting,
  introLines = [],
  detailRows = [],
  sections = [],
  primaryAction = null,
  secondaryActions = [],
  outroLines = [],
  fallbackUrl = '',
  fallbackLabel = 'If the button above does not work, use this link instead:',
  footerNote = DEFAULT_FOOTER_NOTE,
  preheader = '',
}) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader || title || badgeText || BRAND_NAME)}</span>
        <table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:22px 26px;color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:21px;font-weight:700;">${BRAND_NAME}</td>
                  <td align="right" style="font-size:13px;opacity:0.92;font-weight:600;">${escapeHtml(badgeText)}</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:30px 32px 26px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:26px;line-height:1.3;font-weight:700;color:#111827;">${escapeHtml(title)}</h1>
              ${greeting ? `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.7;color:#374151;">Hello ${escapeHtml(greeting)},</p>` : ''}
              ${renderParagraphs(introLines)}
              ${renderDetailRows(detailRows)}
              ${sections.map((section) => renderSectionCard(section)).join('')}
              ${renderActionButtons([primaryAction, ...secondaryActions])}
              ${renderFallbackLink(fallbackUrl || primaryAction?.href, fallbackLabel)}
              ${renderParagraphs(outroLines, '13px', '#6b7280')}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#94a3b8;font-size:11px;line-height:1.6;">
              <p style="margin:0;">${escapeHtml(footerNote)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
`;

const buildPlainTextEmail = ({
  title,
  greeting,
  introLines = [],
  detailRows = [],
  sections = [],
  primaryAction = null,
  outroLines = [],
  footerLines = [],
}) => {
  const blocks = [];
  if (title) blocks.push(title);
  if (greeting) blocks.push(`Hello ${greeting},`);
  if (introLines.length) blocks.push(introLines.filter(Boolean).join('\n'));
  const validRows = detailRows.filter((row) => row && String(row.value ?? '').trim());
  if (validRows.length) {
    blocks.push(validRows.map((row) => `${row.label}: ${row.value}`).join('\n'));
  }
  sections
    .filter(Boolean)
    .forEach((section) => {
      const lines = [];
      if (section.title) lines.push(section.title);
      if (Array.isArray(section.bodyLines) && section.bodyLines.length) {
        lines.push(...section.bodyLines.filter(Boolean));
      }
      if (Array.isArray(section.detailRows) && section.detailRows.length) {
        lines.push(...section.detailRows.filter((row) => row && String(row.value ?? '').trim()).map((row) => `${row.label}: ${row.value}`));
      }
      if (Array.isArray(section.bulletItems) && section.bulletItems.length) {
        lines.push(...section.bulletItems.filter(Boolean).map((item) => `- ${item}`));
      }
      if (lines.length) blocks.push(lines.join('\n'));
    });
  if (primaryAction?.href) {
    blocks.push(`${primaryAction.label || 'Open link'}: ${primaryAction.href}`);
  }
  if (outroLines.length) blocks.push(outroLines.filter(Boolean).join('\n'));
  if (footerLines.length) blocks.push(footerLines.filter(Boolean).join('\n'));
  return blocks.filter(Boolean).join('\n\n').trim();
};

/**
 * Send an email and log to EmailLog for audit.
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [html]
 * @param {string} [templateName] - Optional template name for audit (e.g. 'resetPassword')
 * @param {Object} [metadata] - Optional metadata for audit
 * @returns {Promise}
 */
const sendEmail = async (to, subject, text, html, templateName = null, metadata = {}) => {
  let logEntry = null;
  try {
    logEntry = await EmailLog.create({
      to: String(to).trim().toLowerCase(),
      subject,
      templateName: templateName || null,
      status: 'pending',
      metadata,
    });
  } catch (logErr) {
    logger.warn(`EmailLog create failed: ${logErr?.message || logErr}`);
  }

  const fromAddress = config.email.from;
  const from =
    fromAddress && fromAddress.includes('<')
      ? fromAddress
      : `Dharwin Business Solutions <${fromAddress}>`;
  const replyTo = config.email.replyTo || 'admin@dharwinbusinesssolutions.com' || fromAddress;

  const msg = {
    from,
    replyTo,
    to,
    subject,
    text,
    ...(html && { html }),
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const maxAttempts = 3;
  const backoffMs = [1000, 2000, 4000];
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await transport.sendMail(msg);
      if (logEntry) {
        await EmailLog.findByIdAndUpdate(logEntry._id, {
          status: 'sent',
          sentAt: new Date(),
        });
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await delay(backoffMs[attempt]);
      }
    }
  }
  if (logEntry) {
    await EmailLog.findByIdAndUpdate(logEntry._id, {
      status: 'failed',
      error: lastErr?.message || String(lastErr),
    }).catch(() => {});
  }
  throw lastErr;
};

/** In-memory queue for bulk emails; drained with concurrency limit to avoid overwhelming SMTP. */
const emailQueue = [];
const QUEUE_CONCURRENCY = 5;
let queueProcessing = false;

const processEmailQueue = async () => {
  if (queueProcessing || emailQueue.length === 0) return;
  queueProcessing = true;
  while (emailQueue.length > 0) {
    const batch = emailQueue.splice(0, QUEUE_CONCURRENCY);
    await Promise.all(
      batch.map((job) =>
        sendEmail(job.to, job.subject, job.text, job.html, job.templateName, job.metadata).catch(
          (err) => logger.warn(`Queued email to ${job.to} failed: ${err?.message || err}`)
        )
      )
    );
  }
  queueProcessing = false;
};

/**
 * Queue an email for throttled sending (use for bulk operations). Auth-critical emails should use sendEmail directly.
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [html]
 * @param {string} [templateName]
 * @param {Object} [metadata]
 */
const queueEmail = (to, subject, text, html, templateName = null, metadata = {}) => {
  emailQueue.push({ to, subject, text, html, templateName, metadata });
  processEmailQueue();
};

/**
 * Send reset password email
 * @param {string} to
 * @param {string} token
 * @param {{ req?: Object, frontendBaseUrl?: string }} [options] - Optional: req for dynamic URL detection, or explicit frontendBaseUrl
 * @returns {Promise}
 */
const sendResetPasswordEmail = async (to, token, options = {}) => {
  const subject = 'Reset your Dharwin password';
  const frontendBase = getFrontendBaseUrl(options.req, options.frontendBaseUrl);
  const resetPasswordUrl = `${frontendBase}/reset-password?token=${token}`;
  const recipientName = options.recipientName || 'there';
  const introLines = [
    'We received a request to reset the password for your Dharwin account.',
    'Use the secure button below to choose a new password.',
  ];
  const sections = [
    {
      title: 'Security note',
      tone: 'warning',
      bodyLines: [
        'If you did not request this change, you can safely ignore this email. Your current password will remain unchanged.',
      ],
    },
  ];
  const primaryAction = { label: 'Reset password', href: resetPasswordUrl };
  const outroLines = ['For security, this reset link expires after a short time.'];
  const text = buildPlainTextEmail({
    title: 'Password reset request',
    greeting: recipientName,
    introLines,
    sections,
    primaryAction,
    outroLines,
  });
  const html = buildEmailHTML({
    badgeText: 'Password reset',
    title: 'Reset your password',
    greeting: recipientName,
    introLines,
    sections,
    primaryAction,
    outroLines,
    preheader: 'Use this secure link to reset your Dharwin password.',
  });
  await sendEmail(to, subject, text, html, 'resetPassword', compactMetadata({ recipientName }));
};

/**
 * Send verification email
 * @param {string} to
 * @param {string} token
 * @param {{ req?: Object, frontendBaseUrl?: string }} [options] - Optional: req for dynamic URL detection, or explicit frontendBaseUrl
 * @returns {Promise}
 */
const sendVerificationEmail = async (to, token, options = {}) => {
  const subject = 'Verify your Dharwin email address';
  const frontendBase = getFrontendBaseUrl(options.req, options.frontendBaseUrl);
  const verificationEmailUrl = `${frontendBase}/authentication/verify-email/?token=${encodeURIComponent(token)}`;
  const recipientName = options.recipientName || 'there';
  const introLines = [
    'Please confirm your email address to finish setting up your Dharwin account.',
  ];
  const sections = [
    {
      title: 'Did not expect this email?',
      tone: 'warning',
      bodyLines: ['If you did not create or update an account, you can ignore this message.'],
    },
  ];
  const primaryAction = { label: 'Verify email', href: verificationEmailUrl };
  const text = buildPlainTextEmail({
    title: 'Verify your email address',
    greeting: recipientName,
    introLines,
    sections,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Email verification',
    title: 'Confirm your email address',
    greeting: recipientName,
    introLines,
    sections,
    primaryAction,
    preheader: 'Confirm your email address to continue using Dharwin.',
  });
  await sendEmail(
    to,
    subject,
    text,
    html,
    'verifyEmail',
    compactMetadata({ recipientName, accountContext: options.accountContext || 'general' })
  );
};

/**
 * Send candidate onboarding/preboarding invitation email with link
 * @param {string} to - Recipient email
 * @param {string} onboardUrl - Full URL for candidate to complete onboarding
 * @returns {Promise}
 */
const sendCandidateInvitationEmail = async (to, onboardUrl, options = {}) => {
  const recipientName = options.recipientName || 'there';
  const inviterName = options.inviterName || 'our team';
  const organisationName = options.organisationName || BRAND_NAME;
  const expiresIn = options.expiresIn || '24 hours';
  const subject = `${organisationName}: complete your onboarding`;
  const introLines = [
    `${inviterName} invited you to complete your onboarding in ${organisationName}.`,
    'Use the secure link below to review your details and finish the onboarding steps.',
  ];
  const detailRows = [
    { label: 'Invited by', value: inviterName },
    { label: 'Organisation', value: organisationName },
    { label: 'Recipient', value: to },
  ];
  const sections = [
    {
      title: 'Before you start',
      tone: 'info',
      bulletItems: [
        'Keep your identity and contact details ready.',
        'Complete the form in one session where possible.',
        `This invitation link expires in ${expiresIn}.`,
      ],
    },
  ];
  const primaryAction = { label: 'Start onboarding', href: onboardUrl };
  const outroLines = ['If you were not expecting this invitation, please contact the sender before proceeding.'];
  const text = buildPlainTextEmail({
    title: 'Complete your onboarding',
    greeting: recipientName,
    introLines,
    detailRows,
    sections,
    primaryAction,
    outroLines,
  });
  const html = buildEmailHTML({
    badgeText: 'Onboarding invite',
    title: 'Complete your onboarding',
    greeting: recipientName,
    introLines,
    detailRows,
    sections,
    primaryAction,
    outroLines,
    preheader: `${inviterName} invited you to complete your onboarding in ${organisationName}.`,
  });
  await sendEmail(
    to,
    subject,
    text,
    html,
    'candidateInvitation',
    compactMetadata({ inviterName, organisationName, expiresIn })
  );
};

/**
 * Send candidate profile sharing email with public page URL (per SHARE_CANDIDATE_FORM.md)
 * @param {string} to - Recipient email
 * @param {Object} candidateData - { candidateName, candidateEmail }
 * @param {Object} shareData - { publicUrl, withDoc, sharedBy }
 * @returns {Promise}
 */
const sendCandidateProfileShareEmail = async (to, candidateData, shareData) => {
  const { publicUrl, withDoc, sharedBy, roleTitle } = shareData;
  const candidateName = candidateData.candidateName || 'Candidate';
  const subject = `Candidate profile shared: ${candidateName}`;
  const introLines = [
    `${sharedBy || 'A team member'} shared a candidate profile with you for review.`,
  ];
  const detailRows = [
    { label: 'Candidate', value: candidateName },
    { label: 'Email', value: candidateData.candidateEmail || 'Available inside the profile' },
    { label: 'Shared by', value: sharedBy || 'Dharwin team' },
    { label: 'Documents', value: withDoc ? 'Included' : 'Not included' },
    { label: 'Role', value: roleTitle || '' },
  ];
  const sections = withDoc
    ? [{ title: 'Included in this share', tone: 'success', bodyLines: ['Supporting candidate documents are available in the shared view.'] }]
    : [{ title: 'Included in this share', tone: 'warning', bodyLines: ['This shared view does not include supporting documents.'] }];
  const primaryAction = { label: 'View candidate profile', href: publicUrl };
  const text = buildPlainTextEmail({
    title: 'Candidate profile shared with you',
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Candidate share',
    title: 'Candidate profile shared with you',
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    preheader: `${sharedBy || 'A team member'} shared ${candidateName}'s profile with you.`,
  });

  await sendEmail(
    to,
    subject,
    text,
    html,
    'candidateProfileShare',
    compactMetadata({ candidateName, withDoc, sharedBy, roleTitle })
  );
};

/**
 * Send confirmation email when a candidate account is activated by admin.
 * Used for users who registered via candidate share form (status was 'pending').
 * @param {string} to - User email
 * @param {string} name - User name
 * @returns {Promise}
 */
const sendCandidateAccountActivationEmail = async (to, options = {}) => {
  const details =
    typeof options === 'string'
      ? { recipientName: options }
      : options;
  const signInUrl = `${getFrontendBaseUrl()}/authentication/sign-in/`;
  const subject = 'Your Dharwin account is now active';
  const displayName = details.recipientName || 'there';
  const introLines = [
    'Your account has been activated and is ready to use.',
    'Sign in to complete your profile and continue with the next steps in your workflow.',
  ];
  const detailRows = [
    { label: 'Account email', value: to },
    { label: 'Activated by', value: details.activatedBy || '' },
  ];
  const primaryAction = { label: 'Sign in to Dharwin', href: signInUrl };
  const text = buildPlainTextEmail({
    title: 'Your account is active',
    greeting: displayName,
    introLines,
    detailRows,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Account activated',
    title: 'Your account is ready',
    greeting: displayName,
    introLines,
    detailRows,
    primaryAction,
    preheader: 'Your Dharwin account has been activated and is ready to use.',
  });
  await sendEmail(
    to,
    subject,
    text,
    html,
    'candidateAccountActivation',
    compactMetadata({ recipientName: displayName, activatedBy: details.activatedBy || null })
  );
};

/**
 * Send meeting invitation email
 * @param {string} to - Recipient email
 * @param {Object} payload - { title, scheduledAt, durationMinutes, publicMeetingUrl }
 * @returns {Promise}
 */
const sendMeetingInvitationEmail = async (to, payload) => {
  const { shouldSendNotificationEmailToAddress } = await import('./notification.service.js');
  if (!(await shouldSendNotificationEmailToAddress(to, 'meeting'))) {
    logger.debug(`Skipping meeting invitation email to ${to} (notification preferences)`);
    return;
  }
  const {
    title,
    scheduledAt,
    durationMinutes,
    publicMeetingUrl,
    inviteeName,
    hostName,
    timezone,
    interviewType,
    jobPosition,
    description,
  } = payload;
  const subject = `Meeting invitation: ${title || 'Dharwin meeting'}`;
  const scheduled = formatDateTime(scheduledAt, timezone);
  const duration = durationMinutes ? `${durationMinutes} minutes` : '';
  const introLines = [
    'You have been invited to join a scheduled meeting on Dharwin.',
    hostName ? `${hostName} is listed as the host for this meeting.` : '',
  ];
  const detailRows = [
    { label: 'Meeting', value: title || 'Meeting' },
    { label: 'Scheduled time', value: scheduled },
    { label: 'Timezone', value: timezone || '' },
    { label: 'Duration', value: duration },
    { label: 'Host', value: hostName || '' },
    { label: 'Interview type', value: interviewType || '' },
    { label: 'Role / position', value: jobPosition || '' },
  ];
  const sections = [
    description
      ? { title: 'Agenda', tone: 'info', bodyLines: [truncateText(description, 400)] }
      : null,
    {
      title: 'Joining tips',
      tone: 'neutral',
      bulletItems: [
        'Use the personalised join link below for the best access experience.',
        'Join a few minutes early to test your audio and video setup.',
      ],
    },
  ].filter(Boolean);
  const primaryAction = { label: 'Join meeting', href: publicMeetingUrl };
  const text = buildPlainTextEmail({
    title: 'Meeting invitation',
    greeting: inviteeName || 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Meeting invitation',
    title: title || 'Meeting invitation',
    greeting: inviteeName || 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    preheader: `Meeting scheduled for ${scheduled}.`,
  });
  await sendEmail(
    to,
    subject,
    text,
    html,
    'meetingInvitation',
    compactMetadata({ title, scheduled, timezone, hostName, interviewType, jobPosition })
  );
};

/**
 * Send job share email
 * @param {string} to
 * @param {Object} job - { _id, title, organisation, location, jobDescription }
 * @param {string} [customMessage]
 */
const sendJobShareEmail = async (to, job, customMessage = '', options = {}) => {
  const sharerName = options.sharerName || 'A team member';
  const organisationName = job.organisation?.name || 'Company';
  const subject = `${sharerName} shared a job with you: ${job.title}`;
  const jobId = job._id || job.id;
  const jobUrl =
    options.publicJobUrl && String(options.publicJobUrl).trim()
      ? String(options.publicJobUrl).trim()
      : `${getFrontendBaseUrl()}/public-job/${jobId}`;
  const jobSummary = truncateText(job.jobDescription, 360);
  const introLines = [
    `${sharerName} shared this opportunity from ${organisationName}.`,
    'Review the role details and use the link below if you want to learn more or apply.',
  ];
  const detailRows = [
    { label: 'Role', value: job.title || 'Job opportunity' },
    { label: 'Organisation', value: organisationName },
    { label: 'Location', value: job.location || '' },
    { label: 'Employment type', value: job.jobType || '' },
  ];
  const sections = [
    customMessage && String(customMessage).trim()
      ? { title: `Message from ${sharerName}`, tone: 'info', bodyLines: [String(customMessage).trim()] }
      : null,
    jobSummary
      ? { title: 'Role summary', tone: 'neutral', bodyLines: [jobSummary] }
      : null,
  ].filter(Boolean);
  const primaryAction = { label: 'View job', href: jobUrl };
  const text = buildPlainTextEmail({
    title: 'Job opportunity shared with you',
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
  });
  const html = buildEmailHTML({
    badgeText: 'Job share',
    title: job.title || 'Job opportunity',
    greeting: 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    preheader: `${sharerName} shared ${job.title || 'a role'} from ${organisationName}.`,
  });
  await sendEmail(
    to,
    subject,
    text,
    html,
    'jobShare',
    compactMetadata({
      sharerName,
      jobTitle: job.title,
      organisationName,
      location: job.location,
      hasCustomMessage: Boolean(String(customMessage || '').trim()),
    })
  );
};

/**
 * Send welcome email after successful job application
 * @param {string} to - Applicant email
 * @param {Object} data - { fullName, email, password, jobTitle, companyName, loginUrl }
 */
const sendJobApplicationWelcomeEmail = async (to, data) => {
  const { fullName, email, jobTitle, companyName, loginUrl, resetPasswordUrl } = data;
  const subject = `Application received: ${jobTitle}`;
  const introLines = [
    `Thank you for applying for ${jobTitle} at ${companyName}.`,
    'Your application has been submitted successfully and your Dharwin account is ready.',
  ];
  const detailRows = [
    { label: 'Role', value: jobTitle },
    { label: 'Company', value: companyName },
    { label: 'Account email', value: email },
  ];
  const sections = [
    {
      title: 'Next steps',
      tone: 'success',
      bulletItems: [
        resetPasswordUrl
          ? 'Create your password using the secure link below.'
          : 'Sign in using your account email.',
        'Complete your profile to help the hiring team review your application.',
        'Track application updates from your dashboard.',
      ],
    },
    {
      title: 'Security note',
      tone: 'warning',
      bodyLines: [
        resetPasswordUrl
          ? 'For security, we never include passwords in email. Use the secure link below to set yours.'
          : 'For security, we never include passwords in email. Use the Forgot Password option if you need to create or reset one.',
      ],
    },
  ];
  const primaryAction = resetPasswordUrl
    ? { label: 'Create your password', href: resetPasswordUrl }
    : { label: 'Sign in to Dharwin', href: loginUrl };
  const secondaryActions = !resetPasswordUrl && loginUrl
    ? [{ label: 'Open sign in page', href: loginUrl, variant: 'secondary' }]
    : [];
  const outroLines = [
    'Keep this email for reference until you finish setting up your account.',
  ];
  const text = buildPlainTextEmail({
    title: 'Your application has been submitted',
    greeting: fullName || 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    outroLines,
  });
  const html = buildEmailHTML({
    badgeText: 'Application received',
    title: 'Your application has been submitted',
    greeting: fullName || 'there',
    introLines,
    detailRows,
    sections,
    primaryAction,
    secondaryActions,
    outroLines,
    preheader: `Your application for ${jobTitle} at ${companyName} has been submitted.`,
  });

  await sendEmail(
    to,
    subject,
    text,
    html,
    'jobApplicationWelcome',
    compactMetadata({ fullName, email, jobTitle, companyName, hasResetPasswordUrl: Boolean(resetPasswordUrl) })
  );
};

const sendPostCallThankYouEmail = async (to, data) => {
  const {
    candidateName,
    jobTitle,
    companyName,
    jobType,
    jobLocation,
    loginUrl,
    callDuration,
    otherJobsCount,
    portalUrl,
  } = data;

  const subject = `Thank you for your time, ${candidateName}`;

  const durationText = callDuration
    ? `${Math.ceil(callDuration / 60)} minute${Math.ceil(callDuration / 60) > 1 ? 's' : ''}`
    : 'a few minutes';

  const introLines = [
    `Thank you for taking ${durationText} to speak with us about ${jobTitle} at ${companyName}.`,
    'Your responses have been recorded and the recruitment team will review them shortly.',
  ];
  const detailRows = [
    { label: 'Role', value: jobTitle },
    { label: 'Company', value: companyName },
    { label: 'Job type', value: jobType || '' },
    { label: 'Location', value: jobLocation || '' },
  ];
  const sections = [
    {
      title: 'What happens next',
      tone: 'success',
      bulletItems: [
        'The recruitment team will review your application and interview responses.',
        'If shortlisted, you will be contacted about the next stage.',
        'You can track your application status from your Dharwin dashboard.',
      ],
    },
    otherJobsCount > 0
      ? {
          title: 'More open opportunities',
          tone: 'info',
          bodyLines: [
            `There ${otherJobsCount === 1 ? 'is' : 'are'} currently ${otherJobsCount} other open position${otherJobsCount > 1 ? 's' : ''} you may want to explore.`,
          ],
        }
      : null,
    {
      title: 'Helpful reminder',
      tone: 'warning',
      bulletItems: [
        'Keep your profile and resume up to date.',
        'Check your email regularly for follow-up steps.',
      ],
    },
  ].filter(Boolean);
  const primaryAction = { label: 'Track my application', href: loginUrl };
  const secondaryActions = portalUrl ? [{ label: 'Browse more jobs', href: portalUrl, variant: 'secondary' }] : [];
  const outroLines = ['If you have questions about the role or the hiring process, please reply to this email.'];
  const text = buildPlainTextEmail({
    title: 'Thank you for your time',
    greeting: candidateName,
    introLines,
    detailRows,
    sections,
    primaryAction,
    outroLines,
  });
  const html = buildEmailHTML({
    badgeText: 'Thank you',
    title: 'Thank you for your time',
    greeting: candidateName,
    introLines,
    detailRows,
    sections,
    primaryAction,
    secondaryActions,
    outroLines,
    preheader: `Thank you for speaking with us about ${jobTitle}.`,
  });

  await sendEmail(
    to,
    subject,
    text,
    html,
    'postCallThankYou',
    compactMetadata({ candidateName, jobTitle, companyName, jobType, jobLocation, otherJobsCount })
  );
};

export {
  transport,
  sendEmail,
  queueEmail,
  /** Shared branded wrapper — same layout as reset password / verification emails */
  buildEmailHTML,
  buildPlainTextEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
  sendCandidateInvitationEmail,
  sendCandidateProfileShareEmail,
  sendCandidateAccountActivationEmail,
  sendMeetingInvitationEmail,
  sendJobShareEmail,
  sendJobApplicationWelcomeEmail,
  sendPostCallThankYouEmail,
};

