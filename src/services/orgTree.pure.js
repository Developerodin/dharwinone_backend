const idStr = (v) => (v == null ? null : String(v));

/**
 * Assemble a forest from plain unit/employee arrays. No DB, no mongoose.
 * @param {Array} units - { id, type, parentId, departmentId?, headEmployeeId?, isActive, order, name, directToCeo }
 * @param {Array} employees - { id, fullName, email?, designation?, departmentId, isActive }
 * @returns {{ roots: Array, unassigned: Array }}
 */
export const buildTreeFromData = (units, employees) => {
  const activeUnits = (units || []).filter((u) => u.isActive !== false);
  const activeEmployees = (employees || []).filter((e) => e.isActive !== false);

  const byId = new Map(activeUnits.map((u) => [idStr(u.id), { ...u, id: idStr(u.id), children: [], employees: [], memberCount: 0 }]));

  const deptNodeByDeptId = new Map();
  for (const node of byId.values()) {
    if (node.type === 'department' && node.departmentId != null) deptNodeByDeptId.set(idStr(node.departmentId), node);
  }
  const unassigned = [];
  for (const e of activeEmployees) {
    const node = e.departmentId != null ? deptNodeByDeptId.get(idStr(e.departmentId)) : null;
    if (node) { node.employees.push(e); node.memberCount += 1; } else { unassigned.push(e); }
  }

  const roots = [];
  for (const node of byId.values()) {
    const parentKey = idStr(node.parentId);
    if (parentKey && byId.has(parentKey)) {
      byId.get(parentKey).children.push(node);
    } else {
      if (parentKey && !byId.has(parentKey)) node.orphaned = true;
      roots.push(node);
    }
  }

  const sortRec = (list) => {
    list.sort((a, b) => (a.order - b.order) || String(a.name).localeCompare(String(b.name)));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);

  return { roots, unassigned };
};

/** True if setting nodeId.parent = newParentId would create a cycle (self or descendant). */
export const wouldCreateCycle = (units, nodeId, newParentId) => {
  const node = idStr(nodeId);
  const target = idStr(newParentId);
  if (target == null) return false;
  if (target === node) return true;
  const parentOf = new Map((units || []).map((u) => [idStr(u.id), idStr(u.parentId)]));
  let cur = target;
  const seen = new Set();
  while (cur != null) {
    if (cur === node) return true;
    if (seen.has(cur)) break;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
};

/** True if any active unit has parentId === unitId. */
export const hasActiveChildren = (units, unitId) =>
  (units || []).some((u) => u.isActive !== false && idStr(u.parentId) === idStr(unitId));

/** True if any active employee has departmentId === departmentId. */
export const departmentHasAssignedEmployees = (employees, departmentId) =>
  (employees || []).some((e) => e.isActive !== false && idStr(e.departmentId) === idStr(departmentId));
