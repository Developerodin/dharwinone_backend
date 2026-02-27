import nodemailer from 'nodemailer';
import config from '../config/config.js';
import logger from '../config/logger.js';
import EmailLog from '../models/emailLog.model.js';


const transport = nodemailer.createTransport(config.email.smtp);
/* istanbul ignore next */
if (config.env !== 'test') {
  transport
    .verify()
    .then(() => logger.info('Connected to email server'))
    .catch(() => logger.warn('Unable to connect to email server. Make sure you have configured the SMTP options in .env'));
}

/**
 * Build branded email HTML wrapper (header + body + footer).
 * @param {string} badgeText - Text shown in top-right of header (e.g. "Secure Password Reset")
 * @param {string} bodyHTML - Inner table rows (content between header and footer)
 * @returns {string} Full HTML email
 */
const buildEmailHTML = (badgeText, bodyHTML) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:20px 24px;color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:20px;font-weight:600;">Dharwin Business Solutions</td>
                  <td align="right" style="font-size:13px;opacity:0.9;">${badgeText}</td>
                </tr>
              </table>
            </td>
          </tr>
          ${bodyHTML}
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#9ca3af;font-size:11px;">
              <p style="margin:0 0 4px 0;">This email was sent by Dharwin Business Solutions. Please do not reply to this automated message.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
`;

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
 * @returns {Promise}
 */
const sendResetPasswordEmail = async (to, token) => {
  const subject = 'Reset Your Password - Dharwin Business Solutions';
  const frontendBase = (config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '');
  const resetPasswordUrl = `${frontendBase}/reset-password?token=${token}`;
  const text = `Dear user,

To reset your password, click on this link: ${resetPasswordUrl}

If you did not request any password resets, then ignore this email.`;

  const bodyHTML = `
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">Password Reset Request</h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">Hello,</p>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">We received a request to reset the password for your Dharwin account. If you made this request, please click the button below to choose a new password.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${resetPasswordUrl}" style="display:inline-block;padding:12px 24px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">Reset My Password</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">If the button above does not work, copy and paste this link into your browser:</p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;"><a href="${resetPasswordUrl}" style="color:#2563eb;text-decoration:none;">${resetPasswordUrl}</a></p>
              <p style="margin:0 0 4px 0;">For your security, this link will expire after a short time. If you did not request a password reset, you can safely ignore this email and your password will remain unchanged.</p>
            </td>
          </tr>`;
  const html = buildEmailHTML('Secure Password Reset', bodyHTML);
  await sendEmail(to, subject, text, html);
};

/**
 * Send verification email
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendVerificationEmail = async (to, token) => {
  const subject = 'Email Verification';
  const frontendBase = (config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '');
  const verificationEmailUrl = `${frontendBase}/verify-email?token=${token}`;
  const text = `Dear user,

To verify your email, click on this link: ${verificationEmailUrl}

If you did not create an account, then ignore this email.`;

  const bodyHTML = `
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">Confirm your email address</h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">Hello,</p>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">Thank you for creating a Dharwin account. Please confirm your email address by clicking the button below.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${verificationEmailUrl}" style="display:inline-block;padding:12px 24px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">Verify Email</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">If the button above does not work, copy and paste this link into your browser:</p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;"><a href="${verificationEmailUrl}" style="color:#2563eb;text-decoration:none;">${verificationEmailUrl}</a></p>
              <p style="margin:0 0 4px 0;">If you did not create an account, you can safely ignore this email.</p>
            </td>
          </tr>`;
  const html = buildEmailHTML('Email Verification', bodyHTML);
  await sendEmail(to, subject, text, html);
};

/**
 * Send candidate onboarding/preboarding invitation email with link
 * @param {string} to - Recipient email
 * @param {string} onboardUrl - Full URL for candidate to complete onboarding
 * @returns {Promise}
 */
const sendCandidateInvitationEmail = async (to, onboardUrl) => {
  const subject = "You're Invited to Complete Your Onboarding - Dharwin";
  const text = `Dear Candidate,

You have been invited to complete your onboarding. Please use the link below to get started:

${onboardUrl}

This link will expire in 24 hours. If you have any questions, please contact your administrator.

