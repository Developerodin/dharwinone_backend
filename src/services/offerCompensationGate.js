import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

/**
 * Decides whether an offer's compensation may still be changed, based on how far the candidate has
 * travelled past the offer stage.
 *
 * Compensation starts life as a draft term and becomes a record other things depend on — the
 * employee badge, list filters, headcount tallies, exports, chatbot answers. The further along the
 * placement is, the less it is the offer's business to change it.
 *
 * Pure and standalone on purpose: both `offer.service` (which enforces it) and `offer.controller`
 * (which surfaces it to the UI) need this decision, and putting it in `placement.service` would
 * create an offer↔placement import cycle.
 */

/** Placement is progressing toward employment — editable, but the user must mean it. */
const LIVE_STAGES = new Set(['Pending', 'Onboarding']);

/** Placement is off-ramp — nothing is progressing, so revive it before editing terms. */
const OFFRAMP_STAGES = new Set(['Deferred', 'Cancelled']);

/**
 * @param {{status: string, cancelledBy?: any, cancelledAt?: Date, deferredBy?: any, deferredAt?: Date}|null} placement
 * @returns {{allowed: boolean, confirm: boolean, reason: 'no-placement'|'live'|'offramp'|'joined'|'unknown-stage', stage: string|null, actorId: any, at: Date|null}}
 */
export const evaluateCompensationChange = (placement) => {
  const base = {
    allowed: false,
    confirm: false,
    reason: 'unknown-stage',
    stage: null,
    actorId: null,
    at: null,
  };

  // No placement means the offer was never accepted — still a negotiable term.
  if (!placement) {
    return { ...base, allowed: true, reason: 'no-placement' };
  }

  const stage = placement.status ?? null;

  if (LIVE_STAGES.has(stage)) {
    return { ...base, allowed: true, confirm: true, reason: 'live', stage };
  }

  if (OFFRAMP_STAGES.has(stage)) {
    // Attribution is best-effort: rows written before cancelledBy/deferredBy existed have neither.
    // Missing attribution must never soften the block — it only makes the message vaguer.
    const cancelled = stage === 'Cancelled';
    return {
      ...base,
      reason: 'offramp',
      stage,
      actorId: (cancelled ? placement.cancelledBy : placement.deferredBy) ?? null,
      at: (cancelled ? placement.cancelledAt : placement.deferredAt) ?? null,
    };
  }

  if (stage === 'Joined') {
    return { ...base, reason: 'joined', stage };
  }

  // Deliberately closed: a status added to PLACEMENT_STATUSES later must not inherit edit rights by
  // falling through. Whoever adds one decides here which bucket it belongs to.
  return { ...base, stage };
};

/**
 * Enforcement wrapper the offer service calls before persisting a compensation change.
 *
 * The confirmation dialog lives in the browser and is therefore bypassable, and the offer letter
 * form resends its entire body on every save — so a stale form could carry an old job type into a
 * placement that has since moved on. The acknowledgement is required server-side for that reason;
 * the dialog is the courtesy, this is the guarantee.
 *
 * Acknowledgement is consent, not authority: it unlocks a live placement, never a joined or
 * off-ramped one.
 *
 * @param {{placement: object|null, changing: boolean, ack: boolean}} params
 * @throws {ApiError} 422 with a stable errorCode and details for the client message
 */
export const assertCompensationChangeAllowed = ({ placement, changing, ack }) => {
  if (!changing) return;

  const verdict = evaluateCompensationChange(placement);
  const details = { stage: verdict.stage, actorId: verdict.actorId ?? null, at: verdict.at ?? null };

  if (verdict.reason === 'joined') {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'This candidate has already joined. Change compensation from their employee record instead.',
      true,
      '',
      { errorCode: 'COMPENSATION_LOCKED_EMPLOYEE', details }
    );
  }

  if (verdict.reason === 'offramp') {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      `This placement is ${String(verdict.stage).toLowerCase()}. Restore it to Pending before changing compensation.`,
      true,
      '',
      { errorCode: 'COMPENSATION_LOCKED_OFFRAMP', details }
    );
  }

  if (!verdict.allowed) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'Compensation cannot be changed at this placement stage.',
      true,
      '',
      { errorCode: 'COMPENSATION_LOCKED_STAGE', details }
    );
  }

  if (verdict.confirm && !ack) {
    throw new ApiError(
      httpStatus.UNPROCESSABLE_ENTITY,
      'This candidate is already past the offer stage. Confirm the compensation change to continue.',
      true,
      '',
      { errorCode: 'COMPENSATION_CHANGE_NEEDS_CONFIRMATION', details }
    );
  }
};

export default { evaluateCompensationChange, assertCompensationChangeAllowed };
