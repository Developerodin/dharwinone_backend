import { validateEmployeeQuery } from '../../../schemas/employees/employeeQuery.validator.js';
import { executeEmployeeQuery } from '../../../schemas/employees/employeeQuery.executor.js';
import { resolveViewerRole } from '../columnVisibility.js';
import { renderCompoundEmployeeQueryResult } from './compoundQuery.renderer.js';
import { saveEmployeeQueryContext } from '../entityQuery/saveEmployeeQueryContext.js';
import { logEmployeeQueryAudit } from '../../../schemas/employees/employeeQuery.audit.js';
import { ENTITY_EMPLOYEES } from '../../../schemas/entityQuery.contract.js';

/**
 * @param {object} plan
 * @param {object} group
 * @param {object} user
 * @param {object} deps
 * @returns {Promise<object>}
 */
async function executeGroup(plan, group, user, deps) {
  const wantsList = plan.intent === 'list';
  const structuredQuery = {
    entity: ENTITY_EMPLOYEES,
    operations: wantsList ? ['list'] : ['count'],
    filters: { ...group.filters },
    relations: [],
    pagination: { ...(plan.pagination ?? { page: 1, limit: 50 }) },
  };

  const validation =
    deps.validateEmployeeQuery?.(structuredQuery) ?? validateEmployeeQuery(structuredQuery);
  if (!validation.ok) {
    return {
      group,
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  const toolResult =
    (await deps.executeEmployeeQuery?.(validation.query, user, deps.executorDeps)) ??
    (await executeEmployeeQuery(validation.query, user, deps.executorDeps));

  return {
    group,
    structuredQuery: validation.query,
    toolResult,
    success: !!toolResult?.success,
  };
}

/**
 * Execute a multi-group employee query plan.
 *
 * @param {{
 *   plan: object,
 *   userMessage: string,
 *   user: object,
 *   requestId?: string|null,
 *   deps?: object,
 * }} input
 */
export async function executeCompoundEmployeeQuery({
  plan,
  userMessage,
  user,
  requestId = null,
  deps = {},
}) {
  const started = deps.now?.() ?? Date.now();
  const groupResults = [];

  for (const group of plan.filterGroups) {
    groupResults.push(await executeGroup(plan, group, user, deps));
  }

  const succeeded = groupResults.filter((r) => r.success);
  if (succeeded.length !== plan.filterGroups.length) {
    const firstErr = groupResults.find((r) => !r.success);
    const tookMs = (deps.now?.() ?? Date.now()) - started;
    (deps.logEmployeeQueryAudit ?? logEmployeeQueryAudit)(
      {
        structuredQuery: { compound: true, plan },
        userMessage,
        userId: user?.id,
        adminId: user?.adminId ?? user?.id,
        authDecision: firstErr?.code ?? 'EXECUTION',
        executionTimeMs: tookMs,
      },
      { requestId }
    );
    return {
      reply: firstErr?.error || firstErr?.toolResult?.message || 'Unable to retrieve employee data.',
      blocks: [],
      deterministic: true,
      records: [],
      total: null,
      error: firstErr?.code ?? 'EXECUTION',
      tookMs,
    };
  }

  const viewerRole = (await deps.resolveViewerRole?.(user)) ?? (await resolveViewerRole(user));
  const compoundResult = {
    plan,
    groups: succeeded.map((r) => ({
      id: r.group.id,
      filters: r.group.filters,
      count: Number(r.toolResult.total ?? 0),
      records: r.toolResult.records ?? [],
      toolResult: r.toolResult,
      structuredQuery: r.structuredQuery,
    })),
    total: succeeded.reduce((sum, r) => sum + Number(r.toolResult.total ?? 0), 0),
  };

  const rendered =
    deps.renderCompoundEmployeeQueryResult?.(compoundResult, { viewerRole }) ??
    renderCompoundEmployeeQueryResult(compoundResult, { viewerRole });

  const primaryStructuredQuery = succeeded[0]?.structuredQuery ?? null;
  const primaryToolResult = {
    success: true,
    source: 'employees',
    query: primaryStructuredQuery,
    total: compoundResult.total,
    records: compoundResult.groups.flatMap((g) => g.records),
    compound: compoundResult,
  };

  await (deps.saveEmployeeQueryContext?.({
    userId: user?.id,
    adminId: user?.adminId ?? user?.id,
    structuredQuery: primaryStructuredQuery,
    toolResult: primaryToolResult,
    queryPlan: plan,
    compoundResult,
  }) ??
    saveEmployeeQueryContext({
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      structuredQuery: primaryStructuredQuery,
      toolResult: primaryToolResult,
      queryPlan: plan,
      compoundResult,
    }));

  const tookMs = (deps.now?.() ?? Date.now()) - started;
  (deps.logEmployeeQueryAudit ?? logEmployeeQueryAudit)(
    {
      structuredQuery: { compound: true, plan, groups: compoundResult.groups.length },
      userMessage,
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      resultCount: compoundResult.groups.reduce((n, g) => n + g.records.length, 0),
      total: compoundResult.total,
      executionTimeMs: tookMs,
      authDecision: 'ALLOWED',
    },
    { requestId }
  );

  return {
    reply: rendered.reply,
    blocks: rendered.blocks,
    deterministic: true,
    structuredQuery: primaryStructuredQuery,
    records: primaryToolResult.records,
    total: compoundResult.total,
    compoundResult,
    tookMs,
  };
}