Best regards,
Dharwin Business Solutions`;

  const bodyHTML = `
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">Complete Your Onboarding</h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">You have been invited to complete your candidate onboarding. Click the button below to get started.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${onboardUrl}" style="display:inline-block;padding:12px 24px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">Start Onboarding</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">If the button does not work, copy and paste this link into your browser:</p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;"><a href="${onboardUrl}" style="color:#2563eb;text-decoration:none;">${onboardUrl}</a></p>
              <p style="margin:0 0 4px 0;">This link expires in 24 hours.</p>
            </td>
          </tr>`;
  const html = buildEmailHTML('Pre-boarding Invitation', bodyHTML);
  await sendEmail(to, subject, text, html);
};

/**
 * Send candidate profile sharing email with public page URL (per SHARE_CANDIDATE_FORM.md)
 * @param {string} to - Recipient email
 * @param {Object} candidateData - { candidateName, candidateEmail }
 * @param {Object} shareData - { publicUrl, withDoc, sharedBy }
 * @returns {Promise}
 */
const sendCandidateProfileShareEmail = async (to, candidateData, shareData) => {
  const { publicUrl, withDoc, sharedBy } = shareData;
  const subject = `Candidate Profile: ${candidateData.candidateName}`;

  const text = `Dear Recipient,

A candidate profile has been shared with you:

Name: ${candidateData.candidateName}
${withDoc ? 'Documents: Included' : 'Documents: Not included'}

View the complete profile: ${publicUrl}

This profile was shared by: ${sharedBy}

Best regards,
Dharwin Team`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Candidate Profile Shared - Dharwin</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a202c; background-color: #f8fafc; margin: 0; padding: 20px; }
            .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); overflow: hidden; }
            .header { background: linear-gradient(135deg, #093464 0%, #0d4a7a 100%); padding: 40px 30px; text-align: center; }
            .tagline { color: rgba(255, 255, 255, 0.9); font-size: 16px; }
            .content { padding: 40px; }
            .profile-preview { background-color: #f8fafc; border-radius: 12px; padding: 30px; margin: 40px 0; border: 1px solid #e2e8f0; text-align: center; }
            .profile-name { color: #093464; font-size: 24px; font-weight: 700; margin-bottom: 8px; }
            .profile-email { color: #4a5568; font-size: 16px; margin-bottom: 20px; }
            .documents-info { background-color: ${withDoc ? '#d1fae5' : '#fef3c7'}; border: 1px solid ${withDoc ? '#a7f3d0' : '#fde68a'}; border-radius: 8px; padding: 16px; margin: 20px 0; text-align: center; color: ${withDoc ? '#065f46' : '#92400e'}; font-weight: 500; }
            .cta-section { text-align: center; margin: 40px 0; }
            .button { display: inline-block; padding: 18px 40px; background: linear-gradient(135deg, #36af4c 0%, #2d8f3f 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; }
            .footer { background-color: #f8fafc; padding: 30px 40px; border-top: 1px solid #e2e8f0; text-align: center; }
            .footer p { color: #64748b; font-size: 14px; margin-bottom: 8px; }
        </style>
    </head>
    <body>
        <div class="email-container">
            <div class="header">
                <div class="tagline">A candidate profile has been shared with you</div>
            </div>
            <div class="content">
                <div class="profile-preview">
                    <div class="profile-name">${candidateData.candidateName}</div>
                    <div class="profile-email">${candidateData.candidateEmail || 'Contact information available in profile'}</div>
                    <div class="documents-info">${withDoc ? 'Documents are included in this profile' : 'Documents are not included in this profile'}</div>
                </div>
                <div class="cta-section">
                    <a href="${publicUrl}" class="button">View Complete Profile</a>
                </div>
                <p style="color: #4a5568; font-size: 16px; margin: 30px 0; text-align: center;">This profile was shared by: ${sharedBy}. Click the button above to view the complete candidate profile.</p>
            </div>
            <div class="footer">
                <p>This profile was shared through Dharwin Business Solutions</p>
            </div>
        </div>
    </body>
    </html>
  `;

  await sendEmail(to, subject, text, html);
};

/**
 * Send confirmation email when a candidate account is activated by admin.
 * Used for users who registered via candidate share form (status was 'pending').
 * @param {string} to - User email
 * @param {string} name - User name
 * @returns {Promise}
 */
