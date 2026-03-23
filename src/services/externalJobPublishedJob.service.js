import Job from '../models/job.model.js';
import ExternalJob from '../models/externalJob.model.js';
import logger from '../config/logger.js';

const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Freelance'];
const EXP_LEVELS = ['Entry Level', 'Mid Level', 'Senior Level', 'Executive'];

function mapJobType(raw) {
  if (!raw || typeof raw !== 'string') return 'Full-time';
  const s = raw.toLowerCase();
  if (s.includes('part')) return 'Part-time';
  if (s.includes('contract')) return 'Contract';
  if (s.includes('temp')) return 'Temporary';
  if (s.includes('intern')) return 'Internship';
  if (s.includes('freelance') || s.includes('free lance')) return 'Freelance';
  if (s.includes('full')) return 'Full-time';
  return 'Full-time';
}

function mapExperienceLevel(raw) {
  if (!raw || typeof raw !== 'string') return 'Mid Level';
  const s = raw.toLowerCase();
  if (s.includes('intern') || s.includes('entry') || s.includes('junior') || s.includes('graduate')) {
    return 'Entry Level';
  }
  if (s.includes('executive') || s.includes('director') || s.includes('vp') || s.includes('head of') || s.includes('c-level')) {
    return 'Executive';
  }
  if (s.includes('senior') || s.includes('lead') || s.includes('principal') || s.includes('staff')) {
    return 'Senior Level';
  }
  if (s.includes('mid') || s.includes('medium') || s.includes('intermediate')) {
    return 'Mid Level';
  }
  return 'Mid Level';
}

/**
 * Pure mapping: ExternalJob lean doc -> Job update fields (for external-origin jobs).
 */
export function buildJobPayloadFromExternal(ext) {
  const company = (ext.company && String(ext.company).trim()) || 'External listing';
  const description = (ext.description && String(ext.description).trim()) || '';
  const jobDescription =
    description || 'Details are available on the original listing. Apply here to be tracked in Dharwin.';
  let location = (ext.location && String(ext.location).trim()) || '';
  if (!location) {
    location = ext.isRemote ? 'Remote' : 'Location not specified';
  }
  const jobType = JOB_TYPES.includes(ext.jobType) ? ext.jobType : mapJobType(ext.jobType);
  const experienceLevel = EXP_LEVELS.includes(ext.experienceLevel)
    ? ext.experienceLevel
    : mapExperienceLevel(ext.experienceLevel);

  let salaryRange;
  const minOk = ext.salaryMin != null && !Number.isNaN(Number(ext.salaryMin));
  const maxOk = ext.salaryMax != null && !Number.isNaN(Number(ext.salaryMax));
  if (minOk || maxOk) {
    salaryRange = {};
    if (minOk) salaryRange.min = Number(ext.salaryMin);
    if (maxOk) salaryRange.max = Number(ext.salaryMax);
    salaryRange.currency = ext.salaryCurrency ? String(ext.salaryCurrency).trim() || 'USD' : 'USD';
  }

  return {
    title: (ext.title && String(ext.title).trim()) || 'External job',
    organisation: { name: company },
    jobDescription,
    jobType,
    location,
    experienceLevel,
    skillTags: [],
    ...(salaryRange ? { salaryRange } : {}),
    status: 'Active',
    jobOrigin: 'external',
    externalRef: {
      externalId: String(ext.externalId).trim(),
      source: String(ext.source).trim(),
    },
    externalPlatformUrl: ext.platformUrl ? String(ext.platformUrl).trim() : '',
    createdBy: ext.savedBy,
  };
}

async function findMirroredJobByRef(externalId, source) {
  return Job.findOne({
    jobOrigin: 'external',
    'externalRef.externalId': externalId,
    'externalRef.source': source,
  }).exec();
}

/**
 * Upsert Job for a saved ExternalJob; updates ExternalJob.publishedJobId.
 */
export async function syncPublishedJobForExternal(extDoc) {
  const externalId = String(extDoc.externalId).trim();
  const source = String(extDoc.source).trim();
  const payload = buildJobPayloadFromExternal({ ...extDoc.toObject?.() || extDoc, externalId, source });

  let job = null;

  if (extDoc.publishedJobId) {
    job = await Job.findById(extDoc.publishedJobId).exec();
    if (!job) {
      await ExternalJob.updateOne({ _id: extDoc._id }, { $unset: { publishedJobId: 1 } }).exec();
    }
  }

  if (!job) {
    job = await findMirroredJobByRef(externalId, source);
  }

  if (job) {
    job.set({
      title: payload.title,
      organisation: payload.organisation,
      jobDescription: payload.jobDescription,
      jobType: payload.jobType,
      location: payload.location,
      experienceLevel: payload.experienceLevel,
      skillTags: payload.skillTags,
      salaryRange: payload.salaryRange,
      status: 'Active',
      jobOrigin: 'external',
      externalRef: payload.externalRef,
      externalPlatformUrl: payload.externalPlatformUrl,
    });
    await job.save();
  } else {
    try {
      job = await Job.create(payload);
    } catch (err) {
      if (err && err.code === 11000) {
        job = await findMirroredJobByRef(externalId, source);
        if (job) {
          job.set({
            title: payload.title,
            organisation: payload.organisation,
            jobDescription: payload.jobDescription,
            jobType: payload.jobType,
            location: payload.location,
            experienceLevel: payload.experienceLevel,
            skillTags: payload.skillTags,
            salaryRange: payload.salaryRange,
            status: 'Active',
            jobOrigin: 'external',
            externalRef: payload.externalRef,
            externalPlatformUrl: payload.externalPlatformUrl,
          });
          await job.save();
        } else {
          logger.error(`Duplicate external job key but no row found for ${externalId} ${source}`);
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  if (!job?._id) {
    throw new Error('syncPublishedJobForExternal: failed to resolve Job');
  }

  await ExternalJob.updateOne({ _id: extDoc._id }, { $set: { publishedJobId: job._id } }).exec();

  return job;
}

/**
 * After removing one ExternalJob: archive mirrored Job if no rows left for (externalId, source).
 */
export async function archivePublishedJobIfOrphaned(externalId, source) {
  const remaining = await ExternalJob.countDocuments({ externalId, source }).exec();
  if (remaining > 0) return;

  const job = await findMirroredJobByRef(externalId, source);
  if (job) {
    await Job.updateOne({ _id: job._id }, { $set: { status: 'Archived' } }).exec();
  }
}
