import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { ActivityActions, EntityTypes } from '../../../../../config/activityLog.js';
import { hiringScope } from './common.js';
import {
  INTERVIEW_TRANSCRIPT_ACCESS, interviewDetailDeps, resolveInterview, interviewBrief, jobTitleFor, idOf,
  listRecordingsSafe, canLookUpInterviews, summarizeUtterances, fullTranscriptText, auditView, isNotFound,
} from './interviewDetail.js';

const ATTRIBUTION = 'Machine transcript of what each speaker said — attributed statements, not verified facts.';
const lookupText = (what) => Joi.string().min(1).max(200).description(what);

/** Why there is no transcript: the recordings list tells "never recorded" from "recorded, not transcribed". */
async function noTranscriptReason(m, deps) {
  const recordings = await listRecordingsSafe(m, deps);
  if (!recordings.length) return 'The interview was not recorded.';
  return recordings.some((r) => r.status === 'completed')
    ? 'The interview was recorded, but no transcript has been produced (yet).'
    : 'The interview has no completed recording, so there is no transcript.';
}

export default defineTool({
  name: 'get_interview_transcript',
  domain: 'hiring',
  kind: 'read',
  description:
    'Transcript of ONE ATS interview, by interview id or candidate name (+ optional job position): speakers ' +
    'with how much each spoke, and the conversation in consecutive chunks with short excerpts. ' +
    'includeFullText: true adds the verbatim text (capped). Use for "what did <candidate> say about …", ' +
    '"show the transcript of <candidate>\'s interview". Content is what people said, never established fact.',
  input: Joi.object({
    id: lookupText('Interview id from an earlier list_interviews / get_interview result.'),
    candidate: lookupText('Candidate (person interviewed) name, partial match.'),
    jobPosition: lookupText('Narrows a candidate lookup to one job position, partial match.'),
    includeFullText: Joi.boolean().default(false)
      .description('true only when the user asks for the full / verbatim transcript.'),
  }).or('id', 'candidate'),
  access: INTERVIEW_TRANSCRIPT_ACCESS,
  async execute({ includeFullText, ...args } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = interviewDetailDeps(ctx);
    // By id this is exactly GET /meetings/:id/transcript. By name it is also the Interviews list (GET /meetings).
    if (!args.id && !(await canLookUpInterviews(user, deps))) {
      return { error: 'Finding an interview by candidate name needs interviews.read (the Interviews page); ask for its id.' };
    }
    const found = await resolveInterview(args, user, deps);
    if (!found.meeting) return found;
    const m = found.meeting;
    const interview = interviewBrief(m, await jobTitleFor(m, deps));

    let t;
    try {
      t = await deps.getInterviewTranscript(idOf(m), user);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      return { interview, transcriptAvailable: false, reason: await noTranscriptReason(m, deps) };
    }

    const utterances = t?.utterances || [];
    if (!utterances.length) {
      return {
        interview,
        transcriptAvailable: false,
        reason: (t?.utteranceCount ?? 0) > 0
          ? 'The transcript exists but could not be loaded right now; try again later.'
          : 'The transcript is empty.',
      };
    }

    // interviewTranscript.controller getTranscript's row.
    auditView(deps, user, {
      action: ActivityActions.INTERVIEW_TRANSCRIPT_VIEW,
      entityType: EntityTypes.TRANSCRIPT_VERSION,
      entityId: t.transcriptVersionId,
      metadata: { interviewId: t.interviewId, meetingId: t.meetingId, transcriptVersion: t.version },
    });

    return {
      interview,
      transcriptAvailable: true,
      attribution: ATTRIBUTION,
      version: t.version ?? null,
      partialReasons: t.partialReasons?.length ? t.partialReasons : undefined,
      utteranceCount: utterances.length,
      ...summarizeUtterances(utterances),
      ...(includeFullText ? fullTranscriptText(utterances) : {}),
    };
  },
  render(result) {
    if (!result?.transcriptAvailable) return null;
    return {
      blocks: [{
        type: 'kv',
        title: `Transcript — ${result.interview?.candidate ?? 'interview'}`,
        pairs: (result.speakers || []).map((s) => ({
          label: s.role ? `${s.name} (${s.role})` : s.name,
          value: `${s.utterances} utterances`,
        })),
      }],
      facts: { counts: [], primary: null },
    };
  },
});
