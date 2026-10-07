import bolnaService from './bolna.service.js';
import config from '../config/config.js';
import {
  CANDIDATE_VERIFICATION_CATEGORY,
  CANDIDATE_VERIFICATION_FIELD_NAMES,
  getCandidateVerificationDispositionSpecs,
} from '../config/candidateVerificationDispositions.js';

function resolveCandidateAgentId(agentId) {
  // Never fall back to BOLNA_AGENT_ID — job-verification and candidate-verification agents must differ.
  return agentId || config.bolna.candidateAgentId || '';
}

/**
 * Idempotently create Bolna dispositions for all Candidate Verification fields.
 * Uses bulk API when none exist; creates missing rows individually when partially configured.
 */
export async function ensureCandidateVerificationExtractions(agentId) {
  const resolvedAgentId = resolveCandidateAgentId(agentId);
  if (!resolvedAgentId) {
    return { success: false, error: 'BOLNA_CANDIDATE_AGENT_ID is not configured.' };
  }

  const specs = getCandidateVerificationDispositionSpecs();
  const listed = await bolnaService.listDispositions(resolvedAgentId);
  if (!listed.success) {
    return {
      success: false,
      agentId: resolvedAgentId,
      bolnaStatus: listed.status,
      error: listed.error || 'Failed to list Bolna dispositions',
    };
  }

  const existing = (listed.dispositions || []).filter(
    (d) => d.category === CANDIDATE_VERIFICATION_CATEGORY
  );
  const existingNames = new Set(existing.map((d) => d.name));
  const missing = specs.filter((s) => !existingNames.has(s.name));

  if (missing.length === 0) {
    return {
      success: true,
      agentId: resolvedAgentId,
      alreadyConfigured: true,
      category: CANDIDATE_VERIFICATION_CATEGORY,
      existingCount: existing.length,
      createdIds: [],
      fieldNames: CANDIDATE_VERIFICATION_FIELD_NAMES,
    };
  }

  if (missing.length === specs.length) {
    const bulk = await bolnaService.bulkCreateDispositions(resolvedAgentId, missing);
    if (!bulk.success) {
      return {
        success: false,
        agentId: resolvedAgentId,
        bolnaStatus: bulk.status,
        error: bulk.error || 'Bulk disposition create failed',
      };
    }
    return {
      success: true,
      agentId: resolvedAgentId,
      alreadyConfigured: false,
      category: CANDIDATE_VERIFICATION_CATEGORY,
      existingCount: 0,
      createdIds: bulk.ids || [],
      createdCount: (bulk.ids || []).length,
      fieldNames: CANDIDATE_VERIFICATION_FIELD_NAMES,
    };
  }

  const createdIds = [];
  for (const spec of missing) {
    const created = await bolnaService.createDisposition(resolvedAgentId, spec);
    if (!created.success) {
      return {
        success: false,
        agentId: resolvedAgentId,
        bolnaStatus: created.status,
        error: created.error || `Failed to create disposition "${spec.name}"`,
        partialCreatedIds: createdIds,
      };
    }
    if (created.id) createdIds.push(created.id);
  }

  return {
    success: true,
    agentId: resolvedAgentId,
    alreadyConfigured: false,
    category: CANDIDATE_VERIFICATION_CATEGORY,
    existingCount: existing.length,
    createdIds,
    createdCount: createdIds.length,
    fieldNames: CANDIDATE_VERIFICATION_FIELD_NAMES,
  };
}
