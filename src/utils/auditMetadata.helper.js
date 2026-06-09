/**
 * Thin helpers for Phase 1A organization audit metadata.
 * Builds allowlisted ID-only before/after fields and detects no-op updates.
 * Does not persist logs or inspect permissions.
 */

/** @param {unknown} v */
export const idStr = (v) => {
  if (v == null || v === '') return null;
  return String(v);
};

/**
 * @param {Record<string, unknown>} body
 * @param {string[]} allowedFields
 */
export const pickFieldsUpdated = (body, allowedFields) =>
  allowedFields.filter(
    (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined
  );

/**
 * @param {Record<string, unknown>} metadata
 * @param {string} fieldBase e.g. parentId -> parentIdBefore/After
 * @param {unknown} beforeVal
 * @param {unknown} afterVal
 */
export const assignIdBeforeAfter = (metadata, fieldBase, beforeVal, afterVal) => {
  const b = idStr(beforeVal);
  const a = idStr(afterVal);
  if (b === a) return metadata;
  metadata[`${fieldBase}Before`] = b;
  metadata[`${fieldBase}After`] = a;
  return metadata;
};

/**
 * @param {Record<string, unknown>|null|undefined} before
 * @param {Record<string, unknown>|null|undefined} after
 * @param {Record<string, unknown>} body
 * @param {string[]} allowedFields
 * @param {string[]} idFields fields that emit Before/After id metadata
 * @returns {Record<string, unknown>|null}
 */
export const buildUpdateAuditMetadata = (before, after, body, allowedFields, idFields = []) => {
  const fieldsUpdated = pickFieldsUpdated(body, allowedFields);
  if (!fieldsUpdated.length) return null;

  const metadata = { fieldsUpdated: [...fieldsUpdated] };
  let changed = false;

  for (const field of idFields) {
    if (!fieldsUpdated.includes(field)) continue;
    const b = before?.[field];
    const a = after?.[field];
    if (idStr(b) !== idStr(a)) {
      assignIdBeforeAfter(metadata, field, b, a);
      changed = true;
    }
  }

  for (const field of fieldsUpdated) {
    if (idFields.includes(field)) continue;
    const b = before?.[field];
    const a = after?.[field];
    if (JSON.stringify(b) !== JSON.stringify(a)) changed = true;
  }

  return changed ? metadata : null;
};

/**
 * @template T
 * @param {T} result
 * @param {{ action: string, entityType: string, entityId: string, metadata?: Record<string, unknown>, occurredAt?: Date|string|null, skipReason?: string }|null} audit
 * @returns {{ result: T, audit: typeof audit }}
 */
export const buildAuditEnvelope = (result, audit) => ({ result, audit });

/**
 * @param {unknown} doc mongoose doc or plain object
 */
export const snapshotOrgUnit = (doc) => {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    parentId: o.parentId,
    headEmployeeId: o.headEmployeeId,
    departmentId: o.departmentId,
    type: o.type,
    directToCeo: o.directToCeo,
    order: o.order,
    isActive: o.isActive,
    name: o.name,
  };
};

/**
 * @param {unknown} doc
 */
export const snapshotDepartment = (doc) => {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    name: o.name,
    code: o.code,
    isActive: o.isActive,
  };
};

/**
 * Count descendant org units (excluding the root).
 * @param {Array<{ id: string, parentId?: string|null }>} units
 * @param {string} rootId
 */
export const countDescendantUnits = (units, rootId) => {
  const byParent = new Map();
  for (const u of units || []) {
    const p = u.parentId != null ? String(u.parentId) : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(String(u.id));
  }
  let count = 0;
  const stack = [...(byParent.get(String(rootId)) || [])];
  while (stack.length) {
    const id = stack.pop();
    count += 1;
    const kids = byParent.get(id) || [];
    stack.push(...kids);
  }
  return count;
};

/**
 * Build audit envelope for employee/candidate update (department assign vs generic update).
 * @param {{ departmentId?: unknown }} beforeCandidate
 * @param {{ departmentId?: unknown, _id?: unknown, id?: unknown }} afterCandidate
 * @param {Record<string, unknown>} body
 * @param {string} entityId
 * @param {{ EMPLOYEE_DEPARTMENT_ASSIGN: string, CANDIDATE_UPDATE: string, EMPLOYEE: string, CANDIDATE: string }} actions
 */
export const buildEmployeeUpdateAuditEnvelope = (beforeCandidate, afterCandidate, body, entityId, actions) => {
  const departmentIdBefore =
    beforeCandidate?.departmentId != null ? String(beforeCandidate.departmentId) : null;
  const departmentIdAfter =
    afterCandidate?.departmentId != null ? String(afterCandidate.departmentId) : null;
  const departmentChanged =
    Object.prototype.hasOwnProperty.call(body, 'departmentId') &&
    departmentIdBefore !== departmentIdAfter;

  if (departmentChanged) {
    return {
      audit: {
        action: actions.EMPLOYEE_DEPARTMENT_ASSIGN,
        entityType: actions.EMPLOYEE,
        entityId: String(entityId),
        metadata: {
          departmentIdBefore,
          departmentIdAfter,
        },
        occurredAt: new Date(),
      },
    };
  }

  const fieldsUpdated = Object.keys(body).filter(
    (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined
  );
  return {
    audit: fieldsUpdated.length
      ? {
          action: actions.CANDIDATE_UPDATE,
          entityType: actions.CANDIDATE,
          entityId: String(entityId),
          metadata: { fieldsUpdated },
          occurredAt: new Date(),
        }
      : null,
  };
};
