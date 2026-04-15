/** Slugs that gate which assigned tasks let a Candidate see a project in the list/detail. */
export const CANDIDATE_PROJECT_TASK_TYPE_SLUGS = [
  'feature-engineer',
  'feasibility-reviewer',
  'orchestrating-swarms',
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mongo $or branches: each slug matches taskCode, tags, or requiredSkills (whole string, case-insensitive).
 */
export function buildSpecialistTaskSlugOrConditions() {
  return CANDIDATE_PROJECT_TASK_TYPE_SLUGS.flatMap((slug) => {
    const rx = new RegExp(`^${escapeRegex(slug)}$`, 'i');
    return [{ taskCode: rx }, { tags: rx }, { requiredSkills: rx }];
  });
}
