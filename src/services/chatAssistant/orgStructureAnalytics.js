/**
 * Epic G — Org chart / structure analytics helpers.
 *
 * Wraps the shape of `orgStructure.service.js` `getOrgCoverageSummary` into
 * chatbot-friendly AUTHORITATIVE buckets: departments, supervisors, employees
 * assigned vs unassigned. Never re-derives these numbers independently — always
 * call `getOrgCoverageSummary` (or pass its already-computed result in) and format
 * it here, so the chatbot answer can never disagree with the Org Chart page.
 *
 * **Unassigned definition (locked to the Org Chart UI):** an active employee is
 * "unassigned" when their `departmentId` does not match any ACTIVE org-unit of
 * type `department`. This is exactly what `buildTreeFromData` computes in
 * `orgTree.pure.js` (see lines ~15-23: a `department`-type unit is indexed by its
 * `departmentId`; every active employee whose `departmentId` has no matching node
 * falls into `unassigned`). `getOrgCoverageSummary` surfaces this count directly as
 * `unassignedEmployees` — do not recompute it from raw Employee counts, which would
 * silently drift from the tree's definition (e.g. by ignoring inactive org units).
 */

/** Permissions the org-structure HTTP routes require to read the chart/tree/units. */
export const ORG_READ_PERMISSIONS = Object.freeze(['chart.read', 'structure.read', 'structure.manage']);

/**
 * True when the permission Set grants access to at least one of ORG_READ_PERMISSIONS
 * (mirrors requireAnyOfPermissions('chart.read', 'structure.read', 'structure.manage')
 * used by orgStructure.route.js `canReadTree`).
 * @param {Set<string>|null|undefined} permissions
 * @returns {boolean}
 */
export function hasOrgReadAccess(permissions) {
  if (!permissions || typeof permissions.has !== 'function') return false;
  return ORG_READ_PERMISSIONS.some((p) => permissions.has(p));
}

/**
 * Format a `getOrgCoverageSummary` result into chatbot-friendly AUTHORITATIVE facts.
 * Pure function — no DB access.
 *
 * @param {object} summary - result of orgStructure.service.js getOrgCoverageSummary
 * @returns {{
 *   departments: { hasDepartmentNodes: boolean, departmentsWithoutNode: number, departmentNodesWithoutEmployees: number },
 *   supervisors: { hasSupervisors: boolean },
 *   employees: { total: number, assigned: number, unassigned: number, unassignedDefinition: string },
 *   leadership: { hasCeo: boolean, hasManagers: boolean, unitsMissingHead: number },
 *   overSpanUnits: number,
 *   openSlots: number,
 * }}
 */
export function formatOrgCoverageFacts(summary = {}) {
  const checklist = summary?.checklist || {};

  return {
    departments: {
      hasDepartmentNodes: checklist.hasDepartmentNodes === true,
      departmentsWithoutNode: Number(summary?.departmentsWithoutNode || 0),
      departmentNodesWithoutEmployees: Number(summary?.departmentNodesWithoutEmployees || 0),
      allDepartmentsLinked: checklist.allDepartmentsLinked === true,
    },
    supervisors: {
      hasSupervisors: checklist.hasSupervisors === true,
    },
    employees: {
      total: Number(summary?.totalActiveEmployees || 0),
      assigned: Number(summary?.assignedEmployees || 0),
      unassigned: Number(summary?.unassignedEmployees || 0),
      unassignedDefinition:
        'Active employees whose departmentId does not match any active org-unit of type ' +
        '"department" (buildTreeFromData in orgTree.pure.js). Sourced from ' +
        'getOrgCoverageSummary.unassignedEmployees — never recomputed independently.',
    },
    leadership: {
      hasCeo: checklist.hasCeo === true,
      hasManagers: checklist.hasManagers === true,
      unitsMissingHead: Number(summary?.unitsMissingHead || 0),
      allLeadershipHeadsAssigned: checklist.allLeadershipHeadsAssigned === true,
    },
    overSpanUnits: Number(summary?.overSpanUnits || 0),
    openSlots: Number(summary?.openSlots || 0),
    authoritative: true,
    source: 'orgStructure.service.js getOrgCoverageSummary',
  };
}
