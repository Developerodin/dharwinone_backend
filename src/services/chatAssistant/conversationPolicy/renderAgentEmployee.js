/**
 * Deterministic reply templates for Agent ↔ Employee assignment queries.
 */

export function renderEmployeeAgentLookup({ employeeName, agentName, agentEmail = null }) {
  const who = employeeName ? `**${employeeName}**` : 'That employee';
  if (!agentName) {
    return `${who} has no assigned agent.`;
  }
  const contact = agentEmail ? ` (${agentEmail})` : '';
  return `${who}'s assigned agent is **${agentName}**${contact}.`;
}

export function renderAgentEmployeeCount({
  agentName,
  total,
  filters = {},
  breakdown = null,
  accountStatusScope = null,
}) {
  const scope = describeAgentScope(filters, accountStatusScope);
  const noun = total === 1 ? 'employee' : 'employees';
  const verb = total === 1 ? 'is' : 'are';

  if (accountStatusScope) {
    return `There ${verb} **${total}** ${scope}${noun} assigned to **${agentName}**.`;
  }

  const working = Number(breakdown?.active ?? 0);
  const resigned = Number(breakdown?.resigned ?? 0);
  const hasMixedEmployment =
    breakdown &&
    filters.employmentStatus !== 'current' &&
    filters.employmentStatus !== 'resigned' &&
    resigned > 0 &&
    working > 0;

  if (hasMixedEmployment) {
    const workingNoun = working === 1 ? 'employee' : 'employees';
    const workingVerb = working === 1 ? 'is' : 'are';
    const otherParts = [`**${resigned}** resigned`];
    const totalAll = Number(breakdown.total ?? total ?? working + resigned);
    return (
      `There ${workingVerb} **${working}** currently working ${workingNoun} assigned to **${agentName}**, ` +
      `plus ${otherParts.join(' and ')} (**${totalAll}** total). ` +
      `Do you want the full count across all employment statuses, or just currently working?`
    );
  }

  return `There ${verb} **${total}** ${scope}${noun} assigned to **${agentName}**.`;
}

export function renderMultiAgentEmployeeCount({ parts, filters = {} }) {
  const scope = describeAgentScope(filters);
  if (!parts?.length) return 'No agent assignment counts found.';
  if (parts.length === 2) {
    const [a, b] = parts;
    const nounA = a.total === 1 ? 'employee' : 'employees';
    const nounB = b.total === 1 ? 'employee' : 'employees';
    const verbA = a.total === 1 ? 'is' : 'are';
    const verbB = b.total === 1 ? 'is' : 'are';
    return `There ${verbA} **${a.total}** ${scope}${nounA} assigned to **${a.name}**, and there ${verbB} **${b.total}** ${scope}${nounB} assigned to **${b.name}**.`;
  }
  const lines = parts.map((part) => {
    const noun = part.total === 1 ? 'employee' : 'employees';
    const verb = part.total === 1 ? 'is' : 'are';
    return `- **${part.name}**: there ${verb} **${part.total}** ${scope}${noun}`;
  });
  return `Assigned employee counts:\n${lines.join('\n')}`;
}

export function renderUnassignedCount({ total, filters = {} }) {
  const scope = describeAgentScope(filters);
  const noun = total === 1 ? 'employee' : 'employees';
  const verb = total === 1 ? 'is' : 'are';
  return `There ${verb} **${total}** ${scope}${noun} without an assigned agent.`;
}

export function renderAgentRanking({ agents }) {
  if (!agents?.length) return 'No agents with employee assignments found.';
  const top = agents[0];
  const noun = top.assignedCount === 1 ? 'employee' : 'employees';
  if (agents.length === 1) {
    return `**${top.name}** has the most assigned ${noun} (**${top.assignedCount}**).`;
  }
  const lines = agents.slice(0, 5).map(
    (a, i) => `${i + 1}. **${a.name}** — ${a.assignedCount}`
  );
  return `Top agents by assigned employees:\n${lines.join('\n')}`;
}

export function renderAgentsWithNoEmployees({ agents }) {
  if (!agents?.length) return 'Every agent has at least one employee assigned.';
  const names = agents.map((a) => `**${a.name}**`).join(', ');
  const verb = agents.length === 1 ? 'has' : 'have';
  return `${names} ${verb} no employees assigned.`;
}

function describeAgentScope(filters = {}, accountStatusScope = null) {
  const parts = [];
  if (accountStatusScope === 'pending') parts.push('pending');
  else if (accountStatusScope === 'disabled') parts.push('disabled');
  else if (accountStatusScope === 'deleted') parts.push('deleted');
  if (filters.employmentStatus === 'current') parts.push('currently working');
  else if (filters.employmentStatus === 'resigned') parts.push('resigned');
  if (filters.compensationType === 'unpaid') parts.push('unpaid');
  else if (filters.compensationType === 'paid') parts.push('paid');
  if (filters.designation) parts.push(`in **${filters.designation}** position`);
  if (!parts.length) return '';
  return `${parts.join(' ')} `;
}
