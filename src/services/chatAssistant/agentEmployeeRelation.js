/**
 * Canonical Agent ↔ Employee assignment field map.
 * Agents are Users with the Agent role; assignment lives on the Employee document.
 */
export const AGENT_EMPLOYEE_RELATION = Object.freeze({
  /** Mongo path on Employee (collection: candidates). */
  employeeAssignedAgentField: 'assignedAgent',
  /** StructuredQuery / REST list filter — resolved to assignedAgent $in. */
  employeeFilterAgentIdsKey: 'agentIds',
  /** Name-based REST filter — regex match on Agent-role User name/email. */
  employeeFilterAgentNameKey: 'agent',
  /** Role registry name for staff agents (not Bolna voice agents). */
  agentUserRoleName: 'Agent',
});

/** StructuredQuery filter base for one agent's roster. */
export function agentEmployeeFilterBase(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return {};
  return { agentIds: [id] };
}
