import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  MEETING_DETAIL_ACCESS, NOT_CAPTURED, baseFilter, isPlayableRecording, meetingsDeps, meetingsScope, toRecord,
} from './common.js';

const MAX_MATCHES = 5;
const MAX_ATTENDEES = 50;
const MAX_DECISIONS = 20;
const MAX_ACTION_ITEMS = 30;
const MAX_EXECUTIVE_SUMMARY_CHARS = 1500;

const bound = (text, max) => {
  const s = String(text || '').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** getInternalMeetingById throws a 404 ApiError for a meeting outside internalMeetingScope. */
async function loadById(id, user, deps) {
  try {
    return await deps.getInternalMeetingById(id, user);
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

/** Title (+ optional day) through the Meetings page query, so the page's scope applies. */
async function findByTitle(title, date, user, deps) {
  const filter = baseFilter({ search: title, ...(date ? { scheduledBetween: { from: date, to: date } } : {}) }, deps.now());
  const res = await deps.queryInternalMeetings(filter, { limit: MAX_MATCHES, page: 1, sortBy: '-scheduledAt' }, user, {});
  const rows = res?.results || [];
  if (rows.length === 1) return { meeting: rows[0] };
  const exact = rows.filter((m) => String(m.title || '').trim().toLowerCase() === title.trim().toLowerCase());
  if (exact.length === 1) return { meeting: exact[0] };
  return { matches: rows.map(toRecord), total: res?.totalResults ?? rows.length };
}

/** Who joined the video room (participantRoster); names and join times only — no identities or email hashes. */
function toAttendees(roster) {
  return (roster || []).slice(0, MAX_ATTENDEES).map((p) => ({
    name: p?.displayName || null,
    role: p?.role || null,
    firstJoinedAt: p?.firstJoinedAt ?? null,
    lastJoinedAt: p?.lastJoinedAt ?? null,
  }));
}

function toSummary(s) {
  if (!s) return null;
  return {
    executiveSummary: bound(s.executiveSummary, MAX_EXECUTIVE_SUMMARY_CHARS),
    decisions: (s.decisions || []).slice(0, MAX_DECISIONS).map((d) => d?.text).filter(Boolean),
    actionItems: (s.actionItems || []).slice(0, MAX_ACTION_ITEMS).map((a) => ({
      text: a?.text ?? null,
      owner: a?.owner || null,
      due: a?.dueHint || null,
    })),
    partial: !!s.partial,
    generatedAt: s.generatedAt ?? null,
  };
}

export default defineTool({
  name: 'get_meeting',
  domain: 'meetings',
  kind: 'read',
  description:
    'One internal / team meeting (Communication → Meetings) by id, or by title with an optional day: ' +
    'status, time, hosts, who attended (joined the room), whether it was recorded plus the recording link, ' +
    'and its AI summary with decisions and action items (owner, due). Use for "what was decided in the ' +
    'sprint sync", "who attended yesterday\'s standup", "was the onboarding meeting recorded", "action items ' +
    'from the design review". Several title matches → { matches }; none → { found: false }. Never for interviews.',
  input: Joi.object({
    id: Joi.string().min(1).max(64).description('Meeting id from list_meetings (or the room id).'),
    title: Joi.string().min(1).max(200).description('Meeting title, or part of it. Used when no id is known.'),
    date: Joi.string().min(10).max(10).description('YYYY-MM-DD (IST) the meeting was scheduled on, to narrow a title.'),
  }),
  access: MEETING_DETAIL_ACCESS,
  async execute({ id, title, date } = {}, ctx) {
    const user = meetingsScope(ctx);
    const deps = meetingsDeps(ctx);
    if (!id && !title) throw new Error('Give a meeting id or a title.');

    let meeting;
    if (id) {
      meeting = await loadById(id, user, deps);
    } else {
      const found = await findByTitle(title, date, user, deps);
      if (found.matches) return { found: false, matches: found.matches, total: found.total };
      meeting = found.meeting;
    }
    if (!meeting) return { found: false, matches: [] };

    const record = toRecord(meeting);
    const [recordings, summary] = await Promise.all([
      deps.listRecordings(record.id),
      meeting.meetingId ? deps.findSummary(meeting.meetingId) : null,
    ]);
    const playable = (recordings || []).filter(isPlayableRecording);
    const attendees = toAttendees(meeting.participantRoster);

    return {
      found: true,
      meeting: {
        ...record,
        endedAt: meeting.endedAt ?? null,
        attendees,
        ...(attendees.length ? {} : { attendeesNote: `No one joined the meeting room — attendance ${NOT_CAPTURED}.` }),
        recorded: playable.length > 0,
        recordingCount: playable.length,
        // Signed playback URL from recording.service; it expires, so it is only good for this answer.
        recordingLink: playable[0]?.playbackUrl ?? null,
        summary: toSummary(summary),
        ...(summary ? {} : { summaryNote: `Summary, decisions and action items ${NOT_CAPTURED} for this meeting.` }),
      },
    };
  },
  render(result) {
    if (!result?.found) return null;
    const { summary } = result.meeting;
    const blocks = summary?.actionItems?.length ? [{
      type: 'table',
      id: 'meeting-action-items',
      tableType: 'meeting-action-items',
      title: `Action items — ${result.meeting.title ?? 'meeting'}`,
      columns: [
        { key: 'text', label: 'Action', priority: 'primary' },
        { key: 'owner', label: 'Owner', priority: 'primary' },
        { key: 'due', label: 'Due', priority: 'secondary' },
      ],
      rows: summary.actionItems.map((a) => ({ text: a.text ?? '—', owner: a.owner ?? '—', due: a.due ?? '—' })),
      layout: 'auto',
    }] : [];
    return { blocks };
  },
});
