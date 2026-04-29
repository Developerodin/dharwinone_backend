import Placement from '../models/placement.model.js';
import Offer from '../models/offer.model.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import Meeting from '../models/meeting.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';

const dayStartUtc = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

const daysBetweenUtc = (a, b) => Math.round((dayStartUtc(a) - dayStartUtc(b)) / (24 * 60 * 60 * 1000));

/**
 * T-7 recruiter + T-1 agent/candidate emails for pending placements.
 * @returns {Promise<{ t7: number, t1: number }>}
 */
export const runJoiningDateReminders = async () => {
  if (!config.ats?.joiningRemindersEnabled) {
    return { t7: 0, t1: 0 };
  }
  const now = new Date();
  const today = dayStartUtc(now);

  const pending = await Placement.find({
    status: 'Pending',
    joiningDate: { $exists: true, $ne: null },
  })
    .select('offer job candidate joiningDate reminderSentAt suppressCandidateNotifications')
    .lean()
    .limit(2000);

  const { notifyByEmail, notify, plainTextEmailBody } = await import('./notification.service.js');

  let t7n = 0;
  let t1n = 0;

  for (const pl of pending) {
    const jd = pl.joiningDate ? new Date(pl.joiningDate) : null;
    if (!jd) continue;
    const d = daysBetweenUtc(jd, today);

    if (d === 7 && !pl.reminderSentAt?.t7) {
      // eslint-disable-next-line no-await-in-loop
      const offer = await Offer.findById(pl.offer).select('createdBy job').lean();
      if (offer?.createdBy) {
        const msg = 'Joining date is in 7 days for a pending placement.';
        const path = '/ats/pre-boarding';
        // eslint-disable-next-line no-await-in-loop
        notify(offer.createdBy, {
          type: 'placement',
          title: 'Upcoming join date (7 days)',
          message: msg,
          link: path,
          email: { subject: 'Placement: joining in 7 days', text: plainTextEmailBody(msg, path) },
        }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await Placement.updateOne({ _id: pl._id }, { $set: { 'reminderSentAt.t7': new Date() } });
        t7n += 1;
      }
    }

    if (d === 1) {
      const r = pl.reminderSentAt || {};
      if (!r.t1Recruiter) {
        // eslint-disable-next-line no-await-in-loop
        const offer = await Offer.findById(pl.offer).select('createdBy').lean();
        if (offer?.createdBy) {
          const msg = 'A pending hire joins tomorrow.';
          const path = '/ats/pre-boarding';
          // eslint-disable-next-line no-await-in-loop
          notify(offer.createdBy, {
            type: 'placement',
            title: 'Joining tomorrow',
            message: msg,
            link: path,
            email: { subject: 'Placement: joining tomorrow', text: plainTextEmailBody(msg, path) },
          }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await Placement.updateOne({ _id: pl._id }, { $set: { 'reminderSentAt.t1Recruiter': new Date() } });
          t1n += 1;
        }
      }

      if (!pl.suppressCandidateNotifications && !r.t1Candidate) {
        // eslint-disable-next-line no-await-in-loop
        const emp = await Employee.findById(pl.candidate).select('email fullName').lean();
        if (emp?.email) {
          const cmsg = 'Reminder: your joining date is tomorrow.';
          // eslint-disable-next-line no-await-in-loop
          notifyByEmail(emp.email, {
            type: 'placement',
            title: 'Joining tomorrow',
            message: cmsg,
            link: '/ats/my-profile',
            email: { subject: 'Your joining date', text: cmsg },
          }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await Placement.updateOne({ _id: pl._id }, { $set: { 'reminderSentAt.t1Candidate': new Date() } });
        }
      }

      const t1Map = { ...(r.t1ByAgent && typeof r.t1ByAgent === 'object' ? r.t1ByAgent : {}) };
      // eslint-disable-next-line no-await-in-loop
      const emp2 = await Employee.findById(pl.candidate).select('owner').lean();
      if (emp2?.owner) {
        const ownerId = String(emp2.owner);
        // eslint-disable-next-line no-await-in-loop
        const meetings = await Meeting.find({ 'candidate.id': ownerId }).select('hosts').lean();
        const agentEmails = new Set();
        meetings.forEach((m) => (m.hosts || []).forEach((h) => h.email && agentEmails.add(h.email.trim().toLowerCase())));
        for (const em of agentEmails) {
          // eslint-disable-next-line no-await-in-loop
          const u = await User.findOne({ email: em }).select('_id email').lean();
          if (!u?._id) continue;
          const uid = String(u._id);
          if (t1Map[uid]) continue;
          // eslint-disable-next-line no-await-in-loop
          notify(u._id, {
            type: 'placement',
            title: 'Joining tomorrow',
            message: 'A candidate you hosted interviews for has their joining date tomorrow.',
            link: '/ats/pre-boarding',
          }).catch(() => {});
          t1Map[uid] = new Date().toISOString();
        }
        // eslint-disable-next-line no-await-in-loop
        await Placement.updateOne({ _id: pl._id }, { $set: { 'reminderSentAt.t1ByAgent': t1Map } });
      }
    }
  }

  if (t7n || t1n) logger.info(`[placementReminders] t7=${t7n} t1-pings=${t1n}`);
  return { t7: t7n, t1: t1n };
};
