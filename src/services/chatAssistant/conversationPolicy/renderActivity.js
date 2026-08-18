/**
 * Natural prose for person-scoped activity queries (applications, existence checks).
 */

/**
 * @param {object[]} records
 * @returns {string[]}
 */
function jobTitlesFromRecords(records = []) {
  return records
    .map((r) => r?.job?.title || r?.jobTitle || null)
    .filter(Boolean);
}

/**
 * @param {{ name: string, total: number, records?: object[], operation?: 'count'|'list'|'existence', statusFilter?: 'Applied'|'Hired'|null }} input
 */
export function renderJobApplicationsReply({ name, total, records = [], operation = 'count', statusFilter = null }) {
  const label = name || 'that person';

  if (statusFilter === 'Applied' && operation === 'count') {
    if (total <= 0) {
      return `**${label}** has no applications currently in Applied status.`;
    }
    const verb = total === 1 ? 'is' : 'are';
    const noun = total === 1 ? 'application' : 'applications';
    return `**${total}** ${noun} for **${label}** ${verb} currently in Applied status.`;
  }

  if (statusFilter === 'Hired') {
    const titles = jobTitlesFromRecords(records);
    if (total <= 0) {
      return `**${label}** has not been hired for any jobs.`;
    }
    if (titles.length === 1) {
      return `**${label}** was hired for **${titles[0]}**.`;
    }
    if (titles.length > 1) {
      const listed = titles.map((t) => `**${t}**`).join(', ');
      return `**${label}** was hired for ${titles.length} jobs: ${listed}.`;
    }
    return `**${label}** has been hired for **${total}** job${total === 1 ? '' : 's'}.`;
  }

  if (total <= 0) {
    if (operation === 'existence') {
      return `No — **${label}** has not applied to any jobs.`;
    }
    return `**${label}** has not applied to any jobs.`;
  }

  if (operation === 'list') {
    const titles = jobTitlesFromRecords(records);
    if (titles.length === 1) {
      return `**${label}** has applied to **${titles[0]}**.`;
    }
    if (titles.length > 1) {
      const listed = titles.map((t) => `**${t}**`).join(', ');
      return `**${label}** has applied to ${titles.length} jobs: ${listed}.`;
    }
    return `**${label}** has applied to **${total}** job${total === 1 ? '' : 's'}.`;
  }

  if (operation === 'existence') {
    return `Yes — **${label}** has applied to ${total === 1 ? '**1** job' : `**${total}** jobs`}.`;
  }

  if (total === 1) {
    const jobTitle = records[0]?.job?.title || records[0]?.jobTitle || null;
    if (jobTitle) {
      return `**${label}** has applied to **1** job (${jobTitle}).`;
    }
    return `**${label}** has applied to **1** job.`;
  }

  return `**${label}** has applied to **${total}** jobs.`;
}

/**
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 * @param {{ name?: string|null, employeeId?: string|null }} [subject]
 */
export function renderEmployeeExistenceReply(profile, subject = {}) {
  if (profile?.kind === 'unique') {
    const name = profile.identity.name;
    const employee = profile.profiles?.employee;
    const empId = employee?.fields?.employeeId || subject.employeeId || null;
    const status = String(employee?.fields?.employmentStatus || 'active').toLowerCase();
    const statusLabel = status === 'resigned' ? 'resigned' : 'currently working';
    const idClause = empId ? ` is employee **${empId}**` : '';
    return `I do have them. **${name}**${idClause} and is ${statusLabel}.`;
  }

  if (subject?.name && subject?.employeeId) {
    return `I do have them. **${subject.name}** is employee **${subject.employeeId}**.`;
  }

  if (subject?.name) {
    return `I don't have **${subject.name}** in the employee directory.`;
  }

  return "I couldn't find that person in the directory.";
}

/**
 * @param {string} name
 */
export function renderInterviewsUnavailable(name) {
  const label = name || 'that person';
  return `I can see **${label}** in the directory, but person-scoped interview lookup isn't wired yet — ask about a specific job's interview schedule instead.`;
}
