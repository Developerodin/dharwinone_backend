import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import JobApplication from '../models/jobApplication.model.js';
import Meeting from '../models/meeting.model.js';
import InterviewHold from '../models/interviewHold.model.js';
import { getFreeSlots, encodeSlotId, decodeSlotId } from '../services/interviewSlot.service.js';
import { createHold } from '../services/interviewHold.service.js';
import { verifyBookingToken } from '../services/interviewBooking.service.js';
import { isValidTimeZone } from '../utils/zonedTime.js';

/** Public input: an unknown zone would throw in Intl (500) and poison the hold's candidateTimezone. */
const safeTz = (v) => (v && isValidTimeZone(String(v).slice(0, 64)) ? String(v).slice(0, 64) : undefined);

const holdView = (h) =>
  h ? { id: String(h._id), start: h.start, durationMinutes: h.durationMinutes, status: h.status, expiresAt: h.expiresAt } : undefined;

async function loadState(applicationId) {
  const application = await JobApplication.findById(applicationId)
    .select('candidate job status verificationCallStatus')
    .populate('candidate', 'fullName')
    .populate('job', 'title')
    .lean();
  if (!application) throw new ApiError(httpStatus.NOT_FOUND, 'Booking link is no longer valid');
  const base = {
    candidateName: application.candidate?.fullName || '',
    jobTitle: application.job?.title || '',
  };
  const activeHold = await InterviewHold.findOne({ applicationId, active: true }).lean();
  if (activeHold) return { ...base, state: 'pending', hold: holdView(activeHold), slots: [] };

  const approved = await InterviewHold.findOne({ applicationId, status: 'approved' }).sort({ updatedAt: -1 }).lean();
  const scheduledMeeting = await Meeting.exists({
    applicationId,
    status: 'scheduled',
    ...(approved ? {} : { scheduledAt: { $gte: new Date() } }),
  });
  if (approved || scheduledMeeting) return { ...base, state: 'scheduled', hold: holdView(approved), slots: [] };

  if (application.status === 'Rejected' || application.verificationCallStatus === 'withdrawn') {
    return { ...base, state: 'closed', slots: [] };
  }
  return { ...base, state: 'open', slots: null };
}

const tokenToApplicationId = (token) => {
  try {
    return String(verifyBookingToken(token));
  } catch {
    // 410, not 401: the frontend api client treats 401 as an expired login and refreshes/logs out.
    throw new ApiError(httpStatus.GONE, 'Booking link is invalid or has expired');
  }
};

/** GET /v1/public/interview-booking/:token?tz= */
export const getBooking = catchAsync(async (req, res) => {
  const applicationId = tokenToApplicationId(req.params.token);
  const state = await loadState(applicationId);
  if (state.state === 'open') {
    const tz = safeTz(req.query.tz);
    const slots = await getFreeSlots({ applicationId, limit: 12, ...(tz ? { tz } : {}) });
    state.slots = slots.map((s) => ({
      slot_id: encodeSlotId({ applicationId, start: s.start }),
      start: s.start,
      end: s.end,
    }));
  }
  res.status(httpStatus.OK).send(state);
});

/** POST /v1/public/interview-booking/:token { slot_id, tz } */
export const createBooking = catchAsync(async (req, res) => {
  const applicationId = tokenToApplicationId(req.params.token);
  const slotId = String(req.body?.slot_id || '');
  const tz = safeTz(req.body?.tz);
  const start = decodeSlotId(slotId, applicationId);
  if (!start) throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid slot');
  const { hold, existing } = await createHold({ applicationId, start, source: 'link', candidateTimezone: tz });
  res.status(existing ? httpStatus.OK : httpStatus.CREATED).send({ state: 'pending', existing: !!existing, hold: holdView(hold) });
});
