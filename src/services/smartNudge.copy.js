import logger from '../config/logger.js';
import SmartNudgeCopyCache from '../models/smartNudgeCopyCache.model.js';
import { COPY_CACHE_TTL_MS } from '../constants/smartNudge.situations.js';
import { copySignature, clampCopy } from './smartNudge.helpers.js';
import { generateNudgeCopies } from './smartNudge.openai.js';

/**
 * Static fallback when OpenAI is down or returns garbage.
 * @param {{ situation: string, audience: string, days?: number, label?: string }} facts
 * @returns {{ title: string, message: string }}
 */
export const fallbackCopy = (facts) => {
  const label = String(facts.label || 'this item').slice(0, 60);
  const days = facts.days;
  const key = `${facts.situation}:${facts.audience}`;
  const map = {
    'interview_no_show:candidate': {
      title: 'You missed an interview',
      message: `You missed "${label}". Contact your recruiter to reschedule.`,
    },
    'interview_no_show:recruiter': {
      title: 'Candidate no-show',
      message: `The candidate didn't join "${label}". Reschedule or record a result.`,
    },
    'result_overdue:recruiter': {
      title: 'Record the interview result',
      message: `"${label}" still has no result. Mark selected or rejected.`,
    },
    'application_stale:recruiter': {
      title: 'Application waiting',
      message: `An application for "${label}" has had no update for ${days || 'several'} days.`,
    },
    'selected_no_offer:recruiter': {
      title: 'Offer not sent yet',
      message: `"${label}" is selected but has no offer. Send one to keep the hire moving.`,
    },
    'offer_aging:candidate': {
      title: 'Offer awaiting your response',
      message: `Please respond to the offer for "${label}" so we can proceed.`,
    },
    'offer_aging:recruiter': {
      title: 'Offer still unanswered',
      message: `The offer for "${label}" is still Sent. Follow up with the candidate.`,
    },
    'joining_overdue:recruiter': {
      title: 'Joining date has passed',
      message: `${label} is still in pre-boarding after the joining date. Update the placement.`,
    },
    'joining_overdue:agent': {
      title: 'Joining date has passed',
      message: `${label}'s joining date passed and they are still Pending. Check handoff.`,
    },
    'preboard_incomplete:recruiter': {
      title: 'Pre-boarding incomplete',
      message: `${label} joins in 3 days with unfinished pre-boarding tasks.`,
    },
    'preboard_incomplete:candidate': {
      title: 'Complete pre-boarding',
      message: `Joining is in 3 days for "${label}". Finish remaining pre-boarding steps.`,
    },
    'task_overdue:employee': {
      title: 'Task overdue',
      message: `"${label}" is past its due date. Update it or mark it done.`,
    },
    'leave_pending_stale:admin': {
      title: 'Leave request waiting',
      message: `A leave request from ${label} has been pending for ${days || 'several'} days.`,
    },
  };
  return clampCopy(map[key] || { title: 'Reminder', message: `Please review "${label}".` });
};

/**
 * Resolve title/message for events: cache → one batched mini call for misses → templates.
 * @param {object[]} events
 * @param {{ generateBatch?: Function, cacheFind?: Function, cacheWrite?: Function, now?: Date }} [deps]
 * @returns {Promise<Map<string, { title: string, message: string }>>}
 */
export const resolveCopies = async (events, deps = {}) => {
  const now = deps.now || new Date();
  const generateBatch = deps.generateBatch || generateNudgeCopies;
  const cacheFind =
    deps.cacheFind ||
    (async (signatures) => {
      if (!signatures.length) return [];
      return SmartNudgeCopyCache.find({ signature: { $in: signatures }, expiresAt: { $gt: now } })
        .select('signature title message')
        .lean();
    });
  const cacheWrite =
    deps.cacheWrite ||
    (async (row) => {
      await SmartNudgeCopyCache.updateOne(
        { signature: row.signature },
        {
          $set: {
            title: row.title,
            message: row.message,
            expiresAt: new Date(now.getTime() + COPY_CACHE_TTL_MS),
          },
        },
        { upsert: true }
      );
    });

  const bySig = new Map();
  for (const ev of events) {
    const sig = copySignature(ev.facts);
    if (!bySig.has(sig)) bySig.set(sig, ev.facts);
  }
  const signatures = [...bySig.keys()];
  const cached = await cacheFind(signatures);
  const result = new Map();
  for (const row of cached) {
    result.set(row.signature, clampCopy(row));
  }

  const misses = signatures.filter((s) => !result.has(s));
  if (misses.length) {
    const payload = misses.map((id) => ({ id, ...bySig.get(id) }));
    let generated = [];
    try {
      generated = await generateBatch(payload);
    } catch (err) {
      logger.warn(`[smartNudge] copy generation failed: ${err?.message || err}`);
    }
    const byId = new Map((generated || []).filter((g) => g.id).map((g) => [g.id, g]));
    for (const sig of misses) {
      const facts = bySig.get(sig);
      const ai = byId.get(sig);
      const copy = ai?.title && ai?.message ? clampCopy(ai) : fallbackCopy(facts);
      result.set(sig, copy);
      try {
        await cacheWrite({ signature: sig, ...copy });
      } catch (err) {
        logger.warn(`[smartNudge] copy cache write failed: ${err?.message || err}`);
      }
    }
  }
  return result;
};
