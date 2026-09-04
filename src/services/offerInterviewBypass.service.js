import Meeting from '../models/meeting.model.js';
import Employee from '../models/employee.model.js';
import { meetingMatchesApplication } from '../utils/candidateApplicationInterviewResult.js';
import { generateUniqueLivekitRoomId } from '../utils/livekitRoomId.js';
import { syncReferralPipelineStatusForCandidate } from './referralLeads.service.js';

const applicationMeta = (application) => {
  const plain = application?.toObject?.() ?? application ?? {};
  const candidateId = String(plain.candidate?._id ?? plain.candidate?.id ?? plain.candidate ?? '');
  const jobId = String(plain.job?._id ?? plain.job?.id ?? plain.job ?? '');
  const jobTitle = plain.job?.title || '';
  return { plain, candidateId, jobId, jobTitle };
};

/** True when a non-cancelled meeting for this application already has interviewResult selected. */
export async function applicationHasSelectedInterview(application) {
  const { candidateId, jobId, jobTitle } = applicationMeta(application);
  if (!candidateId) return false;

  const meetings = await Meeting.find({
    'candidate.id': candidateId,
    status: { $ne: 'cancelled' },
  })
    .select('candidate jobPosition interviewResult status')
    .lean();

  return meetings.some(
    (m) =>
      meetingMatchesApplication(m, { candidateId, jobId, jobTitle }) && m.interviewResult === 'selected'
  );
}

/**
 * Mark interview selected for offer-without-interview. Uses direct Meeting writes — not
 * updateMeetingById — so createPlacementFromInterview does not race createOfferCore.
 */
export async function ensureInterviewSelectedForOfferBypass(application, userId) {
  if (await applicationHasSelectedInterview(application)) return;

  const { plain, candidateId, jobId, jobTitle } = applicationMeta(application);
  const meta = { candidateId, jobId, jobTitle };

  const meetings = await Meeting.find({
    'candidate.id': candidateId,
    status: { $ne: 'cancelled' },
  }).sort({ scheduledAt: -1 });

  const matching = meetings.filter((m) => meetingMatchesApplication(m, meta));
  if (matching.length) {
    const target = matching[0];
    if (target.interviewResult !== 'selected') {
      target.interviewResult = 'selected';
      if (target.status === 'scheduled') target.status = 'ended';
      const note = 'Interview marked selected via offer bypass.';
      target.notes = target.notes ? `${target.notes}\n${note}` : note;
      await target.save();
    }
  } else {
    const cand =
      plain.candidate?.email != null
        ? plain.candidate
        : await Employee.findById(candidateId).select('fullName email phoneNumber').lean();
    const roomId = await generateUniqueLivekitRoomId();
    await Meeting.create({
      meetingId: roomId,
      roomName: roomId,
      title: `Interview — ${jobTitle || 'Role'}`,
      scheduledAt: new Date(),
      durationMinutes: 60,
      jobPosition: jobId,
      interviewType: 'Video',
      candidate: {
        id: candidateId,
        name: cand?.fullName || '',
        email: cand?.email || '',
        phone: cand?.phoneNumber || '',
      },
      status: 'ended',
      interviewResult: 'selected',
      notes: 'Interview marked selected via offer bypass (no prior interview scheduled).',
      createdBy: userId,
    });
  }

  await syncReferralPipelineStatusForCandidate(candidateId);
}
