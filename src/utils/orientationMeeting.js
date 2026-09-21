import httpStatus from 'http-status';
import ApiError from './ApiError.js';

/** Fields populated onto Placement.orientationMeetingId for Edit HRMS. */
export const ORIENTATION_MEETING_POPULATE = 'title scheduledAt timezone status meetingId';

export function isActiveOrientationMeeting(meeting) {
  if (!meeting) return false;
  return String(meeting.status || '').toLowerCase() !== 'cancelled';
}

export function orientationMeetingRefId(ref) {
  if (ref == null || ref === '') return '';
  if (typeof ref === 'object') return String(ref._id || ref.id || '');
  return String(ref);
}

/**
 * Duplicate guard: while a linked orientation meeting exists and is not cancelled,
 * do not attach a different meeting — reschedule via PATCH /internal-meetings/:id.
 *
 * @param {object} args
 * @param {unknown} args.currentMeetingId
 * @param {{ status?: string }|null|undefined} args.currentMeeting
 * @param {unknown} [args.nextMeetingId] - omit/null when creating a new meeting
 */
export function assertCanAssignOrientationMeeting({ currentMeetingId, currentMeeting, nextMeetingId } = {}) {
  const currentId = orientationMeetingRefId(currentMeetingId);
  if (!currentId) return;
  const nextId = orientationMeetingRefId(nextMeetingId);
  if (nextId && currentId === nextId) return;
  if (isActiveOrientationMeeting(currentMeeting)) {
    throw new ApiError(
      httpStatus.CONFLICT,
      'An orientation meeting is already scheduled. Reschedule it instead of creating another.'
    );
  }
}

/**
 * Title format locked for Edit HRMS orientation meetings.
 * @param {{ dateLabel: string, timeLabel: string, timezone?: string }} args
 */
export function composeOrientationMeetingTitle({ dateLabel, timeLabel, timezone } = {}) {
  const date = String(dateLabel || '').trim() || '—';
  const time = String(timeLabel || '').trim() || '—';
  const tz = String(timezone || '').trim() || 'UTC';
  return `Orientation and compliance meeting — ${date}, ${time} (${tz})`;
}

/** Same titles/order as Edit HRMS COMPLIANCE & ORIENTATION CHECKLIST. */
export const ORIENTATION_ONBOARDING_TASKS = [
  { title: 'Orientation session scheduled', order: 0 },
  { title: 'Policies / handbook acknowledged (HR confirmed)', order: 1 },
];

export const ORIENTATION_ONBOARDING_TASK_TITLES = ORIENTATION_ONBOARDING_TASKS.map((t) => t.title);

const ORIENTATION_TASK_TITLE_SET = new Set(ORIENTATION_ONBOARDING_TASK_TITLES);

export function normalizeOrientationTaskTitle(title) {
  return String(title || '').trim();
}

export function isAllowedOrientationOnboardingTitle(title) {
  return ORIENTATION_TASK_TITLE_SET.has(normalizeOrientationTaskTitle(title));
}

/** Host checklist is available after the LiveKit session is no longer upcoming. */
export function isOrientationMeetingEnded(meeting) {
  if (!meeting) return false;
  const status = String(meeting.status || '').toLowerCase();
  if (status === 'ended' || status === 'completed') return true;
  return Boolean(meeting.endedAt);
}

export function ensureOrientationOnboardingTasks(existing = []) {
  const list = Array.isArray(existing)
    ? existing.map((t) => (t && typeof t === 'object' ? { ...t } : t)).filter(Boolean)
    : [];
  for (const def of ORIENTATION_ONBOARDING_TASKS) {
    const found = list.find((t) => normalizeOrientationTaskTitle(t.title) === def.title);
    if (!found) {
      list.push({
        title: def.title,
        required: true,
        done: false,
        doneAt: null,
        order: def.order,
      });
    }
  }
  return list;
}

/**
 * Merge host checkbox patches onto the two orientation titles only.
 * Extra onboarding tasks on the placement are left as-is.
 */
export function applyOrientationOnboardingTaskPatch(existing, patches) {
  const list = ensureOrientationOnboardingTasks(existing);
  for (const patch of patches || []) {
    const title = normalizeOrientationTaskTitle(patch?.title);
    if (!ORIENTATION_TASK_TITLE_SET.has(title)) continue;
    if (typeof patch.done !== 'boolean') continue;
    const row = list.find((t) => normalizeOrientationTaskTitle(t.title) === title);
    if (!row) continue;
    row.done = patch.done;
    row.doneAt = patch.done ? new Date() : null;
    row.required = true;
  }
  return list;
}

export function pickOrientationOnboardingTasks(tasks) {
  const list = ensureOrientationOnboardingTasks(tasks);
  return ORIENTATION_ONBOARDING_TASKS.map((def) => {
    const row = list.find((t) => normalizeOrientationTaskTitle(t.title) === def.title);
    return {
      title: def.title,
      required: true,
      done: Boolean(row?.done),
      order: def.order,
      _id: row?._id ? String(row._id) : undefined,
    };
  });
}
