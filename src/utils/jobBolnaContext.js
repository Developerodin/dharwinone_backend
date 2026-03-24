import { numberToWords, currencyToWords } from './numberToWords.js';

/** Shared job → Bolna initiateCall context (recruiter / job-post verification). */
export function bolnaJobContextFromDoc(job) {
  if (!job) return {};
  const orgName = job.organisation?.name || job.organisation || '';
  let salaryRange = '';
  if (job.salaryRange) {
    const { min, max, currency } = job.salaryRange;
    const curr = currencyToWords(currency);
    if (min != null && max != null) salaryRange = `${numberToWords(min)} to ${numberToWords(max)} ${curr}`;
    else if (min != null) salaryRange = `From ${numberToWords(min)} ${curr}`;
    else if (max != null) salaryRange = `Up to ${numberToWords(max)} ${curr}`;
  }
  return {
    jobTitle: job.title,
    organisation: orgName,
    jobType: job.jobType,
    location: job.location,
    experienceLevel: job.experienceLevel,
    salaryRange: salaryRange || undefined,
  };
}