const sendCandidateAccountActivationEmail = async (to, name) => {
  const signInUrl = `${(config.frontendBaseUrl || 'http://localhost:3001').replace(/\/$/, '')}/authentication/sign-in/`;
  const subject = 'Your Account Has Been Activated - Dharwin Business Solutions';
  const displayName = name || 'there';
  const text = `Dear ${displayName},

Your Dharwin account has been activated by an administrator. You can now sign in and access your profile.

Sign in here: ${signInUrl}

If you have any questions, please contact support.`;

  const bodyHTML = `
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">Your Account Is Ready</h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">Hello ${displayName},</p>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">Your account has been activated by an administrator. You can now sign in and access your profile.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${signInUrl}" style="display:inline-block;padding:12px 24px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">Sign In Now</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">If the button above does not work, copy and paste this link into your browser:</p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;"><a href="${signInUrl}" style="color:#2563eb;text-decoration:none;">${signInUrl}</a></p>
            </td>
          </tr>`;
  const html = buildEmailHTML('Account Activated', bodyHTML);
  await sendEmail(to, subject, text, html);
};

/**
 * Send meeting invitation email
 * @param {string} to - Recipient email
 * @param {Object} payload - { title, scheduledAt, durationMinutes, publicMeetingUrl }
 * @returns {Promise}
 */
