/**
 * Epic G — Org chart / structure analytics helpers.
 *
 * Source of truth: `orgStructure.service.js` (same APIs the Org Chart UI calls —
 * `/org-structure/coverage`, `/org-structure/tree`, `/org-structure/search`,
 * `/org-structure` unit list). Never answer "how many managers / supervisors /
 * Group A / unassigned" from Employee `role=Manager` filters.
 *
 * ## Authoritative org model (matches Org Chart UI)
 *
 * **Positions** (`ceo` | `manager` | `supervisor`): structure nodes that hold a
 * single **head** (`headEmployeeId` → `headEmployee`). The UI draws one card per
 * position; the card title is the position name and the head name is shown on it.
 * "How many managers" = count of active OrgUnit rows with `type === 'manager'`
 * (manager **positions**), NOT User.role=Manager and NOT a count of people who
 * happen to have a Manager role. Listing managers includes each position’s
 * assigned head name when present.
 *
 * **Departments** (`department`): last-level named units linked to a canonical
 * `departmentId`. Multiple employees work in a department via
 * `Employee.departmentId` → attached as `node.employees` / `memberCount` by
 * `buildTreeFromData` in orgTree.pure.js.
 *
 * **Unassigned:** an active employee whose `departmentId` does not match any
 * ACTIVE org-unit of type `department`. Surfaced by `getOrgCoverageSummary` as
 * `unassignedEmployees` — never recomputed from raw Employee counts.
 */

/** Permissions the org-structure HTTP routes require to read the chart/tree/units. */
export const ORG_READ_PERMISSIONS = Object.freeze(['chart.read', 'structure.read', 'structure.manage']);

/** OrgUnit.type values that are positions (single head), not multi-employee departments. */
export const POSITION_TYPES = Object.freeze(['ceo', 'manager', 'supervisor']);

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

const idStr = (v) => (v == null ? null : String(v));

const headNameOf = (u) =>
  u?.headEmployee?.fullName ||
  u?.headEmployee?.name ||
  u?.headName ||
  '';

/**
 * Count active org units by OrgUnit.type.
 * For ceo/manager/supervisor this is the count of **positions** (one Org Chart
 * card each). For department this is the count of department units.
 * @param {Array<{ type?: string, isActive?: boolean }>} units
 * @returns {{ ceo: number, manager: number, supervisor: number, department: number, total: number }}
 */
