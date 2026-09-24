import JobApplication from '../models/jobApplication.model.js';
import CallRecord from '../models/callRecord.model.js';
import logger from '../config/logger.js';
import { getFreeSlots, encodeSlotId, decodeSlotId, verifyApplicationRef } from '../services/interviewSlot.service.js';
import { createHold } from '../services/interviewHold.service.js';
import { formatSpoken, guessCandidateTimezone } from '../services/interviewBooking.service.js';
import { isValidTimeZone } from '../utils/zonedTime.js';

/**
 * Bolna mid-call custom functions. Contract: ALWAYS HTTP 200 with a spoken `message`, so the
 * agent never goes silent on an error. Every handler runs under a 3s budget.
 * Known edge: a hold that finishes AFTER the budget still persists while the agent already said
 * "I'll email you a link" — harmless, the recruiter still has to approve it.
 */
const BUDGET_MS = 3000;
const RECENT_CALL_MS = 2 * 60 * 60 * 1000;
const FALLBACK = "I'll email you a link to choose a time.";

const param = (req, key) => {
  const v = req.body?.[key] ?? req.query?.[key];
  return v == null ? '' : String(v).trim();
};

/** Agent-supplied tz, or the phone-prefix guess when missing/unknown (an invalid zone throws in Intl). */
const candidateTz = (req, phone) => {
  const tz = param(req, 'tz');
  return tz && isValidTimeZone(tz) ? tz : guessCandidateTimezone(phone);
};

const withBudget = (promise) =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, message: FALLBACK, timedOut: true }), BUDGET_MS);
    }),
  ]);

/** Load application + the CallRecord that proves a live AI call for it (created within 2h). */
async function loadContext(applicationId) {
  if (!applicationId) return null;
  const application = await JobApplication.findById(applicationId).select('candidate job status verificationCallStatus').lean();
  if (!application) return null;
  const callRecord = await CallRecord.findOne({
    candidate: application.candidate,
    job: application.job,
    createdAt: { $gte: new Date(Date.now() - RECENT_CALL_MS) },
  })
    .sort({ createdAt: -1 })
    .select('_id phone')
    .lean();
  if (!callRecord) return null;
  return { application, callRecord };
}

const joinSpoken = (parts) =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;

async function buildSlotOffer(applicationId, tz) {
  const slots = await getFreeSlots({ applicationId, limit: 3, tz });
  if (!slots.length) return { ok: false, slots: [], message: FALLBACK };
  const out = slots.map((s) => ({
    slot_id: encodeSlotId({ applicationId, start: s.start }),
    spoken: formatSpoken(new Date(s.start), tz),
  }));
  const message = `I have ${out.length === 1 ? 'one option' : `${out.length} options`}: ${joinSpoken(
    out.map((s, i) => `option ${i + 1}, ${s.spoken}`)
  )}. Which works best for you?`;
  return { ok: true, slots: out, message };
}

async function interviewSlotsImpl(req) {
  // application_id is the signed `<id>.<sig>` ref from this call's prompt, never a raw id.
  const applicationId = verifyApplicationRef(param(req, 'application_id'));
  const ctx = await loadContext(applicationId);
  if (!ctx) return { ok: false, slots: [], message: FALLBACK };
  const tz = candidateTz(req, ctx.callRecord.phone);
  return buildSlotOffer(applicationId, tz);
}

async function holdSlotImpl(req) {
  const applicationId = verifyApplicationRef(param(req, 'application_id'));
  const slotId = param(req, 'slot_id');
  const ctx = await loadContext(applicationId);
  if (!ctx) return { ok: false, message: FALLBACK };
  const tz = candidateTz(req, ctx.callRecord.phone);
  const start = decodeSlotId(slotId, applicationId);
  if (!start) return { ok: false, message: `Sorry, I couldn't reserve that time. ${FALLBACK}` };
  try {
    const { hold, existing } = await createHold({
      applicationId,
      start,
      source: 'ai_call',
      callRecordId: ctx.callRecord._id,
      candidateTimezone: tz,
    });
    const when = formatSpoken(new Date(hold?.start || start), tz);
    return {
      ok: true,
      existing: !!existing,
      message: existing
        ? `You already have a time reserved: ${when}. You'll get a confirmation by email once our team confirms it.`
        : `Great, I've reserved ${when}. You'll get a confirmation by email once our team confirms it.`,
    };
  } catch (err) {
    const taken = err?.errorCode === 'SLOT_TAKEN' || err?.code === 'SLOT_TAKEN';
    if (taken) {
      const offer = await buildSlotOffer(applicationId, tz).catch(() => null);
      if (offer?.ok) {
        return { ok: false, slots: offer.slots, message: `Sorry, that time was just taken. ${offer.message}` };
      }
    }
    logger.warn(`[ai-tools] hold failed app=${applicationId}: ${err?.message || err}`);
    return { ok: false, message: FALLBACK };
  }
}

const respond = (impl, label) => async (req, res) => {
  let result;
  try {
    result = await withBudget(impl(req));
  } catch (err) {
    logger.warn(`[ai-tools] ${label} error: ${err?.message || err}`);
    result = { ok: false, message: FALLBACK };
  }
  res.status(200).json(result);
};

export const getInterviewSlots = respond(interviewSlotsImpl, 'interview-slots');
export const holdInterviewSlot = respond(holdSlotImpl, 'interview-slots/hold');
