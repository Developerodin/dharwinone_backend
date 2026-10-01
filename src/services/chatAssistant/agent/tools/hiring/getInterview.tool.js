import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { ActivityActions, EntityTypes } from '../../../../../config/activityLog.js';
import { INTERVIEWS_ACCESS, hiringScope, formatInterviewers } from './common.js';
import {
  NOT_CAPTURED, interviewDetailDeps, resolveInterview, offerReadyByMeeting, jobTitleFor, listRecordingsSafe, loadAiSummary,
  evaluationRow, legacyScorecard, panelOf, attendanceOf, loadInterviewHistory, auditView, idOf, createdAtOf,
} from './interviewDetail.js';

const PLAYABLE = new Set(['completed', 'aborted']);
const lookupText = (what) => Joi.string().min(1).max(200).description(what);

function recordingSummary(recordings) {
  const completed = recordings.find((r) => r.status === 'completed') || null;
  const playable = recordings.find((r) => PLAYABLE.has(r.status) && r.playbackUrl) || null;
  const latest = recordings[0] || null;
  return {
    recorded: !!completed,
    recordingCount: recordings.length,
    latestStatus: latest?.status ?? null,
    recordingId: (completed || latest)?.id ?? null,
    durationMs: (completed || latest)?.durationMs ?? null,
    // Presigned S3 link, same as the Interviews page's recordings list (GET /meetings/:id/recordings); it expires.
    playbackUrl: playable?.playbackUrl ?? null,
    playbackPartial: playable?.status === 'aborted' || undefined,
  };
}

export default defineTool({
  name: 'get_interview',
  domain: 'hiring',
  kind: 'read',
  description:
    'Full detail of ONE ATS interview by id or candidate name (+ optional job position): slot and timezone, panel, ' +
    'who scheduled it, job, status, result, who changed the result and when (history, if you can see activity ' +
    'logs), who joined the video room (attendance), whether it was recorded (with a temporary playback link), ' +
    'the AI summary (when you may see summaries), interviewer evaluations, when the reminder will send ' +
    '(reminderAt) and whether it already went (reminderSent), and resultMissing / feedbackMissing flags. ' +
    'Use for "how did <candidate>\'s interview go", "who is on the panel for <candidate>", "was it recorded", ' +
    '"who marked <candidate> selected", "when is the reminder". Several interviews fit → { matches } to ask ' +
    'which one, each with its result. offerReady / offerReadyReason are the Move to Offer gate for this application ' +
    '(one offerReady when the rounds are the same application). reminderAt null means no reminder time is stored — never invent one.',
  input: Joi.object({
    id: lookupText('Interview id from an earlier list_interviews / get_interview result.'),
    candidate: lookupText('Candidate (person interviewed) name, partial match.'),
    jobPosition: lookupText('Narrows a candidate lookup to one job position, partial match.'),
  }).or('id', 'candidate'),
  access: INTERVIEWS_ACCESS,
  async execute(args = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = interviewDetailDeps(ctx);
    const found = await resolveInterview(args, user, deps, { offerReady: true });
    if (!found.meeting) return found;
    const m = found.meeting;
    const id = idOf(m);

    const [jobTitle, recordings, grouped, ai, history] = await Promise.all([
      jobTitleFor(m, deps),
      listRecordingsSafe(m, deps),
      deps.listEvaluations([id]),
      loadAiSummary(m, user, deps),
      loadInterviewHistory(m, user, deps),
    ]);
    const evaluations = (grouped?.get?.(id) || []).map(evaluationRow);
    const scorecard = legacyScorecard(m);
    const ended = String(m.status || '').toLowerCase() === 'ended';
    const recording = recordingSummary(recordings);
    const offer = (await offerReadyByMeeting([m])).shared;

    // Same rows as meeting.controller getRecordings / interviewTranscript.controller getSummary, written only
    // for content this answer actually carries.
    if (recordings.length) {
      auditView(deps, user, {
        action: ActivityActions.INTERVIEW_RECORDING_VIEW,
        entityType: EntityTypes.MEETING,
        entityId: id,
        metadata: { recordingCount: recordings.length },
      });
    }
    if (ai.summary && ai.summaryId) {
      auditView(deps, user, {
        action: ActivityActions.INTERVIEW_SUMMARY_VIEW,
        entityType: EntityTypes.SUMMARY,
        entityId: ai.summaryId,
        metadata: ai.auditMetadata,
      });
    }

    return {
      interview: {
        id,
        title: m.title ?? null,
        candidate: m.candidate?.name ?? null,
        jobPosition: jobTitle,
        jobId: m.jobId ? String(m.jobId) : null,
        round: m.round?.label ?? null,
        interviewType: m.interviewType ?? null,
        scheduledAt: m.scheduledAt ?? null,
        timezone: m.timezone ?? null,
        durationMinutes: m.durationMinutes ?? null,
        status: m.status ?? null,
        result: m.interviewResult ?? null,
        completedAt: m.interviewCompletedAt ?? null,
        reminderAt: m.remindAt ?? null,
        reminderSentAt: m.reminderSentAt ?? null,
        reminderSent: Boolean(m.reminderSentAt),
        ...(m.remindAt ? {} : {
          reminderNote: 'No reminder time is stored for this interview (booked inside the lead time, or the field was never set).',
        }),
        scheduledBy: m.createdBy?.name ?? null,
        scheduledOn: createdAtOf(m),
        interviewers: formatInterviewers(m),
        panel: panelOf(m),
      },
      offerReady: offer.offerReady,
      offerReadyReason: offer.offerReadyReason,
      attendance: attendanceOf(m),
      history: history.hidden ? null : history,
      ...(history.hidden ? { historyHidden: true } : {}),
      recording,
      aiSummary: ai.summary,
      ...(ai.hidden ? { aiSummaryHidden: true } : {}),
      evaluations,
      legacyScorecard: scorecard,
      resultMissing: ended && (!m.interviewResult || m.interviewResult === 'pending'),
      feedbackMissing: ended && !scorecard && !evaluations.some((e) => e.submittedAt),
      notCaptured: NOT_CAPTURED,
    };
  },
  render(result) {
    const iv = result?.interview;
    if (!iv) return null;
    const pairs = [
      { label: 'Candidate', value: iv.candidate ?? '—' },
      { label: 'Position', value: iv.jobPosition ?? '—' },
      { label: 'When', value: iv.scheduledAt ? new Date(iv.scheduledAt).toISOString() : '—' },
      { label: 'Timezone', value: iv.timezone ?? '—' },
      { label: 'Interviewers', value: iv.interviewers ?? '—' },
      { label: 'Scheduled by', value: iv.scheduledBy ?? '—' },
      { label: 'Reminder at', value: iv.reminderAt ? new Date(iv.reminderAt).toISOString() : '—' },
      { label: 'Reminder sent', value: iv.reminderSent ? 'Yes' : 'No' },
      { label: 'Status', value: iv.status ?? '—' },
      { label: 'Result', value: iv.result ?? '—', ...(result.resultMissing ? { tone: 'warn' } : {}) },
      { label: 'Recorded', value: result.recording?.recorded ? 'Yes' : 'No' },
      { label: 'Evaluations', value: String(result.evaluations?.length ?? 0), ...(result.feedbackMissing ? { tone: 'warn' } : {}) },
    ];
    return {
      blocks: [{ type: 'kv', title: iv.title || 'Interview', pairs }],
      facts: { counts: [], primary: null },
    };
  },
});