export function countOrgUnitsByType(units = []) {
  const counts = { ceo: 0, manager: 0, supervisor: 0, department: 0, total: 0 };
  for (const u of units || []) {
    if (u?.isActive === false) continue;
    const t = u?.type;
    if (t && Object.prototype.hasOwnProperty.call(counts, t)) {
      counts[t] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/**
 * List active position units of a given type with assigned head names.
 * Matches Org Chart cards: one record per position, head shown when assigned.
 * @param {Array} units - from listOrgUnits (includes headEmployee when populated)
 * @param {'ceo'|'manager'|'supervisor'} type
 * @returns {Array<{ id: string|null, name: string, type: string, kind: 'position', headEmployeeId: string|null, headName: string, hasHead: boolean }>}
 */
export function listPositionRecords(units = [], type) {
  const t = String(type || '').toLowerCase();
  if (!POSITION_TYPES.includes(t)) return [];
  return (units || [])
    .filter((u) => u?.isActive !== false && u?.type === t)
    .map((u) => {
      const headEmployeeId = idStr(u.headEmployeeId || u.headEmployee?.id || null);
      const headName = headNameOf(u);
      return {
        id: idStr(u.id || u._id),
        name: u.name || '',
        type: t,
        kind: 'position',
        headEmployeeId,
        headName,
        hasHead: Boolean(headEmployeeId || headName),
      };
    });
}

/**
 * List active department units. When a tree is provided, attach employee
 * membership counts (and sample names) from the chart nodes.
 * @param {Array} units
 * @param {{ roots?: Array }|null} [tree]
 * @returns {Array}
 */
export function listDepartmentRecords(units = [], tree = null) {
  const byId = new Map();
  if (tree) {
    for (const n of findNodesInTree(tree.roots || (Array.isArray(tree) ? tree : []), () => true)) {
      if (n?.type === 'department') byId.set(idStr(n.id), n);
    }
  }
  return (units || [])
    .filter((u) => u?.isActive !== false && u?.type === 'department')
    .map((u) => {
      const id = idStr(u.id || u._id);
      const node = id ? byId.get(id) : null;
      const employees = Array.isArray(node?.employees) ? node.employees : [];
      const memberCount =
        node != null
          ? Number(node.memberCount ?? employees.length ?? 0)
          : null;
      return {
        id,
        name: u.name || '',
        type: 'department',
        kind: 'department',
        departmentId: idStr(u.departmentId),
        memberCount,
        employeeCount: memberCount,
        employees: employees.map((e) => ({
          id: idStr(e.id),
          fullName: e.fullName || '',
          designation: e.designation || '',
        })),
      };
    });
}

/**
 * Case-insensitive unit name lookup. Exact matches win over partial includes.
 * @param {Array<{ name?: string, isActive?: boolean }>} units
 * @param {string} nameQuery
 * @returns {Array}
 */
export function findOrgUnitsByName(units = [], nameQuery = '') {
  const q = String(nameQuery || '').trim().toLowerCase();
  if (!q) return [];
  const active = (units || []).filter((u) => u?.isActive !== false);
  const exact = active.filter((u) => String(u.name || '').toLowerCase() === q);
  if (exact.length) return exact;
  return active.filter((u) => String(u.name || '').toLowerCase().includes(q));
}

/**
 * Depth-first walk of a buildTreeFromData / buildTree forest.
 * @param {Array} roots
 * @param {(node: object) => boolean} predicate
 * @returns {Array}
 */
export function findNodesInTree(roots, predicate) {
  const hits = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (predicate(n)) hits.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return hits;
}

/**
 * Find tree nodes whose name matches `nameQuery` (exact first, then includes).
 * @param {{ roots?: Array }|Array} treeOrRoots
 * @param {string} nameQuery
 * @returns {Array}
 */
export function findTreeNodesByName(treeOrRoots, nameQuery = '') {
  const roots = Array.isArray(treeOrRoots) ? treeOrRoots : treeOrRoots?.roots || [];
  const q = String(nameQuery || '').trim().toLowerCase();
  if (!q) return [];
  const exact = findNodesInTree(roots, (n) => String(n.name || '').toLowerCase() === q);
  if (exact.length) return exact;
  return findNodesInTree(roots, (n) => String(n.name || '').toLowerCase().includes(q));
}

/**
 * Summarize a matched org-chart node for chatbot facts.
 * - Department → kind=department, list employees / memberCount
 * - Position (ceo/manager/supervisor) → kind=position, head + child reports
 * @param {object} node
 * @returns {object}
 */
export function summarizeOrgUnitNode(node) {
  if (!node) return null;
  const children = Array.isArray(node.children) ? node.children : [];
  const employees = Array.isArray(node.employees) ? node.employees : [];
  const type = node.type || '';
  const kind = POSITION_TYPES.includes(type) ? 'position' : type === 'department' ? 'department' : type || 'unit';
  const childSummary = (c) => ({
    id: idStr(c.id),
    name: c.name || '',
    type: c.type || '',
    kind: POSITION_TYPES.includes(c.type) ? 'position' : c.type === 'department' ? 'department' : c.type || 'unit',
    memberCount: Number(c.memberCount || 0),
    headName: headNameOf(c),
  });
  const childUnits = children.map(childSummary);
  return {
    id: idStr(node.id),
    name: node.name || '',
    type,
    kind,
    headName: headNameOf(node),
    headEmployeeId: idStr(node.headEmployeeId || node.headEmployee?.id || null),
    hasHead: Boolean(node.headEmployeeId || headNameOf(node)),
    memberCount: Number(node.memberCount || 0),
    employeeCount: employees.length,
    employees: employees.map((e) => ({
      id: idStr(e.id),
      fullName: e.fullName || '',
      designation: e.designation || '',
    })),
    childUnits,
    /** Direct reports / child org units under a position (or children of any node). */
    reports: childUnits,
    childDepartments: children.filter((c) => c.type === 'department').map(childSummary),
    childSupervisors: children.filter((c) => c.type === 'supervisor').map(childSummary),
    childManagers: children.filter((c) => c.type === 'manager').map(childSummary),
  };
}

/**
 * Format a `getOrgCoverageSummary` result (+ optional units/tree) into chatbot
 * AUTHORITATIVE facts. Pure — no DB access.
 *
 * @param {object} summary - result of orgStructure.service.js getOrgCoverageSummary
 * @param {Array} [units] - active OrgUnit rows (from listOrgUnits / loadUnitsPlain)
 * @param {{ roots?: Array }|null} [tree] - optional chart tree for department membership
 * @returns {object}
 */
export function formatOrgCoverageFacts(summary = {}, units, tree = null) {
  const checklist = summary?.checklist || {};
  const unitCounts = countOrgUnitsByType(units || []);
  // When units were not passed, fall back to boolean presence from checklist only.
  const managers =
    units != null ? unitCounts.manager : checklist.hasManagers === true ? null : 0;
  const supervisors =
    units != null ? unitCounts.supervisor : checklist.hasSupervisors === true ? null : 0;
  const departments =
    units != null ? unitCounts.department : checklist.hasDepartmentNodes === true ? null : 0;
  const ceoCount = units != null ? unitCounts.ceo : checklist.hasCeo === true ? null : 0;

  const unassigned = Number(summary?.unassignedEmployees || 0);
  const total = Number(summary?.totalActiveEmployees || 0);

  const managerPositions = units != null ? listPositionRecords(units, 'manager') : [];
  const supervisorPositions = units != null ? listPositionRecords(units, 'supervisor') : [];
  const ceoPositions = units != null ? listPositionRecords(units, 'ceo') : [];
  const departmentRecords = units != null ? listDepartmentRecords(units, tree) : [];

  return {
    departments: {
      count: departments,
      hasDepartmentNodes: checklist.hasDepartmentNodes === true,
      departmentsWithoutNode: Number(summary?.departmentsWithoutNode || 0),
      departmentNodesWithoutEmployees: Number(summary?.departmentNodesWithoutEmployees || 0),
      allDepartmentsLinked: checklist.allDepartmentsLinked === true,
      definition:
        'Active OrgUnit nodes with type="department" — last-level named units. ' +
        'Each has a name and multiple employees (Employee.departmentId → memberCount). ' +
        'Not a position; positions use a single head instead.',
      records: departmentRecords,
    },
    supervisors: {
      count: supervisors,
      hasSupervisors: checklist.hasSupervisors === true,
      definition:
        'Count of active supervisor **positions** (OrgUnit.type="supervisor") — one Org Chart ' +
        'card per position. Each may have an assigned head (headEmployee). NOT a User role filter.',
      positions: supervisorPositions,
      records: supervisorPositions,
    },
    managers: {
      count: managers,
      hasManagers: checklist.hasManagers === true,
      definition:
        'Count of active manager **positions** (OrgUnit.type="manager") — one Org Chart card ' +
        'per position (AUTHORITATIVE for "how many managers"). Each may have an assigned head ' +
        '(headEmployee / headName). NOT User role=Manager. Listing managers = these positions ' +
        'with their head names when assigned.',
      positions: managerPositions,
      records: managerPositions,
    },
    employees: {
      total,
      assigned: Number(summary?.assignedEmployees || 0),
      unassigned,
      unassignedDefinition:
        'Active employees whose departmentId does not match any active org-unit of type ' +
        '"department" (buildTreeFromData in orgTree.pure.js). Sourced from ' +
        'getOrgCoverageSummary.unassignedEmployees — never recomputed independently.',
    },
    leadership: {
      hasCeo: checklist.hasCeo === true,
      ceoCount,
      hasManagers: checklist.hasManagers === true,
      hasSupervisors: checklist.hasSupervisors === true,
      unitsMissingHead: Number(summary?.unitsMissingHead || 0),
      allLeadershipHeadsAssigned: checklist.allLeadershipHeadsAssigned === true,
      ceoPositions,
      definition:
        'CEO/manager/supervisor are positions with optional heads; departments are multi-employee units.',
    },
    unitCounts,
    overSpanUnits: Number(summary?.overSpanUnits || 0),
    openSlots: Number(summary?.openSlots || 0),
    authoritative: true,
    source:
      'orgStructure.service.js getOrgCoverageSummary + OrgUnit position/department counts ' +
      '(positions = type ceo|manager|supervisor with headEmployee; departments = type department with employees)',
  };
}

/**
 * Pick the AUTHORITATIVE_COUNT for a metric / unit lookup result.
 * @param {object} facts - formatOrgCoverageFacts result
 * @param {{ metric?: string, lookup?: object|null }} [opts]
 * @returns {{ count: number, label: string }}
 */
export function resolveOrgAuthoritativeCount(facts = {}, opts = {}) {
  const metric = String(opts.metric || 'coverage').toLowerCase();
  const lookup = opts.lookup;

  if (lookup) {
    if (lookup.notFound) {
      return { count: 0, label: `org unit "${lookup.query || ''}" not found` };
    }
    const nodes = lookup.matches || [];
    if (nodes.length === 1) {
      const n = nodes[0];
      if (n.kind === 'department' || n.type === 'department') {
        return {
          count: n.employeeCount ?? n.memberCount ?? 0,
          label: `employees in department ${n.name}`,
        };
      }
      if (n.type === 'supervisor') {
        return {
          count: n.childDepartments?.length ?? n.reports?.length ?? 0,
          label: `departments reporting to supervisor position ${n.name}` +
            (n.headName ? ` (head: ${n.headName})` : ''),
        };
      }
      if (n.type === 'manager') {
        return {
          count: n.childSupervisors?.length ?? n.reports?.length ?? 0,
          label: `supervisors reporting to manager position ${n.name}` +
            (n.headName ? ` (head: ${n.headName})` : ''),
        };
      }
      if (n.type === 'ceo') {
        return {
          count: n.childManagers?.length ?? n.reports?.length ?? 0,
          label: `managers reporting to CEO position ${n.name}` +
            (n.headName ? ` (head: ${n.headName})` : ''),
        };
      }
      return { count: n.childUnits?.length ?? 0, label: `child units under ${n.name}` };
    }
    return { count: nodes.length, label: `matching org units for "${lookup.query}"` };
  }

  if (metric === 'managers' || metric === 'manager') {
    return {
      count: Number(facts.managers?.count ?? 0),
      label:
        'manager positions (OrgUnit.type=manager; one Org Chart card per position — not User role)',
    };
  }
  if (metric === 'supervisors' || metric === 'supervisor') {
    return {
      count: Number(facts.supervisors?.count ?? 0),
      label:
        'supervisor positions (OrgUnit.type=supervisor; one Org Chart card per position — not User role)',
    };
  }
  if (metric === 'departments' || metric === 'department') {
    return {
      count: Number(facts.departments?.count ?? 0),
      label: 'department units (OrgUnit.type=department; multi-employee last-level nodes)',
    };
  }
  if (metric === 'unassigned') {
    return {
      count: Number(facts.employees?.unassigned ?? 0),
      label: 'unassigned employees (no matching department org-unit)',
    };
  }
  // coverage / default — prefer unassigned when that was the common ask; else total employees
  return {
    count: Number(facts.employees?.total ?? 0),
    label: 'active employees on org coverage summary',
  };
}

/**
 * Build a unit-lookup payload from a tree + name query.
 * @param {{ roots?: Array }|null} tree
 * @param {string} unitName
 * @returns {{ query: string, notFound?: boolean, matches: Array, matchCount: number }}
 */
export function lookupOrgUnitFromTree(tree, unitName) {
  const query = String(unitName || '').trim();
  if (!query) {
    return { query: '', notFound: true, matches: [], matchCount: 0 };
  }
  const nodes = findTreeNodesByName(tree, query);
  if (!nodes.length) {
    return { query, notFound: true, matches: [], matchCount: 0 };
  }
  return {
    query,
    notFound: false,
    matchCount: nodes.length,
    matches: nodes.map(summarizeOrgUnitNode),
  };
}

/** Detect org-chart / structure asks that must NOT use fetch_employees role filters. */
export function looksLikeOrgStructureQuery(text) {
  if (!text) return false;
  const t = String(text);
  // Explicit org chart / structure / coverage language
  if (
    /\b(org(anisation|anization)?\s*chart|org(anisation|anization)?\s*structure|structure\s+coverage|chart\s+coverage)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(unassigned(\s+employees?)?|employees?\s+unassigned)\b/i.test(t)) return true;
  // Manager / supervisor headcount in org sense
  if (/\b(how many|count|number of|list|show|who (are|is)|total)\b.{0,40}\bmanagers?\b/i.test(t)) {
    return true;
  }
  if (/\b(how many|count|number of|list|show|who (are|is)|total)\b.{0,40}\bsupervisors?\b/i.test(t)) {
    return true;
  }
  if (/\bmanagers?\b.{0,40}\b(org|chart|structure|how many|count)\b/i.test(t)) return true;
  if (/\bsupervisors?\b/i.test(t)) return true;
  // Named group / department on the chart (e.g. "Group A in org chart", "Group A")
  if (/\bgroup\s+[a-z0-9][\w\s-]{0,40}\b/i.test(t) && !/\b(candidate|student)\s+groups?\b/i.test(t)) {
    return true;
  }
  if (/\b(department|departments)\b.{0,40}\b(under|below|reporting|org|chart|structure|supervisor|manager)\b/i.test(t)) {
    return true;
  }
  if (/\b(employees?|people|staff)\b.{0,40}\b(under|in)\b.{0,40}\b(group|department|supervisor|manager)\b/i.test(t)) {
    return true;
  }
  if (/\bdepartments?\s+(without|missing)\s+(a\s+)?(node|chart)\b/i.test(t)) return true;
  if (/\bdo we have a supervisor\b/i.test(t)) return true;
  return false;
}

/**
 * Block fetch_employees when the ask is clearly org-structure.
 * @returns {{ block: true, reason: string, preferModules: string[] } | null}
 */
export function guardFetchEmployeesOrgRoute(text) {
  if (!text || !looksLikeOrgStructureQuery(text)) return null;
  return {
    block: true,
    reason:
      'Org chart / manager / supervisor / group / unassigned questions must use org_structure_analytics ' +
      '(manager/supervisor **positions** + heads, department units + employees via getOrgCoverageSummary) — ' +
      'never fetch_employees role=Manager.',
    preferModules: ['org_structure_analytics'],
  };
}

/**
 * Infer metric + optional unitName from a natural-language org ask.
 * @param {string} text
 * @returns {{ metric: string, unitName?: string, phrase: string }}
 */
export function extractOrgStructureArgs(text) {
  const phrase = String(text || '');
  const t = phrase.toLowerCase();
  const out = { metric: 'coverage', phrase };

  // Named unit: "Group A", "group a in org chart", "employees in Sales"
  const groupMatch = phrase.match(/\bgroup\s+([a-z0-9][\w-]*)\b/i);
  if (groupMatch) {
    const token = groupMatch[1];
    const normalized =
      token.length === 1
        ? token.toUpperCase()
        : token.charAt(0).toUpperCase() + token.slice(1);
    out.unitName = `Group ${normalized}`;
    out.metric = 'unit_lookup';
    return out;
  }
  const inUnit = phrase.match(
    /\b(?:in|under|for|about)\s+(?:the\s+)?([A-Za-z][\w\s-]{1,40}?)\s+(?:department|team|group|org\s*unit)\b/i
  );
  if (inUnit) {
    out.unitName = inUnit[1].trim();
    out.metric = 'unit_lookup';
    return out;
  }
  const namedDept = phrase.match(/\b([A-Za-z][\w\s-]{1,40}?)\s+department\b/i);
  if (namedDept && !/\b(how many|all|which|missing|without)\s+departments?\b/i.test(t)) {
    const name = namedDept[1].trim();
    if (!/^(the|a|an|every|each|our|my)$/i.test(name)) {
      out.unitName = name;
      out.metric = 'unit_lookup';
      return out;
    }
  }

  if (/\bunassigned\b/i.test(t)) out.metric = 'unassigned';
  else if (/\bmanagers?\b/i.test(t)) out.metric = 'managers';
  else if (/\bsupervisors?\b/i.test(t)) out.metric = 'supervisors';
  else if (/\bdepartments?\b/i.test(t)) out.metric = 'departments';
  else out.metric = 'coverage';

  return out;
}

/**
 * Merge coverage facts + optional unit lookup into the tool payload.
 * @param {object} opts
 * @param {object} opts.summary
 * @param {Array} [opts.units]
 * @param {{ roots?: Array }|null} [opts.tree]
 * @param {{ metric?: string, unitName?: string }} [opts.args]
 */
export function buildOrgStructureAnalyticsPayload({ summary, units, tree, args = {} } = {}) {
  const metric = String(args.metric || 'coverage').toLowerCase();
  const unitName = args.unitName || args.query || null;
  const facts = formatOrgCoverageFacts(summary, units, tree);

  let lookup = null;
  if (unitName || metric === 'unit_lookup') {
    lookup = lookupOrgUnitFromTree(tree, unitName || '');
  }

  const auth = resolveOrgAuthoritativeCount(facts, { metric, lookup });
  return {
    ...facts,
    metric: unitName ? 'unit_lookup' : metric,
    lookup,
    authoritativeCount: auth.count,
    authoritativeLabel: auth.label,
    authoritative: true,
  };
}
