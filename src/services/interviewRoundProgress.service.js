/**
 * Round progress for one application: how far through its plan a candidate is.
 *
 * Derived in ONE place and returned to every reader. The interviews list, the interview
 * detail page, the round history panel, the end-of-interview popup and the Excel export
 * all show this, and five independent derivations is the trap buildRoundName was written
 * to avoid (audit R5, D8).
 *
 * Pure: the caller loads the plan and the meetings, this computes. No database access, so
 * every edge case below is a unit test rather than a fixture.
 */

/** A meeting is live unless it was cancelled. Cancelling frees the plan row it held. */
const isLive = (m) => String(m?.status || '') !== 'cancelled';

/**
 * Progress through an application's frozen round plan.
 *
 * Matching is on the stored planKey ONLY. round.index is never used: it keeps climbing
 * when a round is cancelled and rebooked, so a 3-round plan can hold rounds numbered 1
 * and 3, and index-based matching then mis-reports that application forever (audit R6).
 *
 * Failure modes handled:
 * - no plan (empty, or an application that predates the field) => hasPlan false, and every
 *   caller falls back to its pre-plan behaviour (audit R3, D5)
 * - a cancelled round => ignored entirely; its row reads unscheduled again
 * - two live meetings on one row => the later one in the caller's order wins. Callers pass
 *   meetings sorted by round index then scheduledAt, so that is the most recent.
 * - a meeting whose planKey matches no row, or has none => counted off-plan. It never
 *   blocks completion, because an ad-hoc extra round is a legitimate thing to hold.
 * - a rejection anywhere => the process stops. No next round, never complete.
 * - a round marked selected whose evaluation is only partly filled in => still passed.
 *   Completion is about round RESULTS, not evaluation coverage: coveragePct and an
 *   evaluation's own isComplete answer a different question and are deliberately not
 *   consulted here (audit R5).
 *
 * Ceiling: linear in plan rows times meetings, both single digits in any real process. If
 * an application ever carries hundreds of rounds, index the meetings by planKey first.
 *
 * @param {{planRounds?: Array<{key: string, label: string, roundType?: string|null}>,
 *          meetings?: Array<{_id: any, round?: {planKey?: string|null}, status?: string,
 *                            interviewResult?: string}>}} [input]
 * @returns {object} see the RoundProgress shape in the plan
 */
export const computeRoundProgress = ({ planRounds = [], meetings = [] } = {}) => {
  const plan = Array.isArray(planRounds) ? planRounds : [];
  const live = (Array.isArray(meetings) ? meetings : []).filter(isLive);

  if (!plan.length) {
    return {
      hasPlan: false,
      total: 0,
      heldCount: 0,
      passedCount: 0,
      offPlanCount: live.length,
      remainingCount: 0,
      isComplete: false,
      rejectedAt: null,
      nextRound: null,
      rows: [],
    };
  }

  const byKey = new Map();
  for (const m of live) {
    const key = m?.round?.planKey ? String(m.round.planKey) : '';
    if (key) byKey.set(key, m); // later entries win; callers pass rounds in order
  }

  const rows = plan.map((r, i) => {
    const m = byKey.get(String(r.key)) || null;
    const result = String(m?.interviewResult || '');
    let state = 'unscheduled';
    if (m) {
      if (result === 'selected') state = 'passed';
      else if (result === 'rejected') state = 'rejected';
      else state = 'pending';
    }
    return {
      key: String(r.key),
      label: String(r.label || r.key),
      roundType: r.roundType ?? null,
      index: i + 1,
      meetingId: m ? String(m._id) : null,
      status: m ? String(m.status || 'scheduled') : null,
      interviewResult: m ? result || 'pending' : null,
      state,
    };
  });

  const matchedKeys = new Set(rows.filter((r) => r.meetingId).map((r) => r.key));
  const offPlanCount = live.filter((m) => {
    const key = m?.round?.planKey ? String(m.round.planKey) : '';
    return !key || !matchedKeys.has(key);
  }).length;

  const rejected = rows.find((r) => r.state === 'rejected') || null;
  const heldCount = rows.filter((r) => r.meetingId).length;
  const passedCount = rows.filter((r) => r.state === 'passed').length;
  const isComplete = rows.every((r) => r.state === 'passed');
  const nextRound = rejected || isComplete ? null : rows.find((r) => r.state === 'unscheduled') || null;
  /**
   * Rounds still to finish: every row that has not passed, counted per ROW.
   *
   * A plan with two Technical rows needs both of them done — the unit is the row, never
   * the round type, which is the whole reason a row carries a frozen key. A scheduled
   * round with no result yet still counts as remaining: it is held, not finished.
   *
   * Zero once rejected. The process stopped, so nothing remains to run, and "2 remaining"
   * beside "Rejected at Technical 1" would read as work still expected.
   */
  const remainingCount = rejected ? 0 : rows.filter((r) => r.state !== 'passed').length;

  return {
    hasPlan: true,
    total: rows.length,
    heldCount,
    passedCount,
    offPlanCount,
    remainingCount,
    isComplete,
    rejectedAt: rejected ? { key: rejected.key, label: rejected.label, index: rejected.index } : null,
    nextRound: nextRound
      ? { key: nextRound.key, label: nextRound.label, roundType: nextRound.roundType, index: nextRound.index }
      : null,
    rows,
  };
};

/**
 * One sentence naming where the candidate is. Built server-side so the chip, the history
 * header and the Excel column cannot drift apart. Empty string when there is no plan —
 * callers render nothing rather than "0 of 0".
 *
 * @param {object} progress
 * @returns {string}
 */
export const roundProgressLabel = (progress) => {
  if (!progress?.hasPlan) return '';
  if (progress.rejectedAt) return `Rejected at ${progress.rejectedAt.label}`;
  if (progress.isComplete) {
    return `All ${progress.total} ${progress.total === 1 ? 'round' : 'rounds'} passed`;
  }
  return `${progress.passedCount} of ${progress.total} rounds passed`;
};
