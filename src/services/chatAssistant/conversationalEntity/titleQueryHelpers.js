/**
 * Helpers for title-ambiguity → entityQuery handoff.
 */

/**
 * @param {object|null|undefined} entityResult
 * @param {object} [extraMeta]
 */
export function employeeResultEnvelope(entityResult, extraMeta = {}) {
  if (!entityResult?.deterministic) return null;
  return {
    reply: entityResult.reply,
    blocks: entityResult.blocks ?? [],
    meta: {
      kind: 'employees',
      entityType: 'employees',
      queryId: entityResult.structuredQuery?.queryId ?? null,
      total: typeof entityResult.total === 'number' ? entityResult.total : null,
      deterministic: true,
      tookMs: entityResult.tookMs ?? null,
      ...extraMeta,
    },
  };
}

/**
 * @param {object} payload
 * @param {string|null|undefined} [previousEntityType]
 */
export function normalizeResponseEnvelope(payload, previousEntityType = null) {
  const entityType = payload?.meta?.entityType ?? payload?.meta?.kind ?? null;
  const blocks =
    entityType && previousEntityType && entityType !== previousEntityType
      ? (payload.blocks ?? [])
      : (payload.blocks ?? []);

  return {
    ...payload,
    blocks: Array.isArray(blocks) ? blocks : [],
    meta: {
      ...(payload.meta || {}),
      entityType: entityType ?? null,
    },
  };
}
