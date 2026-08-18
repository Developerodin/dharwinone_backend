import Employee from '../../../models/employee.model.js';
import User from '../../../models/user.model.js';
import { validateEmployeeQuery } from '../../../schemas/employees/employeeQuery.validator.js';
import { executeEmployeeQuery } from '../../../schemas/employees/employeeQuery.executor.js';
import {
  buildEmployeeListMongoFilter,
  countEmployeeCandidates,
  getAgentAssignmentSummary,
} from '../../employee.service.js';
import { renderEmployeeQueryResult } from '../../../schemas/employees/employeeQuery.renderer.js';
import { logEmployeeQueryAudit } from '../../../schemas/employees/employeeQuery.audit.js';
import { ENTITY_EMPLOYEES } from '../../../schemas/entityQuery.contract.js';
import { resolveViewerRole } from '../columnVisibility.js';
import { saveEmployeeQueryContext } from './saveEmployeeQueryContext.js';
import { detectAgentEmployeeIntent, planAgentQuery } from '../queryPlanner/planAgentQuery.js';
import { readAgentSubject, writeAgentSubject } from '../conversationState/agentSubject.js';
import {
  renderEmployeeAgentLookup,
  renderAgentEmployeeCount,
  renderMultiAgentEmployeeCount,
  renderUnassignedCount,
  renderAgentRanking,
  renderAgentsWithNoEmployees,
} from '../conversationPolicy/renderAgentEmployee.js';
import { AGENT_EMPLOYEE_RELATION } from '../agentEmployeeRelation.js';

export function looksLikeAgentEmployeeQuery(userMessage, currentAgentSubject = null) {
  return !!detectAgentEmployeeIntent(userMessage, { currentAgentSubject });
}

/**
 * @returns {Promise<object|null>}
 */
