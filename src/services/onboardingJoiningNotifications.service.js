import Placement from '../models/placement.model.js';
import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';
import { notify, notifyByEmail, plainTextEmailBody } from './notification.service.js';

const dayStartUtc = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

const daysBetweenUtc = (a, b) => Math.round((dayStartUtc(a) - dayStartUtc(b)) / (24 * 60 * 60 * 1000));

const formatJoiningLine = (d) => {
  if (!d) return 'TBD';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return 'TBD';
  return x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * After HR finalizes joining date on a placement (PATCH), notify candidate + assigned Agent Training agent together.
 * Candidate respects suppressCandidateNotifications; agent receives whenever assignedAgent exists (skipped otherwise).
 *
 * @param {string} placementId
 */
export async function sendJoiningDateFinalizedEmails(placementId) {
  const pl = await Placement.findById(placementId).populate('job', 'title').lean();
  if (!pl?.joiningDate) return;

  const emp = await Employee.findById(pl.candidate).populate({ path: 'assignedAgent', select: 'email name' }).lean();
  if (!emp) return;

  const jd = formatJoiningLine(pl.joiningDate);
  const jobTitle =
    typeof pl.job === 'object' && pl.job?.title ? pl.job.title : '';
  const name = emp.fullName || emp.email || 'Candidate';

  const tasks = [];

  const linkCandidate = '/ats/my-profile';
  const linkAgent = '/ats/onboarding';
  const subj = `Joining date set — ${jd}`;
  const baseMsgCandidate = `Your joining date is confirmed as ${jd}${jobTitle ? ` (${jobTitle})` : ''}.`;
  const baseMsgAgent = `${name}'s joining date is confirmed as ${jd}${jobTitle ? ` for ${jobTitle}` : ''}. On their joining date, confirm their Employee role transition if needed (Settings → Users / onboarding).`;

  if (!pl.suppressCandidateNotifications && emp.email) {
    tasks.push(
      notifyByEmail(emp.email, {
        type: 'placement',
        title: 'Joining date confirmed',
        message: baseMsgCandidate,
        link: linkCandidate,
        email: {
          subject: subj,
          text: plainTextEmailBody(baseMsgCandidate, linkCandidate),
        },
      }).catch((e) => logger.warn(`finalized joining notify candidate: ${e.message}`))
    );
  }

  const agentRef = emp.assignedAgent;
  let agentId = null;
  if (typeof agentRef === 'object' && agentRef !== null) agentId = agentRef._id ?? agentRef.id;
  else if (agentRef) agentId = agentRef;

  if (agentId) {
    const agentUser = await User.findById(agentId).select('email').lean();
    if (agentUser?.email) {
      tasks.push(
        notify(agentId, {
          type: 'placement',
          title: 'Joining date confirmed',
          message: baseMsgAgent,
          link: linkAgent,
          email: {
            subject: subj,
            text: plainTextEmailBody(baseMsgAgent, linkAgent),
          },
        }).catch((e) => logger.warn(`finalized joining notify agent: ${e.message}`))
      );
    }
  }

  await Promise.all(tasks);
}

/**
 * For **Joined** placements (onboarding list): T-1 and T-0 reminders to candidate + assigned Agent simultaneously.
 * Uses onboardingJoinRemindersSentAt on Placement for dedupe. Respect suppressCandidateNotifications for candidate only.
 *
 * @returns {Promise<{ t1: number, t0: number }>}
 */
export async function runJoinedOnboardingJoiningReminders() {
  if (!config.ats?.joiningRemindersEnabled) {
    return { t1: 0, t0: 0 };
  }

  const now = new Date();
  const today = dayStartUtc(now);

  const joined = await Placement.find({
    status: 'Joined',
    joiningDate: { $exists: true, $ne: null },
  })
    .populate('job', 'title')
    .select('candidate job joiningDate suppressCandidateNotifications onboardingJoinRemindersSentAt')
    .limit(3000)
    .lean();

  let t1n = 0;
  let t0n = 0;

  // Batch-load all candidate Employee docs in one query instead of one per placement.
  const candidateIds = [...new Set(joined.map((p) => String(p.candidate)).filter(Boolean))];
  const candidateDocs = candidateIds.length
    ? await Employee.find({ _id: { $in: candidateIds } })
        .populate({ path: 'assignedAgent', select: 'email name' })
        .lean()
    : [];
  const candidateMap = new Map(candidateDocs.map((e) => [String(e._id), e]));

  for (const pl of joined) {
    const jd = pl.joiningDate ? new Date(pl.joiningDate) : null;
    if (!jd || Number.isNaN(jd.getTime())) continue;

    const d = daysBetweenUtc(jd, today);

    const sent = pl.onboardingJoinRemindersSentAt || {};
    const rm = candidateMap.get(String(pl.candidate));
    if (!rm) continue;

    const name = rm.fullName || rm.email || 'Candidate';
    const jobTitle =
      typeof pl.job === 'object' && pl.job !== null ? pl.job.title || '' : '';

    const agentId =
      rm.assignedAgent && typeof rm.assignedAgent === 'object'
        ? rm.assignedAgent._id ?? rm.assignedAgent.id
        : rm.assignedAgent || null;

    const sendPair = async ({ kind, template }) => {
      const subj =
        kind === 't1'
          ? `Reminder: joining tomorrow (${formatJoiningLine(jd)})`
          : `Reminder: joining today (${formatJoiningLine(jd)})`;

      const candMsg =
        kind === 't1'
          ? `Reminder: your joining date is tomorrow (${formatJoiningLine(jd)})${jobTitle ? ` — ${jobTitle}` : ''}.`
          : `Reminder: today is your joining date (${formatJoiningLine(jd)})${jobTitle ? ` — ${jobTitle}` : ''}.`;

      const agMsg =
        kind === 't1'
          ? `${name} joins tomorrow (${formatJoiningLine(jd)})${jobTitle ? ` — ${jobTitle}` : ''}. Prepare handoff; verify Employee role transition if automation did not run.`
          : `${name}'s joining date is today (${formatJoiningLine(jd)})${jobTitle ? ` — ${jobTitle}` : ''}. Complete role transition to Employee if needed.`;

      const linkC = '/ats/my-profile';
      const linkA = '/ats/onboarding';

      const promises = [];

      if (!pl.suppressCandidateNotifications && rm.email) {
        promises.push(
          notifyByEmail(rm.email, {
            type: 'placement',
            title: kind === 't1' ? 'Joining tomorrow' : 'Joining today',
            message: candMsg,
            link: linkC,
            email: {
              subject: subj,
              text: plainTextEmailBody(candMsg, linkC),
            },
          }).catch(() => {})
        );
      }

      if (agentId) {
        promises.push(
          notify(agentId, {
            type: 'placement',
            title: kind === 't1' ? 'Joining tomorrow' : 'Joining today',
            message: agMsg,
            link: linkA,
            email: {
              subject: subj,
              text: plainTextEmailBody(agMsg, linkA),
            },
          }).catch(() => {})
        );
      }

      await Promise.all(promises);
      await Placement.updateOne({ _id: pl._id }, { $set: { [`onboardingJoinRemindersSentAt.${template}`]: new Date() } });
    };

    try {
      if (d === 1 && !sent.t1) {
        await sendPair({ kind: 't1', template: 't1' });
        t1n += 1;
      } else if (d === 0 && !sent.t0) {
        await sendPair({ kind: 't0', template: 't0' });
        t0n += 1;
      }
    } catch (e) {
      logger.warn(`[joinedOnboardingReminders] placement ${pl._id}: ${e.message}`);
    }
  }

  if (t1n || t0n) logger.info(`[joinedOnboardingReminders] t1=${t1n} t0=${t0n}`);
  return { t1: t1n, t0: t0n };
}
