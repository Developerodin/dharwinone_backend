import bolnaService from './bolna.service.js';
import logger from '../config/logger.js';
import { normalizePhone, validatePhone } from '../utils/phone.js';
import { ensureAgentPrompt } from '../utils/bolnaAgentTemplateSync.js';
import {
  buildJobPostingAgentPromptTemplate,
  buildJobPostingAgentTemplateVars,
  JOB_WELCOME_TEMPLATE,
} from './jobPostingAgentTemplate.service.js';

/**
 * Sync the STATIC job-posting prompt template onto the agent (once per process), then dial
 * the organisation phone stored on the Job document with this job's values in `user_data`.
 *
 * Nothing job-specific is written to the agent. The agent's prompt is shared state across
 * every process on the Bolna account — production and staging included — so a per-call
 * prompt meant whichever process PATCHed last owned the call. See
 * jobPostingAgentTemplate.service.js for the incident this replaced.
 *
 * @param {Object} p
 * @param {string} p.agentId          - BOLNA_AGENT_ID (job-posting agent)
 * @param {Object} p.job              - Mongoose job doc or lean object
 * @param {string} [p.contactLabel]   - Display label for call record (org name / contact)
 * @param {string} [p.fromPhoneNumber] - Override outbound caller ID
 */
export async function initiateJobPostingVerificationCall({ agentId, job, contactLabel, fromPhoneNumber }) {
  // ── Phone validation ──────────────────────────────────────────────────────
  const orgPhoneRaw = job.organisation?.phone;
  if (!orgPhoneRaw || !String(orgPhoneRaw).trim()) {
    return {
      success: false,
      error: 'Job organisation phone is missing. Add it to the job in ATS before calling.',
    };
  }

  const phone = normalizePhone(String(orgPhoneRaw).trim());
  if (!phone || !validatePhone(phone)) {
    return {
      success: false,
      error: 'Organisation phone on the job is not a valid E.164 number for outbound calling.',
    };
  }

  // ── Static template + per-call values ────────────────────────────────────
  const { vars } = buildJobPostingAgentTemplateVars(job);
  const label =
    (contactLabel && String(contactLabel).trim()) ||
    (vars.listing_organisation_name !== 'the hiring organisation' ? vars.listing_organisation_name : '') ||
    'Organisation contact';

  const prepared = await ensureAgentPrompt(
    bolnaService,
    agentId,
    buildJobPostingAgentPromptTemplate(),
    JOB_WELCOME_TEMPLATE
  );
  if (!prepared.ok) {
    // Do NOT dial on an unverified prompt: the agent may still hold a previous fully
    // resolved prompt naming a different job, possibly from another environment.
    return {
      success: false,
      error: `Bolna agent could not be prepared before the call: ${prepared.error}`,
    };
  }

  // Everything the agent says comes from here, and it travels atomically with the call.
  // `contact_label` / `candidate_name` are what Bolna shows as the recipient display name.
  const userData = {
    ...vars,
    contact_label: label,
    assistant_identity:
      'You are the Dharwin platform automated listing-verification assistant. You do not work for the employer below.',
  };

  logger.info(
    `[Bolna] job-posting call jobId=${job._id} agent=${agentId} templateCached=${prepared.cached === true} userDataBytes=${Buffer.byteLength(JSON.stringify(userData))}`
  );

  return bolnaService.initiateCall({
    phone,
    candidateName: label,
    agentId,
    fromPhoneNumber,
    userData,
  });
}
