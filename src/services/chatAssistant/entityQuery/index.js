import config, { stableHashUserId } from '../../../config/config.js';
import { validateEmployeeQuery } from '../../../schemas/employees/employeeQuery.validator.js';
import { executeEmployeeQuery } from '../../../schemas/employees/employeeQuery.executor.js';
import { renderEmployeeQueryResult } from '../../../schemas/employees/employeeQuery.renderer.js';
import { logEmployeeQueryAudit } from '../../../schemas/employees/employeeQuery.audit.js';
import { resolveViewerRole } from '../columnVisibility.js';
import { resolveEmployeeStructuredQuery, resolveEmployeeLastContextFollowUp } from './contextResolver.js';
import { looksLikeEmployeeFilterQuery } from './nlResolver.js';
import { resolveEntity, hasHrSignals } from './resolveEntity.js';
import { saveEmployeeQueryContext } from './saveEmployeeQueryContext.js';

export { resolveEntity, hasHrSignals } from './resolveEntity.js';

/**
 * Feature flag gate with optional percent rollout via stableHashUserId.
 *
 * When CHATBOT_TWO_STAGE is enabled, entityQuery still runs via the early gate in
 * sendMessage/streamMessage (before prepareContext). Two-stage classifier/fetcher
 * is skipped for deterministic employee queries.
 */
export function useEmployeeEntityQuery(user) {
  if (!config.chatbot?.entityQueryEmployees) return false;

  const pct = config.chatbot.entityQueryEmployeesPercent ?? 100;
  if (pct >= 100) return true;
  if (pct <= 0) return false;

  const userId = user?._id ?? user?.id;
  if (!userId) return false;

  return stableHashUserId(String(userId)) % 100 < pct;
}

function shouldHandleEmployeeEntityQuery(userMessage, lastContext) {
  const entity = resolveEntity(userMessage, lastContext);
  if (entity === 'employees') return true;
  if (entity === 'users') return false;
  // Legacy fallback for HR alias matches without resolveEntity hit
  if (resolveEmployeeLastContextFollowUp(userMessage, { lastContext }, { entityQueryEnabled: true })) {
    return true;
  }
  return looksLikeEmployeeFilterQuery(userMessage) && hasHrSignals(userMessage);
}

/**
 * Full employee entityQuery orchestrator pipeline.
 *
 * resolveEmployeeStructuredQuery → validateEmployeeQuery → executeEmployeeQuery
 * → renderEmployeeQueryResult → saveEmployeeQueryContext → logEmployeeQueryAudit
 *
 * @returns {Promise<object|null>} Deterministic result, or null to fall through to legacy path.
 */
export async function runEmployeeEntityQuery({
  userMessage,
  user,
  uiContext = null,
  lastContext = null,
  requestId = null,
  deps = {},
}) {
  if (!shouldHandleEmployeeEntityQuery(userMessage, lastContext)) {
    return null;
  }

  const started = deps.now?.() ?? Date.now();

  const structuredQuery =
    deps.resolveEmployeeStructuredQuery?.({ userMessage, uiContext, lastContext }) ??
    resolveEmployeeStructuredQuery({ userMessage, uiContext, lastContext });

  const validation =
    deps.validateEmployeeQuery?.(structuredQuery) ?? validateEmployeeQuery(structuredQuery);

  if (!validation.ok) {
    const tookMs = (deps.now?.() ?? Date.now()) - started;
    (deps.logEmployeeQueryAudit ?? logEmployeeQueryAudit)(
      {
        structuredQuery,
        userMessage,
        userId: user?.id,
        adminId: user?.adminId ?? user?.id,
        authDecision: 'VALIDATION',
        executionTimeMs: tookMs,
      },
      { requestId }
    );
    return {
      reply: validation.error,
      blocks: [],
      deterministic: true,
      structuredQuery,
      records: [],
      total: null,
      error: validation.code,
      tookMs,
    };
  }

  const validatedQuery = validation.query;

  const toolResult =
    (await deps.executeEmployeeQuery?.(validatedQuery, user, deps.executorDeps)) ??
    (await executeEmployeeQuery(validatedQuery, user, deps.executorDeps));

  const viewerRole = (await deps.resolveViewerRole?.(user)) ?? (await resolveViewerRole(user));

  const rendered =
    deps.renderEmployeeQueryResult?.(toolResult, { viewerRole }) ??
    renderEmployeeQueryResult(toolResult, { viewerRole });

  if (toolResult.success) {
    await (deps.saveEmployeeQueryContext?.({
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      structuredQuery: validatedQuery,
      toolResult,
    }) ??
      saveEmployeeQueryContext({
        userId: user?.id,
        adminId: user?.adminId ?? user?.id,
        structuredQuery: validatedQuery,
        toolResult,
      }));
  }

  const tookMs = (deps.now?.() ?? Date.now()) - started;

  (deps.logEmployeeQueryAudit ?? logEmployeeQueryAudit)(
    {
      structuredQuery: validatedQuery,
      userMessage,
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      uiContextApplied: Boolean(uiContext?.activeFilters),
      provenance: toolResult.provenance,
      resultCount: toolResult.records?.length,
      total: toolResult.total,
      executionTimeMs: tookMs,
      authDecision: toolResult.success ? 'ALLOWED' : (toolResult.error ?? 'DENIED'),
    },
    { requestId }
  );

  return {
    reply: rendered.reply,
    blocks: rendered.blocks,
    deterministic: true,
    structuredQuery: validatedQuery,
    records: toolResult.records ?? [],
    total: toolResult.total ?? null,
    tookMs,
  };
}
