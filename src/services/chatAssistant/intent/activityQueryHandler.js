import {
  readEntitySubject,
  writeEntitySubject,
  subjectFromProfile,
} from '../conversationState/entitySubject.js';
import { readPersonConversationState } from '../conversationState/personConversationState.js';
import { resolvePersonProfile } from '../personProfile/index.js';
import {
  detectActivityIntent,
  detectApplicationQueryOperation,
  detectApplicationStatusFilter,
  resolveActivityEntitySubject,
} from './activityIntents.js';
import {
  readApplicationQueryContext,
  saveApplicationQueryContext,
} from '../conversationState/applicationQueryContext.js';
import {
  renderEmployeeExistenceReply,
  renderInterviewsUnavailable,
  renderJobApplicationsReply,
} from '../conversationPolicy/renderActivity.js';
import { renderPersonDisambiguation } from '../conversationPolicy/renderFacts.js';

/**
 * Pre-LLM gate for person-scoped activity questions.
 * ENTITY (who) is resolved from conversation context; INTENT (what) from NL patterns.
 *
 * @param {{
 *   userMessage: string,
 *   user: object,
 *   adminId: any,
 *   userId: any,
 *   deps?: object,
 * }} opts
 * @returns {Promise<{ reply: string, blocks: object[], meta: object }|null>}
 */
export async function handleActivityQuery({
  userMessage,
  user,
  adminId,
  userId,
  deps = {},
}) {
  const readSubject = deps.readEntitySubject ?? readEntitySubject;
  const readPersonState = deps.readPersonConversationState ?? readPersonConversationState;
  const readAppQueryContext = deps.readApplicationQueryContext ?? readApplicationQueryContext;
  const saveAppQueryContext = deps.saveApplicationQueryContext ?? saveApplicationQueryContext;
  const resolveProfile = deps.resolvePersonProfile ?? resolvePersonProfile;
  const writeSubject = deps.writeEntitySubject ?? writeEntitySubject;
  const fetchJobApplications = deps.fetchJobApplications;

  const [currentEntitySubject, personConversationState, applicationQueryContext] = await Promise.all([
    readSubject({ userId, adminId, ...deps }),
    readPersonState({ userId, adminId, ...deps }),
    readAppQueryContext(deps.memoryDoc ?? null),
  ]);

  const intent = detectActivityIntent(userMessage, {
    applicationQueryContext,
    currentEntitySubject,
  });
  if (!intent) return null;

  const entitySubject = resolveActivityEntitySubject(userMessage, intent, {
    currentEntitySubject,
    personConversationState,
    applicationQueryContext,
  });

  if (!entitySubject?.name && !entitySubject?.userId) {
    return {
      reply: 'Which person should I look that up for?',
      blocks: [],
      meta: { kind: 'activity_query', intent, deterministic: true },
    };
  }

  switch (intent) {
    case 'job_applications':
      return handleJobApplications({
        entitySubject,
        user,
        adminId,
        userId,
        userMessage,
        applicationQueryContext,
        fetchJobApplications,
        resolveProfile,
        writeSubject,
        saveAppQueryContext,
      });
    case 'employee_existence':
      return handleEmployeeExistence({
        entitySubject,
        user,
        adminId,
        resolveProfile,
        currentEntitySubject,
      });
    case 'interviews':
      return {
        reply: renderInterviewsUnavailable(entitySubject.name),
        blocks: [],
        meta: { kind: 'activity_query', intent: 'interviews', deterministic: true },
      };
    default:
      return null;
  }
}

async function handleJobApplications({
  entitySubject,
  user,
  adminId,
  userId,
  userMessage,
  applicationQueryContext,
  fetchJobApplications,
  resolveProfile,
  writeSubject,
  saveAppQueryContext,
}) {
  if (typeof fetchJobApplications !== 'function') {
    return {
      reply: "I don't have person-scoped job application lookup wired yet.",
      blocks: [],
      meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
    };
  }

  if (!entitySubject.name && !entitySubject.userId) {
    return {
      reply: 'Which person should I check applications for?',
      blocks: [],
      meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
    };
  }

  const statusFilter = detectApplicationStatusFilter(userMessage);

  let profile = null;
  if (entitySubject.name || entitySubject.userId) {
    try {
      profile = await resolveProfile({
        person: entitySubject.name,
        userId: entitySubject.userId,
        depth: 'brief',
        viewer: user,
        impersonating: !!user?.__impersonating,
        adminId,
      });
    } catch {
      profile = entitySubject.name ? { kind: 'unavailable' } : null;
    }
  }

  if (profile?.kind === 'ambiguous') {
    return {
      reply: renderPersonDisambiguation({ matches: profile.matches }),
      blocks: [],
      meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
    };
  }

  if (profile?.kind === 'notAuthorized') {
    return {
      reply: "You don't have access to look up other people's profiles.",
      blocks: [],
      meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
    };
  }

  const applicantName = profile?.kind === 'unique'
    ? profile.identity.name
    : entitySubject.name;

  if (!applicantName) {
    if (profile?.kind === 'notFound') {
      return {
        reply: `I couldn't find **${entitySubject.name}** in the directory.`,
        blocks: [],
        meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
      };
    }
    if (profile?.kind === 'unavailable') {
      return {
        reply: "I couldn't reach the directory just now — try again in a moment.",
        blocks: [],
        meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
      };
    }
  }

  const fetchArgs = { applicantName };
  if (statusFilter) fetchArgs.status = statusFilter;

  let data;
  try {
    data = await fetchJobApplications(fetchArgs, user);
  } catch {
    return {
      reply: "I couldn't reach the application directory just now — try again in a moment.",
      blocks: [],
      meta: { kind: 'activity_query', intent: 'job_applications', deterministic: true },
    };
  }
  const total = Number(data?.total ?? data?.records?.length ?? 0);
  const operation = detectApplicationQueryOperation(userMessage, { applicationQueryContext });
  const reply = renderJobApplicationsReply({
    name: applicantName,
    total,
    records: data?.records ?? [],
    operation,
    statusFilter,
  });

  if (userId && adminId && applicantName) {
    await saveAppQueryContext({
      userId,
      adminId,
      queryContext: {
        applicantName,
        userId: profile?.kind === 'unique' ? profile.identity.userId : entitySubject.userId ?? null,
        domain: 'applications',
        statusFilter,
        lastTotal: total,
        operation,
      },
    });
  }

  if (profile?.kind === 'unique' && userId && adminId) {
    const subject = subjectFromProfile(profile);
    if (subject) {
      await writeSubject({ userId, adminId, subject, ...{} });
    }
  }

  return {
    reply,
    blocks: [],
    meta: {
      kind: 'activity_query',
      intent: 'job_applications',
      operation,
      relationship: 'APPLIED_TO',
      statusFilter,
      total,
      deterministic: true,
    },
  };
}

async function handleEmployeeExistence({
  entitySubject,
  user,
  adminId,
  resolveProfile,
  currentEntitySubject,
}) {
  const profile = await resolveProfile({
    person: entitySubject.name,
    userId: entitySubject.userId,
    depth: 'brief',
    viewer: user,
    impersonating: !!user?.__impersonating,
    adminId,
  });

  const subject = {
    name: entitySubject.name || currentEntitySubject?.name,
    employeeId: currentEntitySubject?.employeeId ?? null,
  };

  return {
    reply: renderEmployeeExistenceReply(profile, subject),
    blocks: [],
    meta: {
      kind: 'activity_query',
      intent: 'employee_existence',
      found: profile?.kind === 'unique',
      deterministic: true,
    },
  };
}
