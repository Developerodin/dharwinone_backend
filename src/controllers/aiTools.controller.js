import JobApplication from '../models/jobApplication.model.js';
import CallRecord from '../models/callRecord.model.js';
import logger from '../config/logger.js';
import { getFreeSlots, encodeSlotId, decodeSlotId, verifyApplicationRef } from '../services/interviewSlot.service.js';
import { createHold } from '../services/interviewHold.service.js';
import { formatSpoken, guessCandidateTimezone } from '../services/interviewBooking.service.js';
import { isValidTimeZone } from '../utils/zonedTime.js';
import { CLOSED_APPLICATION_STATUSES } from '../constants/atsPipeline.js';

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

const withBudget = (promise, fallback = FALLBACK) =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, message: fallback, timedOut: true }), BUDGET_MS);
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

const respond = (impl, label, fallback = FALLBACK) => async (req, res) => {
  let result;
  try {
    result = await withBudget(impl(req), fallback);
  } catch (err) {
    logger.warn(`[ai-tools] ${label} error: ${err?.message || err}`);
    result = { ok: false, message: fallback };
  }
  res.status(200).json(result);
};

export const getInterviewSlots = respond(interviewSlotsImpl, 'interview-slots');
export const holdInterviewSlot = respond(holdSlotImpl, 'interview-slots/hold');

const CALLBACK_MIN = 5;
const CALLBACK_MAX = 48 * 60;
const MAX_CALLBACKS = 2;
const CALLBACK_FAIL = 'I am sorry, I cannot book a call back right now. Our team will reach out to you by email.';

export const parseCallbackMinutes = (raw) => {
  const n = Math.round(Number(String(raw ?? '').trim() || NaN));
  return Number.isFinite(n) && n >= CALLBACK_MIN && n <= CALLBACK_MAX ? n : null;
};

export const spokenDelay = (minutes) => {
  if (minutes < 60) return `in about ${minutes} minutes`;
  const h = Math.round(minutes / 60);
  return `in about ${h} hour${h === 1 ? '' : 's'}`;
};

/** Applications created before this feature have no counter at all; `$lt` alone would never match them. */
export const callbackClaimFilter = (applicationId) => ({
  _id: applicationId,
  $or: [{ verificationCallbackCount: { $exists: false } }, { verificationCallbackCount: { $lt: MAX_CALLBACKS } }],
});

/** True once the pipeline has moved past active verification calling for this application. */
export const isClosedForCallback = (application) =>
  CLOSED_APPLICATION_STATUSES.includes(application?.status) || application?.verificationCallStatus === 'withdrawn';

async function scheduleCallbackImpl(req) {
  const applicationId = verifyApplicationRef(param(req, 'application_id'));
  const ctx = await loadContext(applicationId);
  if (!ctx) return { ok: false, message: CALLBACK_FAIL };
  if (isClosedForCallback(ctx.application)) return { ok: false, message: CALLBACK_FAIL };
  const minutes = parseCallbackMinutes(param(req, 'minutes'));
  if (minutes == null) {
    return { ok: false, message: 'I can call you back from five minutes up to two days from now. When suits you?' };
  }
  // ponytail: dialled by the 2-minute scheduler tick, so a callback lands up to ~2 minutes late.
  // No quiet-hours check; add one if candidates get called back at night. Same edge as the hold
  // path above (see file header): if the 3s budget fires right as this findOneAndUpdate commits,
  // the agent already said "I cannot book that" while the callback is in fact booked — harmless,
  // the candidate just gets an unexpected call. A 5-minute callback can also ring while the
  // current call is still live if the agent is slow to hang up.
  const updated = await JobApplication.findOneAndUpdate(
    callbackClaimFilter(applicationId),
    { $set: { verificationCallbackAt: new Date(Date.now() + minutes * 60000) }, $inc: { verificationCallbackCount: 1 } },
    { new: true, projection: { _id: 1 } }
  ).lean();
  if (!updated) return { ok: false, message: CALLBACK_FAIL };
  return { ok: true, message: `Sure. I will call you back ${spokenDelay(minutes)}. Talk to you then.` };
}

export const scheduleCallback = respond(scheduleCallbackImpl, 'callback', CALLBACK_FAIL);