const sendMeetingInvitationEmail = async (to, payload) => {
  const { title, scheduledAt, durationMinutes, publicMeetingUrl } = payload;
  const subject = `Meeting Invitation: ${title || 'Dharwin Meeting'}`;
  const scheduled = scheduledAt ? new Date(scheduledAt).toLocaleString() : 'TBD';
  const duration = durationMinutes ? `${durationMinutes} minutes` : '';
  const text = `Dear participant,

You are invited to a meeting:

Title: ${title || 'Meeting'}
Scheduled: ${scheduled}
${duration ? `Duration: ${duration}` : ''}

Join here: ${publicMeetingUrl}

Best regards,
Dharwin Business Solutions`;

  const bodyHTML = `
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">${title || 'Meeting Invitation'}</h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">You are invited to join a meeting.</p>
              <p style="margin:0 0 8px 0;font-size:14px;color:#4b5563;"><strong>Scheduled:</strong> ${scheduled}</p>
              ${duration ? `<p style="margin:0 0 16px 0;font-size:14px;color:#4b5563;"><strong>Duration:</strong> ${duration}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${publicMeetingUrl}" style="display:inline-block;padding:12px 24px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">Join Meeting</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">If the button does not work, copy and paste this link into your browser:</p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;"><a href="${publicMeetingUrl}" style="color:#2563eb;text-decoration:none;">${publicMeetingUrl}</a></p>
            </td>
          </tr>`;
  const html = buildEmailHTML('Meeting Invitation', bodyHTML);
  await sendEmail(to, subject, text, html);
};

/**
 * Send job share email
 * @param {string} to
 * @param {Object} job - { _id, title, organisation, location, jobDescription }
 * @param {string} [customMessage]
 */
const sendJobShareEmail = async (to, job, customMessage = '') => {
  const subject = `Job Opportunity: ${job.title} at ${job.organisation?.name || 'Company'}`;
  const jobId = job._id || job.id;
  const jobUrl = `${config.frontendBaseUrl || 'http://localhost:3001'}/public-job/${jobId}`;
  const text = `You have been shared a job opportunity:\n\n${job.title}\n${job.organisation?.name || ''}\n${job.location || ''}\n\n${job.jobDescription || ''}\n\nView and apply: ${jobUrl}`;
  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;">
        <tr><td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:20px;color:#fff;font-size:18px;font-weight:600;">Job Opportunity</td></tr>
        <tr><td style="padding:24px;">
          <h2 style="margin:0 0 12px 0;">${job.title}</h2>
          <p style="margin:0 0 8px 0;color:#6b7280;">${job.organisation?.name || ''} &bull; ${job.location || ''}</p>
          ${customMessage ? `<p style="margin:0 0 16px 0;">${customMessage}</p>` : ''}
          <div style="margin:16px 0;padding:12px;background:#f9fafb;border-radius:6px;">${(job.jobDescription || '').substring(0, 500)}${(job.jobDescription || '').length > 500 ? '...' : ''}</div>
          <a href="${jobUrl}" style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View & Apply</a>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
  await sendEmail(to, subject, text, html);
};

/**
 * Send welcome email after successful job application
 * @param {string} to - Applicant email
 * @param {Object} data - { fullName, email, password, jobTitle, companyName, loginUrl }
 */
const sendJobApplicationWelcomeEmail = async (to, data) => {
  const { fullName, email, password, jobTitle, companyName, loginUrl } = data;
  
  const subject = `Welcome! Your application for ${jobTitle} has been submitted`;
  
  const text = `
Hello ${fullName},

Thank you for applying to ${jobTitle} at ${companyName}!

Your application has been successfully submitted and your account has been created.

Login Credentials:
Email: ${email}
Password: ${password}

You can now login to complete your profile and track your application status.

Login here: ${loginUrl}

Important: Please keep your login credentials safe. We recommend changing your password after your first login.

Best regards,
The Recruitment Team
  `.trim();

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:32px 24px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:24px;font-weight:600;">🎉 Application Submitted!</h1>
          </td>
        </tr>
        
        <!-- Content -->
        <tr>
          <td style="padding:32px 24px;">
            <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#1f2937;">
              Hello <strong>${fullName}</strong>,
            </p>
            
            <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;color:#1f2937;">
              Thank you for applying to <strong style="color:#0ea5e9;">${jobTitle}</strong> at <strong>${companyName}</strong>! 
              Your application has been successfully submitted and your account has been created.
            </p>
            
            <!-- Login Credentials Box -->
            <div style="background:#f9fafb;border:2px solid #e5e7eb;border-radius:8px;padding:20px;margin:0 0 24px 0;">
              <h2 style="margin:0 0 16px 0;font-size:18px;color:#1f2937;">Your Login Credentials</h2>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:8px 0;">
                    <strong style="color:#6b7280;font-size:14px;">Email:</strong><br>
                    <span style="color:#1f2937;font-size:16px;font-family:monospace;">${email}</span>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;">
                    <strong style="color:#6b7280;font-size:14px;">Password:</strong><br>
                    <span style="color:#1f2937;font-size:16px;font-family:monospace;background:#fff;padding:4px 8px;border-radius:4px;display:inline-block;">${password}</span>
                  </td>
                </tr>
              </table>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align:center;margin:0 0 24px 0;">
              <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">Login to Your Account</a>
            </div>
            
            <!-- Next Steps -->
            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;margin:0 0 24px 0;border-radius:4px;">
              <p style="margin:0;font-size:14px;color:#92400e;line-height:1.6;">
                <strong>📋 Next Steps:</strong><br>
                1. Login to your account<br>
                2. Complete your profile<br>
                3. Track your application status<br>
                4. Explore other opportunities
              </p>
            </div>
            
            <!-- Security Note -->
            <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
              <strong>🔒 Security Note:</strong> Please keep your login credentials safe. 
              We recommend changing your password after your first login from your profile settings.
            </p>
          </td>
        </tr>
        
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 24px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:14px;color:#6b7280;">
              Best regards,<br>
              <strong>The Recruitment Team</strong>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;
  
  await sendEmail(to, subject, text, html);
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

  const subject = `Thank you for your time, ${candidateName}! - Dharwin`;

  const durationText = callDuration
    ? `${Math.ceil(callDuration / 60)} minute${Math.ceil(callDuration / 60) > 1 ? 's' : ''}`
    : 'a few minutes';

  const text = `
Hi ${candidateName},

Thank you for taking the time to speak with us regarding your application for ${jobTitle} at ${companyName}!

We appreciate your interest in joining our team. Your responses have been recorded and our recruitment team will review them shortly.

What Happens Next:
- Our team will review your call and application details
- If shortlisted, you will be contacted for the next round
- You can track your application status anytime by logging into your Dharwin account

${otherJobsCount > 0 ? `We also have ${otherJobsCount} other open position${otherJobsCount > 1 ? 's' : ''} that might interest you. Login to explore more opportunities!` : ''}

Login to your account: ${loginUrl}

If you have any questions, feel free to reply to this email.

Best regards,
The Dharwin Recruitment Team
  `.trim();

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,sans-serif;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(90deg,#7c3aed,#6d28d9);padding:32px 24px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:600;">Thank You, ${candidateName}!</h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">We appreciate your time and interest</p>
          </td>
        </tr>
        
        <!-- Content -->
        <tr>
          <td style="padding:32px 24px;">
            <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#1f2937;">
              Hi <strong>${candidateName}</strong>,
            </p>
            
            <p style="margin:0 0 24px 0;font-size:16px;line-height:1.6;color:#1f2937;">
              Thank you for taking <strong>${durationText}</strong> to speak with us about your application for 
              <strong style="color:#7c3aed;">${jobTitle}</strong> at <strong>${companyName}</strong>! 
              Your responses have been recorded and our recruitment team will review them shortly.
            </p>
            
            <!-- Job Summary Box -->
            <div style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:20px;margin:0 0 24px 0;">
              <h3 style="margin:0 0 12px 0;font-size:16px;color:#5b21b6;">Position Applied For</h3>
              <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;">
                <tr>
                  <td style="padding:4px 0;"><strong>Role:</strong></td>
                  <td style="padding:4px 0;">${jobTitle}</td>
                </tr>
                <tr>
                  <td style="padding:4px 0;"><strong>Company:</strong></td>
                  <td style="padding:4px 0;">${companyName}</td>
                </tr>
                ${jobType ? `<tr><td style="padding:4px 0;"><strong>Type:</strong></td><td style="padding:4px 0;">${jobType}</td></tr>` : ''}
                ${jobLocation ? `<tr><td style="padding:4px 0;"><strong>Location:</strong></td><td style="padding:4px 0;">${jobLocation}</td></tr>` : ''}
              </table>
            </div>

            <!-- What's Next -->
            <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:16px;margin:0 0 24px 0;border-radius:4px;">
              <h3 style="margin:0 0 10px 0;font-size:15px;color:#166534;">What Happens Next?</h3>
              <ol style="margin:0;padding:0 0 0 20px;font-size:14px;color:#374151;line-height:1.8;">
                <li>Our recruitment team will review your call recording and responses</li>
                <li>If shortlisted, you'll be contacted for the next interview round</li>
                <li>You can track your application status in real-time from your dashboard</li>
                <li>Complete your profile to improve your chances of selection</li>
              </ol>
            </div>

            ${otherJobsCount > 0 ? `
            <!-- Other Opportunities -->
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:0 0 24px 0;">
              <p style="margin:0;font-size:14px;color:#1e40af;line-height:1.6;">
                <strong>Explore More Opportunities!</strong><br>
                We have <strong>${otherJobsCount} other open position${otherJobsCount > 1 ? 's' : ''}</strong> that might interest you. 
                Login to your account to browse and apply!
              </p>
            </div>` : ''}

            <!-- CTA Buttons -->
            <div style="text-align:center;margin:0 0 24px 0;">
              <a href="${loginUrl}" style="display:inline-block;padding:14px 32px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;margin:0 8px 8px 0;">Track My Application</a>
              ${portalUrl ? `<a href="${portalUrl}" style="display:inline-block;padding:14px 32px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;margin:0 0 8px 0;">Browse More Jobs</a>` : ''}
            </div>

            <!-- Tips -->
            <div style="background:#fefce8;border-left:4px solid #eab308;padding:16px;margin:0 0 24px 0;border-radius:4px;">
              <p style="margin:0;font-size:14px;color:#854d0e;line-height:1.6;">
                <strong>Tips to Improve Your Chances:</strong><br>
                - Complete your profile with education, experience, and skills<br>
                - Upload your latest resume and relevant documents<br>
                - Keep your phone available for follow-up calls<br>
                - Check your email regularly for updates
              </p>
            </div>
            
            <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
              If you have any questions about your application or the hiring process, feel free to reply to this email. 
              We're here to help!
            </p>
          </td>
        </tr>
        
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 24px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0 0 8px 0;font-size:14px;color:#6b7280;">
              Best regards,<br>
              <strong style="color:#7c3aed;">The Dharwin Recruitment Team</strong>
            </p>
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              Dharwin - Smart Recruitment Platform
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>`;

  await sendEmail(to, subject, text, html);
};

export {
  transport,
  sendEmail,
  queueEmail,
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

