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
    color: o.color,
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
/**
 * What changed about an employee's compensation, or `null` if nothing did.
 *
 * Provenance counts as a change. The previous audit condition fired only when the VALUE moved,
 * and additionally required an admin actor and a locked record — so a bulk form save that
 * restamped `compensationSource` to 'manual' left no trail at all. In production that mislabelled
 * every accepted unpaid-internship hire and left a real revert with nothing to follow.
 *
 * @returns {{before: string|null, after: string|null, sourceBefore: string|null, sourceAfter: string|null}|null}
 */
export const describeCompensationChange = (before, after) => {
  const typeBefore = before?.compensationType ?? null;
  const typeAfter = after?.compensationType ?? null;
  const sourceBefore = before?.compensationSource ?? null;
  const sourceAfter = after?.compensationSource ?? null;
  if (typeBefore === typeAfter && sourceBefore === sourceAfter) return null;
  return { before: typeBefore, after: typeAfter, sourceBefore, sourceAfter };
};

/** Never recorded, changed or not. */
const NEVER_LOGGED = new Set(['password', 'confirmPassword']);

/**
 * Named add/remove diff for bulky arrays where filenames carry the signal without inlining blobs.
 */
const LOGGED_AS_NAMED_ARRAY_DIFF = new Set(['documents', 'salarySlips']);

/**
 * Recorded as `[changed]` instead of by value: base64 payloads, signed URLs and long arrays that
 * would bury the signal and bloat every audit row.
 */
const LOGGED_AS_CHANGED_ONLY = new Set([
  'profilePicture',
  'qualifications',
  'experiences',
  'skills',
  'socialLinks',
]);

/** Treat null, undefined, and "" as equivalent empty values. */
const normalizeEmpty = (v) => (v == null || v === '' ? null : v);

/**
 * @param {unknown} item
 * @returns {string}
 */
const documentDisplayName = (item) => {
  if (!item || typeof item !== 'object') return '(unknown)';
  const o = /** @type {Record<string, unknown>} */ (item);
  const name = o.originalName ?? o.name ?? o.fileName;
  if (name != null && name !== '') return String(name);
  const url = o.url ?? o.documentUrl ?? o.key;
  if (url != null && url !== '') return String(url);
  return '(unknown)';
};

/**
 * Stable identity for a document-like row: id/key first, then name, then url, else index.
 *
 * @param {unknown} item
 * @param {number} index
 * @param {string} [fieldKey]
 */
const documentEntryKey = (item, index, fieldKey = 'documents') => {
  if (!item || typeof item !== 'object') return `__idx_${index}`;
  const o = /** @type {Record<string, unknown>} */ (item);
  const id = o._id ?? o.id ?? o.key;
  if (id != null && id !== '') return String(id);
  const name = o.originalName ?? o.name ?? o.fileName;
  if (name != null && name !== '') return String(name);
  const url = o.url ?? o.documentUrl;
  if (url != null && url !== '') return String(url);
  if (fieldKey === 'salarySlips') {
    const month = o.month != null && o.month !== '' ? String(o.month) : '';
    const year = o.year != null && o.year !== '' ? String(o.year) : '';
    if (month || year) return `slip:${year}-${month}:${index}`;
  }
  return `__idx_${index}`;
};

/**
 * @param {unknown} beforeArr
 * @param {unknown} afterArr
 * @param {string} fieldKey
 * @returns {{ added: string[], removed: string[] }|null}
 */
const buildNamedArrayDiff = (beforeArr, afterArr, fieldKey) => {
  const before = Array.isArray(beforeArr) ? beforeArr : [];
  const after = Array.isArray(afterArr) ? afterArr : [];
  const beforeByKey = new Map();
  before.forEach((item, index) => {
    beforeByKey.set(documentEntryKey(item, index, fieldKey), documentDisplayName(item));
  });
  const afterByKey = new Map();
  after.forEach((item, index) => {
    afterByKey.set(documentEntryKey(item, index, fieldKey), documentDisplayName(item));
  });

  const removed = [];
  for (const [key, name] of beforeByKey) {
    if (!afterByKey.has(key)) removed.push(name);
  }
  const added = [];
  for (const [key, name] of afterByKey) {
    if (!beforeByKey.has(key)) added.push(name);
  }

  if (!added.length && !removed.length) return null;
  return { added, removed };
};

/**
 * Compare by value: ObjectIds and Dates are never === each other and would otherwise report a
 * change on every save.
 *
 * ObjectId-like values have a meaningful `toString`; plain objects and arrays do not — they all
 * stringify to "[object Object]", which would make every array look unchanged. Those fall back to
 * a structural comparison.
 */
const comparable = (v) => {
  const normalized = normalizeEmpty(v);
  if (normalized === null) return null;
  if (normalized instanceof Date) return normalized.toISOString();
  if (typeof normalized === 'object') {
    const asString = String(normalized);
    return asString === '[object Object]' ? JSON.stringify(normalized) : asString;
  }
  return normalized;
};

/**
 * Old and new value of every field this request actually moved.
 *
 * The employee audit previously recorded only which field NAMES were in the payload, so the log
 * could say `compensationType` was submitted but not that it went unpaid → paid. That gap is why a
 * real reversion had nothing to follow. Actor and timestamp come from the activity log itself.
 *
 * Only fields present in `body` are considered — the record may differ for reasons this request had
 * nothing to do with.
 *
 * @returns {Object|null} `{ field: { from, to } }`, or null when nothing moved
 */
export const buildFieldChangeLog = (before, after, body) => {
  const changes = {};
  for (const key of Object.keys(body || {})) {
    if (NEVER_LOGGED.has(key)) continue;
    if (body[key] === undefined) continue;

    if (LOGGED_AS_NAMED_ARRAY_DIFF.has(key)) {
      const diff = buildNamedArrayDiff(before?.[key], after?.[key], key);
      if (diff) changes[key] = diff;
      continue;
    }

    const from = comparable(before?.[key]);
    const to = comparable(after?.[key]);
    if (from === to) continue;

    changes[key] = LOGGED_AS_CHANGED_ONLY.has(key) ? '[changed]' : { from, to };
  }
  return Object.keys(changes).length ? changes : null;
};

export const buildEmployeeUpdateAuditEnvelope = (beforeCandidate, afterCandidate, body, entityId, actions) => {
  // The name the record had at save time. Without it the row is just an ObjectId, and once the
  // employee is deleted no lookup can ever recover who the entry was about.
  const personName =
    typeof afterCandidate?.fullName === 'string' && afterCandidate.fullName.trim()
      ? afterCandidate.fullName.trim()
      : typeof beforeCandidate?.fullName === 'string' && beforeCandidate.fullName.trim()
        ? beforeCandidate.fullName.trim()
        : null;

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
          ...(personName ? { fullName: personName } : {}),
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
  // `fieldsUpdated` says what the payload carried; `changes` says what actually moved and to what.
  // The form submits every field on every save, so the two are very different questions — and the
  // second is the one you need when reconstructing who changed a value and when.
  const changes = buildFieldChangeLog(beforeCandidate, afterCandidate, body);
  if (!changes) return { audit: null };

  return {
    audit: {
      action: actions.CANDIDATE_UPDATE,
      entityType: actions.CANDIDATE,
      entityId: String(entityId),
      metadata: { ...(personName ? { fullName: personName } : {}), fieldsUpdated, changes },
      occurredAt: new Date(),
    },
  };
};