export async function runAgentEmployeeQuery({
  userMessage,
  user,
  uiContext = null,
  lastContext = null,
  requestId = null,
  deps = {},
}) {
  const readSubject = deps.readAgentSubject ?? readAgentSubject;
  const writeSubject = deps.writeAgentSubject ?? writeAgentSubject;

  const currentAgentSubject =
    deps.currentAgentSubject ??
    (await readSubject({
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      ...deps,
    }));

  const plan =
    (await deps.planAgentQuery?.({ userMessage, currentAgentSubject, lastContext, deps })) ??
    (await planAgentQuery({ userMessage, currentAgentSubject, lastContext, deps }));

  if (!plan) return null;

  const started = deps.now?.() ?? Date.now();

  if (plan.intent === 'ambiguous_agent') {
    const names = plan.matches.map((m) => m.name).join(', ');
    const count = plan.matches.length;
    const lead =
      count === 2
        ? 'I found two agents matching that name'
        : `I found ${count} agents matching that name`;
    return {
      reply: `${lead} (${names}). Which agent did you mean?`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  if (plan.intent === 'agent_not_found') {
    return {
      reply: `I couldn't find an agent named **${plan.name}**.`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  if (plan.intent === 'not_agent') {
    return {
      reply: `**${plan.name}** is not registered as an Agent in the system.`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  if (plan.intent === 'employee_agent_lookup') {
    return executeEmployeeAgentLookup({ plan, user, deps, started, requestId });
  }

  if (plan.intent === 'agent_ranking' || plan.intent === 'unassigned_count' || plan.intent === 'agents_no_employees') {
    return executeAgentSummaryQuery({ plan, user, deps, started, requestId, userMessage });
  }

  const isCountOnly =
    plan.operations?.includes('count') && !plan.operations?.includes('list');

  if (isCountOnly && plan.agentIds?.length) {
    if (plan.agentId) {
      await writeSubject({
        userId: user?.id,
        adminId: user?.adminId ?? user?.id,
        subject: buildAgentSubjectPayload(plan),
        ...deps,
      });
    }
    return executeAgentAssignedCountQuery({ plan, user, deps, started, currentAgentSubject });
  }

  if (plan.agentId) {
    await writeSubject({
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      subject: buildAgentSubjectPayload(plan),
      ...deps,
    });
  }

  const queryFilters = buildAgentQueryFilters(plan.filters);
  const structuredQuery = {
    entity: ENTITY_EMPLOYEES,
    operations: plan.operations?.includes('list') ? ['list'] : ['count'],
    filters: queryFilters,
    relations: [],
    pagination: lastContext?.pagination ?? { page: 1, limit: 50 },
  };

  const validation =
    deps.validateEmployeeQuery?.(structuredQuery) ?? validateEmployeeQuery(structuredQuery);
  if (!validation.ok) {
    return {
      reply: validation.error,
      blocks: [],
      deterministic: true,
      error: validation.code,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  const toolResult =
    (await deps.executeEmployeeQuery?.(validation.query, user, deps.executorDeps)) ??
    (await executeEmployeeQuery(validation.query, user, deps.executorDeps));

  const viewerRole = (await deps.resolveViewerRole?.(user)) ?? (await resolveViewerRole(user));

  let reply;
  let blocks = [];
  if (toolResult.success && plan.operations?.includes('count') && !plan.operations?.includes('list')) {
    reply = renderAgentEmployeeCount({
      agentName: plan.agentName,
      total: toolResult.total ?? 0,
      filters: queryFilters,
      breakdown: toolResult.employmentBreakdown ?? null,
      accountStatusScope: plan.filters?.accountStatusScope ?? null,
    });
  } else {
    const rendered =
      deps.renderEmployeeQueryResult?.(toolResult, { viewerRole }) ??
      renderEmployeeQueryResult(toolResult, { viewerRole });
    reply = rendered.reply;
    blocks = rendered.blocks;
  }

  if (toolResult.success) {
    await (deps.saveEmployeeQueryContext?.({
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      structuredQuery: validation.query,
      toolResult,
    }) ??
      saveEmployeeQueryContext({
        userId: user?.id,
        adminId: user?.adminId ?? user?.id,
        structuredQuery: validation.query,
        toolResult,
      }));
  }

  const tookMs = (deps.now?.() ?? Date.now()) - started;

  (deps.logEmployeeQueryAudit ?? logEmployeeQueryAudit)(
    {
      structuredQuery: validation.query,
      userMessage,
      userId: user?.id,
      adminId: user?.adminId ?? user?.id,
      resultCount: toolResult.records?.length,
      total: toolResult.total,
      executionTimeMs: tookMs,
      authDecision: toolResult.success ? 'ALLOWED' : (toolResult.error ?? 'DENIED'),
    },
    { requestId }
  );

  return {
    reply,
    blocks,
    deterministic: true,
    structuredQuery: validation.query,
    records: toolResult.records ?? [],
    total: toolResult.total ?? null,
    tookMs,
  };
}

async function executeEmployeeAgentLookup({ plan, user, deps, started, requestId }) {
  const { resolveUserEntity } = await import('../entityResolver.js');
  const resolveUser = deps.resolveUserEntity ?? resolveUserEntity;
  const employeeName = plan.employeeName;
  if (!employeeName) {
    return {
      reply: 'Which employee did you mean?',
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  const resolved = await resolveUser(employeeName, { viewer: user, ...deps });
  if (resolved.kind === 'ambiguous') {
    const names = resolved.matches.map((m) => m.name).join(', ');
    return {
      reply: `I found several matches (${names}). Which employee did you mean?`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }
  if (resolved.kind !== 'unique') {
    return {
      reply: `I couldn't find an employee named **${employeeName}**.`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  const EmployeeModel = deps.Employee ?? Employee;
  const query = resolved.match.empDocId
    ? { _id: resolved.match.empDocId }
    : { owner: resolved.match.userId };

  const employee = await EmployeeModel.findOne(query)
    .select(`fullName ${AGENT_EMPLOYEE_RELATION.employeeAssignedAgentField}`)
    .populate(AGENT_EMPLOYEE_RELATION.employeeAssignedAgentField, 'name email')
    .lean();

  if (!employee) {
    return {
      reply: `I couldn't find an employee profile for **${resolved.match.name}**.`,
      blocks: [],
      deterministic: true,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  const ag = employee[AGENT_EMPLOYEE_RELATION.employeeAssignedAgentField];
  const reply = renderEmployeeAgentLookup({
    employeeName: employee.fullName || resolved.match.name,
    agentName: ag && typeof ag === 'object' ? ag.name : null,
    agentEmail: ag && typeof ag === 'object' ? ag.email : null,
  });

  return {
    reply,
    blocks: [],
    deterministic: true,
    tookMs: (deps.now?.() ?? Date.now()) - started,
  };
}

function hasExplicitEmploymentScope(filters = {}) {
  return (
    filters.employmentStatus === 'current' ||
    filters.employmentStatus === 'resigned' ||
    filters.employmentStatus === 'all'
  );
}

function resolveStatusScope(filters = {}) {
  if (filters.accountStatusScope) return filters.accountStatusScope;
  if (filters.employmentStatus === 'current') return 'active';
  if (filters.employmentStatus === 'resigned') return 'resigned';
  if (filters.employmentStatus === 'all') return 'all';
  return null;
}

function buildAgentSubjectPayload(plan) {
  return {
    agentId: plan.agentId,
    name: plan.agentName,
    statusScope: resolveStatusScope(plan.filters),
  };
}

function buildAgentQueryFilters(filters = {}) {
  const next = { ...filters };
  delete next.accountStatusScope;
  if (!hasExplicitEmploymentScope(next)) {
    next.employmentStatus = 'all';
  }
  return next;
}

async function countAgentEmployeesByAccountStatus({ agentIds, accountStatusScope, employmentStatus, deps }) {
  const buildFilter = deps.buildEmployeeListMongoFilter ?? buildEmployeeListMongoFilter;
  const countFn = deps.countEmployeeCandidates ?? countEmployeeCandidates;
  const UserModel = deps.User ?? User;

  const { mongoFilter } = await buildFilter({
    agentIds: agentIds.join(','),
    employmentStatus: employmentStatus || 'all',
  });

  const owners = await UserModel.find({ status: accountStatusScope }).select('_id').lean();
  const ownerIds = owners.map((u) => u._id);
  if (!ownerIds.length) return 0;

  return countFn({
    ...mongoFilter,
    owner: { $in: ownerIds },
  });
}

async function executeAgentCountViaEmployeeQuery({ plan, user, deps }) {
  const accountStatusScope = plan.filters?.accountStatusScope ?? null;
  if (accountStatusScope) {
    const employmentStatus = plan.filters?.employmentStatus || 'all';
    const total = await countAgentEmployeesByAccountStatus({
      agentIds: plan.agentIds,
      accountStatusScope,
      employmentStatus,
      deps,
    });
    return {
      success: true,
      total,
      employmentBreakdown: null,
      query: {
        filters: {
          ...buildAgentQueryFilters(plan.filters),
          accountStatusScope,
        },
      },
    };
  }

  const structuredQuery = {
    entity: ENTITY_EMPLOYEES,
    operations: ['count'],
    filters: buildAgentQueryFilters(plan.filters),
  };

  const validation =
    deps.validateEmployeeQuery?.(structuredQuery) ?? validateEmployeeQuery(structuredQuery);
  if (!validation.ok) {
    return { success: false, error: validation.error, code: validation.code };
  }

  return (
    (await deps.executeEmployeeQuery?.(validation.query, user, deps.executorDeps)) ??
    executeEmployeeQuery(validation.query, user, deps.executorDeps)
  );
}

async function executeAgentAssignedCountQuery({ plan, user, deps, started, currentAgentSubject }) {
  if (plan.agentIds?.length > 1) {
    const parts = [];
    for (let i = 0; i < plan.agentIds.length; i += 1) {
      const perPlan = {
        ...plan,
        agentIds: [plan.agentIds[i]],
        agentId: plan.agentIds[i],
        agentName: plan.agentNames?.[i] ?? plan.agentIds[i],
        filters: { ...plan.filters, agentIds: [plan.agentIds[i]] },
      };
      const toolResult = await executeAgentCountViaEmployeeQuery({ plan: perPlan, user, deps });
      if (!toolResult.success) {
        return {
          reply: toolResult.error ?? 'Could not count assigned employees.',
          blocks: [],
          deterministic: true,
          error: toolResult.code,
          tookMs: (deps.now?.() ?? Date.now()) - started,
        };
      }
      parts.push({
        name: plan.agentNames?.[i] ?? plan.agentIds[i],
        total: toolResult.total ?? 0,
      });
    }

    const reply = renderMultiAgentEmployeeCount({
      parts,
      filters: buildAgentQueryFilters(plan.filters),
    });
    const tookMs = (deps.now?.() ?? Date.now()) - started;
    return {
      reply,
      blocks: [],
      deterministic: true,
      total: parts.reduce((sum, part) => sum + part.total, 0),
      tookMs,
    };
  }

  const toolResult = await executeAgentCountViaEmployeeQuery({ plan, user, deps });
  if (!toolResult.success) {
    return {
      reply: toolResult.error ?? 'Could not count assigned employees.',
      blocks: [],
      deterministic: true,
      error: toolResult.code,
      tookMs: (deps.now?.() ?? Date.now()) - started,
    };
  }

  const queryFilters = toolResult.query?.filters ?? buildAgentQueryFilters(plan.filters);
  const reply = renderAgentEmployeeCount({
    agentName: plan.agentName,
    total: toolResult.total ?? 0,
    filters: queryFilters,
    breakdown: toolResult.employmentBreakdown ?? null,
    accountStatusScope: plan.filters?.accountStatusScope ?? null,
  });

  const tookMs = (deps.now?.() ?? Date.now()) - started;
  return {
    reply,
    blocks: [],
    deterministic: true,
    total: toolResult.total ?? 0,
    tookMs,
  };
}

async function executeAgentSummaryQuery({ plan, user, deps, started, requestId, userMessage }) {
  const summaryFn = deps.getAgentAssignmentSummary ?? getAgentAssignmentSummary;
  const employmentStatus = plan.filters?.employmentStatus === 'resigned'
    ? 'resigned'
    : plan.filters?.employmentStatus === 'all'
      ? 'all'
      : 'current';

  const summary = await summaryFn({ employmentStatus });

  let reply;
  if (plan.intent === 'unassigned_count') {
    reply = renderUnassignedCount({ total: summary.unassignedCount ?? 0, filters: plan.filters });
  } else if (plan.intent === 'agents_no_employees') {
    const empty = (summary.agents || []).filter((a) => !a.assignedCount);
    reply = renderAgentsWithNoEmployees({ agents: empty });
  } else {
    const ranked = [...(summary.agents || [])]
      .filter((a) => a.assignedCount > 0)
      .sort((a, b) => b.assignedCount - a.assignedCount);
    reply = renderAgentRanking({ agents: ranked });
  }

  return {
    reply,
    blocks: [],
    deterministic: true,
    total: plan.intent === 'unassigned_count' ? summary.unassignedCount : null,
    tookMs: (deps.now?.() ?? Date.now()) - started,
  };
}
