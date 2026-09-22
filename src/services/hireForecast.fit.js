const LEVEL_RANK = Object.freeze({
  Beginner: 1,
  Intermediate: 2,
  Advanced: 3,
  Expert: 4,
});

/**
 * Resolve structured skill requirements, falling back to skillTags as required skills.
 * @param {{ skillRequirements?: Array<{ name?: string, level?: string, required?: boolean }>, skillTags?: string[] }} job
 * @returns {Array<{ name: string, level?: string, required: boolean }>}
 */
export function resolveJobRequirements(job) {
  const structured = Array.isArray(job?.skillRequirements) ? job.skillRequirements : [];
  if (structured.length > 0) {
    return structured.map((req) => ({
      name: String(req?.name || ''),
      level: req?.level,
      required: req?.required !== false,
    }));
  }
  return (job?.skillTags || []).map((tag) => ({ name: String(tag || ''), required: true }));
}

/**
 * Score employee skills against a job's requirements (same rules as getJobFit).
 * @param {Array<{ name?: string, level?: string }>} employeeSkills
 * @param {{ skillRequirements?: Array, skillTags?: string[] }} job
 * @returns {{ fitScore: number, fitLabel: string, matchedSkills: object[], missingSkills: object[] }}
 */
export function scoreSkillFit(employeeSkills, job) {
  const requirements = resolveJobRequirements(job);
  if (requirements.length === 0) {
    return { matchedSkills: [], missingSkills: [], fitScore: 100, fitLabel: 'No requirements' };
  }

  const employeeSkillMap = new Map(
    (employeeSkills || []).map((skill) => [String(skill.name || '').toLowerCase(), skill])
  );

  const matchedSkills = [];
  const missingSkills = [];

  for (const req of requirements) {
    const emp = employeeSkillMap.get(req.name.toLowerCase());
    if (emp) {
      const meetsLevel = !req.level || (LEVEL_RANK[emp.level] || 0) >= (LEVEL_RANK[req.level] || 0);
      matchedSkills.push({
        name: req.name,
        required: req.required,
        employeeLevel: emp.level,
        requiredLevel: req.level || null,
        meetsLevel,
      });
    } else {
      missingSkills.push({
        name: req.name,
        required: req.required,
        requiredLevel: req.level || null,
      });
    }
  }

  const requiredTotal = requirements.filter((req) => req.required).length;
  const requiredMatched = matchedSkills.filter((skill) => skill.required && skill.meetsLevel).length;
  const fitScore = requiredTotal > 0 ? Math.round((requiredMatched / requiredTotal) * 100) : 100;

  let fitLabel = 'Poor fit';
  if (fitScore >= 80) fitLabel = 'Strong fit';
  else if (fitScore >= 60) fitLabel = 'Good fit';
  else if (fitScore >= 40) fitLabel = 'Partial fit';

  return { matchedSkills, missingSkills, fitScore, fitLabel };
}
