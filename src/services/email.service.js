import nodemailer from 'nodemailer';
import config from '../config/config.js';
import logger from '../config/logger.js';


const transport = nodemailer.createTransport(config.email.smtp);
/* istanbul ignore next */
if (config.env !== 'test') {
  transport
    .verify()
    .then(() => logger.info('Connected to email server'))
    .catch(() => logger.warn('Unable to connect to email server. Make sure you have configured the SMTP options in .env'));
}

/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [html]
 * @returns {Promise}
 */
const sendEmail = async (to, subject, text, html) => {
  // Show branded name before email address in email clients
  const fromAddress = config.email.from;
  const from =
    fromAddress && fromAddress.includes('<')
      ? fromAddress
      : `Dharwin Business Solutions <${fromAddress}>`;
  // Default reply-to to the admin support address, overrideable via EMAIL_REPLY_TO
  const replyTo = config.email.replyTo || 'admin@dharwinbusinesssolutions.com' || fromAddress;

  const msg = {
    from,
    replyTo,
    to,
    subject,
    text,
    ...(html && { html }),
  };
  await transport.sendMail(msg);
};

/**
 * Send reset password email
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendResetPasswordEmail = async (to, token) => {
  const subject = 'Reset Your Password - Dharwin Business Solutions';
  // TODO: replace localhost URL with production frontend URL when deployed
  const resetPasswordUrl = `http://localhost:3001/reset-password?token=${token}`;
  const text = `Dear user,

To reset your password, click on this link: ${resetPasswordUrl}

If you did not request any password resets, then ignore this email.`;

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:20px 24px;color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:20px;font-weight:600;">
                    Dharwin Business Solutions
                  </td>
                  <td align="right" style="font-size:13px;opacity:0.9;">
                    Secure Password Reset
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">
                Password Reset Request
              </h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                Hello,
              </p>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                We received a request to reset the password for your Dharwin account.
                If you made this request, please click the button below to choose a new password.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${resetPasswordUrl}"
                 style="display:inline-block;padding:12px 24px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">
                Reset My Password
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">
                If the button above does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;">
                <a href="${resetPasswordUrl}" style="color:#2563eb;text-decoration:none;">${resetPasswordUrl}</a>
              </p>
              <p style="margin:0 0 4px 0;">
                For your security, this link will expire after a short time. If you did not request a password reset, you can safely ignore this email and your password will remain unchanged.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#9ca3af;font-size:11px;">
              <p style="margin:0 0 4px 0;">
                This email was sent by Dharwin Business Solutions. Please do not reply to this automated message.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

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
  // TODO: replace localhost URL with production frontend URL when deployed
  const verificationEmailUrl = `http://localhost:3001/verify-email?token=${token}`;
  const text = `Dear user,

To verify your email, click on this link: ${verificationEmailUrl}

If you did not create an account, then ignore this email.`;

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:20px 24px;color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:20px;font-weight:600;">
                    Dharwin Business Solutions
                  </td>
                  <td align="right" style="font-size:13px;opacity:0.9;">
                    Email Verification
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 12px 32px;color:#111827;">
              <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#111827;">
                Confirm your email address
              </h1>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                Hello,
              </p>
              <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                Thank you for creating a Dharwin account. Please confirm your email address by clicking the button below.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 32px 24px 32px;">
              <a href="${verificationEmailUrl}"
                 style="display:inline-block;padding:12px 24px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">
                Verify Email
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;color:#6b7280;font-size:12px;line-height:1.6;">
              <p style="margin:0 0 8px 0;">
                If the button above does not work, copy and paste this link into your browser:
              </p>
              <p style="margin:0 0 12px 0;word-break:break-all;color:#2563eb;">
                <a href="${verificationEmailUrl}" style="color:#2563eb;text-decoration:none;">${verificationEmailUrl}</a>
              </p>
              <p style="margin:0 0 4px 0;">
                If you did not create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#9ca3af;font-size:11px;">
              <p style="margin:0 0 4px 0;">
                This email was sent by Dharwin Business Solutions. Please do not reply to this automated message.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

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

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5fb;padding:24px 0;font-family:Arial,Helvetica,sans-serif;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(90deg,#0f766e,#0ea5e9);padding:20px 24px;color:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="left" style="font-size:20px;font-weight:600;">Dharwin Business Solutions</td>
                  <td align="right" style="font-size:13px;opacity:0.9;">Pre-boarding Invitation</td>
                </tr>
              </table>
            </td>
          </tr>
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
          </tr>
          <tr>
            <td style="background-color:#f9fafb;border-top:1px solid #e5e7eb;padding:16px 32px;color:#9ca3af;font-size:11px;">
              <p style="margin:0 0 4px 0;">This email was sent by Dharwin Business Solutions.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

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

export {
  transport,
  sendEmail,
  sendResetPasswordEmail,
  sendVerificationEmail,
  sendCandidateInvitationEmail,
  sendCandidateProfileShareEmail,
};

