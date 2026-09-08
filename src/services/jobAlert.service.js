import JobAlertSubscription from '../models/jobAlertSubscription.model.js';
import User from '../models/user.model.js';
import logger from '../config/logger.js';

const emptyCriteria = () => ({
  jobTypes: [],
  location: '',
  experienceLevel: '',
  jobOrigin: '',
  search: '',
});

function normalizeCriteria(criteria = {}) {
  return {
    jobTypes: criteria.jobTypes ?? [],
    location: criteria.location ?? '',
    experienceLevel: criteria.experienceLevel ?? '',
    jobOrigin: criteria.jobOrigin ?? '',
    search: criteria.search ?? '',
  };
}

function normalizeCriteriaPatch(criteria) {
  return {
    jobTypes: Array.isArray(criteria.jobTypes) ? criteria.jobTypes : [],
    location: criteria.location?.trim() ?? '',
    experienceLevel: criteria.experienceLevel ?? '',
    jobOrigin: criteria.jobOrigin ?? '',
    search: criteria.search?.trim() ?? '',
  };
}

function normalizeChannels(channels = {}) {
  return {
    email: channels.email !== false,
    inApp: channels.inApp !== false,
  };
}

function serializeJobAlert(doc) {
  return {
    enabled: !!doc.enabled,
    criteria: normalizeCriteria(doc.criteria),
    channels: normalizeChannels(doc.channels),
  };
}

/**
 * Minimal matcher: when a job is published (status Active), notify subscribers whose
 * saved criteria match (OR on jobTypes; other fields are optional exact/contains filters).
 * Cron-based batch matching for stale subscriptions is intentionally deferred.
 */
export async function getJobAlertForUser(userId) {
  const uid = String(userId);
  const doc = await JobAlertSubscription.findOne({ user: uid }).lean();
  if (!doc) {
    return {
      enabled: false,
      criteria: emptyCriteria(),
      channels: { email: true, inApp: true },
    };
  }
  return serializeJobAlert(doc);
}

export async function updateJobAlertForUser(userId, body = {}) {
  const uid = String(userId);
  const patch = {};
  if (body.enabled != null) patch.enabled = !!body.enabled;
  if (body.criteria) {
    patch.criteria = normalizeCriteriaPatch(body.criteria);
  }
  if (body.channels) {
    patch.channels = normalizeChannels(body.channels);
  }

  await JobAlertSubscription.findOneAndUpdate(
    { user: uid },
    { $set: patch, $setOnInsert: { user: uid } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Mirror enabled state into notification prefs so the settings UI stays consistent.
  if (body.enabled != null) {
    await User.updateOne(
      { _id: uid },
      {
        $set: {
          'notificationPreferences.jobAlerts': !!body.enabled,
          'notificationPreferences.jobAlertsInApp': !!body.enabled,
        },
      }
    );
  }

  return getJobAlertForUser(uid);
}

function jobMatchesCriteria(job, criteria) {
  if (!criteria) return true;
  const types = criteria.jobTypes ?? [];
  if (types.length && !types.includes(job.jobType)) return false;
  const loc = (criteria.location ?? '').trim();
  if (loc && !(job.location || '').toLowerCase().includes(loc.toLowerCase())) return false;
  const exp = criteria.experienceLevel ?? '';
  if (exp && job.experienceLevel !== exp) return false;
  const origin = criteria.jobOrigin ?? '';
  if (origin === 'internal' && job.jobOrigin === 'external') return false;
  if (origin === 'external' && job.jobOrigin !== 'external') return false;
  const search = (criteria.search ?? '').trim().toLowerCase();
  if (search) {
    const hay = [job.title, job.organisation?.name, job.location, job.jobDescription]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(search)) return false;
  }
  return true;
}

export async function notifyJobAlertSubscribersForJob(job) {
  if (!job || job.status !== 'Active') return;
  const jobId = String(job._id ?? job.id ?? '');
  if (!jobId) return;

  const subs = await JobAlertSubscription.find({ enabled: true }).select('user criteria channels').lean();
  if (!subs.length) return;

  const { notify, notifyByEmail, plainTextEmailBody } = await import('./notification.service.js');
  const link = `/ats/browse-jobs/${jobId}`;
  const title = 'New job matching your alerts';
  const message = `"${job.title}" at ${job.organisation?.name || 'an organisation'} may match your saved filters.`;

  for (const sub of subs) {
    if (!jobMatchesCriteria(job, sub.criteria)) continue;
    try {
      const user = await User.findById(sub.user).select('email notificationPreferences').lean();
      if (!user) continue;

      const wantsInApp = sub.channels?.inApp !== false;
      const wantsEmail = sub.channels?.email !== false;

      // notifyByEmail also creates in-app when allowed — never call both paths.
      if (wantsEmail && user.email) {
        await notifyByEmail(user.email, {
          type: 'job_alert',
          title,
          message,
          link,
          email: {
            subject: title,
            text: plainTextEmailBody(message, link),
          },
        });
      } else if (wantsInApp) {
        await notify(sub.user, {
          type: 'job_alert',
          title,
          message,
          link,
        });
      }
    } catch (err) {
      logger.warn(`job alert notify failed for user ${sub.user}: ${err?.message || err}`);
    }
  }
}
