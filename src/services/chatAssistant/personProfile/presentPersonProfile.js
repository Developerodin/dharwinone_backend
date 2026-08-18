import {
  detectPresentationIntent,
  shouldAttachTableBlocks,
} from '../sage/presentationStrategy.js';
import {
  readPersonConversationState,
  writePersonConversationState,
  collectVisibleFieldKeys,
  mergeCommunicatedFields,
} from '../conversationState/personConversationState.js';
import {
  writeEntitySubject,
  subjectFromProfile,
} from '../conversationState/entitySubject.js';
import {
  writeAgentSubject,
  subjectFromAgentProfile,
} from '../conversationState/agentSubject.js';
import {
  renderPersonProfile,
  renderPersonProfileAcknowledgment,
  renderPersonProfileDelta,
  renderPersonProfileSingleFact,
} from '../conversationPolicy/renderFacts.js';
import { buildProfileTableBlock } from './profileTableBlock.js';

/**
 * Resolve presentation for a person profile lookup.
 *
 * @param {{
 *   profile: Awaited<ReturnType<import('./index.js').resolvePersonProfile>>,
 *   userMessage: string,
 *   userId: any,
 *   adminId: any,
 *   selectionKind?: 'select'|'reask'|'cancel'|'unrelated',
 *   depth?: 'brief'|'full',
 *   deps?: object,
 * }} opts
 */
export async function presentPersonProfile({
  profile,
  userMessage,
  userId,
  adminId,
  selectionKind,
  depth = 'brief',
  deps = {},
}) {
  const readState = deps.readPersonConversationState ?? readPersonConversationState;
  const writeState = deps.writePersonConversationState ?? writePersonConversationState;
  const writeSubject = deps.writeEntitySubject ?? writeEntitySubject;
  const writeAgent = deps.writeAgentSubject ?? writeAgentSubject;

  const priorState = await readState({ userId, adminId, ...deps });
  const presentation = detectPresentationIntent(userMessage, {
    selectionKind,
    depth,
    hasPriorCommunication: !!(priorState?.communicatedFields?.length),
    hasSubject: !!(priorState?.entityId || profile?.kind === 'unique'),
  });

  if (profile.kind !== 'unique') {
    return {
      reply: renderPersonProfile(profile),
      blocks: [],
      meta: {
        kind: 'person_profile',
        entityType: 'user',
        presentationMode: presentation.mode,
        deterministic: true,
      },
    };
  }

  const { identity } = profile;
  let reply;
  let blocks = [];
  let usedFields = [];

  switch (presentation.intent) {
    case 'acknowledgment': {
      const out = renderPersonProfileAcknowledgment(profile);
      reply = out.text;
      usedFields = out.usedFields;
      break;
    }
    case 'anything_else': {
      const communicated = priorState?.entityId === String(identity.userId)
        ? priorState.communicatedFields
        : [];
      const out = renderPersonProfileDelta(profile, communicated);
      reply = out.text;
      usedFields = out.usedFields;
      break;
    }
    case 'single_fact': {
      const out = renderPersonProfileSingleFact(profile, presentation.field);
      reply = out.text;
      usedFields = out.usedFields;
      break;
    }
    case 'full_profile': {
      reply = renderPersonProfile({ ...profile, depth: 'full' });
      usedFields = collectVisibleFieldKeys(profile);
      if (shouldAttachTableBlocks(presentation.mode)) {
        const block = buildProfileTableBlock(profile);
        if (block) blocks = [block];
      }
      break;
    }
    default: {
      reply = renderPersonProfile(profile);
      usedFields = collectBriefFields(profile);
      break;
    }
  }

  const communicatedFields = mergeCommunicatedFields(
    priorState?.entityId === String(identity.userId) ? priorState.communicatedFields : [],
    usedFields
  );

  await writeState({
    userId,
    adminId,
    state: {
      entityId: identity.userId,
      entityType: 'user',
      name: identity.name,
      communicatedFields,
    },
    ...deps,
  });

  const entitySubject = subjectFromProfile(profile);
  if (entitySubject) {
    await writeSubject({ userId, adminId, subject: entitySubject, ...deps });
  }

  const agentSubject = subjectFromAgentProfile(profile);
  if (agentSubject) {
    await writeAgent({ userId, adminId, subject: agentSubject, ...deps });
  }

  return {
    reply,
    blocks,
    meta: {
      kind: 'person_profile',
      entityType: 'user',
      businessRoles: identity.roles || [],
      presentationMode: presentation.mode,
      presentationIntent: presentation.intent,
      deterministic: true,
    },
  };
}

/** Fields surfaced in a default brief conversational turn. */
function collectBriefFields(profile) {
  const primary = Object.values(profile.profiles)[0];
  const keys = primary?.summaryFields || [];
  const used = ['name', 'roles', ...keys];
  return [...new Set(used)];
}
