import { extractOrgStructureArgs } from './orgStructureAnalytics.js';

/**
 * Business Knowledge Layer — resolves ambiguous HR terms to authoritative meanings.
 *
 * Each concept can map to multiple meanings (populations / data sources). The
 * orchestrator clarifies when more than one meaning is plausible.
 *
 * Started with "manager"; structure scales to employee, candidate, lead, etc.
 */

/** @typedef {'OrgManager'|'DesignationManager'} ManagerMeaningId */

/** @typedef {{ concept: string, meaning: ManagerMeaningId, confidence: number, label: string }} ConceptResolution */

export const MANAGER_MEANINGS = Object.freeze({
  OrgManager: {
    id: 'OrgManager',
    label: 'organizational managers',
    shortLabel: 'org hierarchy',
    description: 'Employees with one or more direct reports (org chart / reportingManager)',
    tool: 'org_manager_analytics',
    metric: 'org_managers',
  },
  DesignationManager: {
    id: 'DesignationManager',
    label: 'employees whose job title/designation is Manager',
    shortLabel: 'designation',
    description: 'Active employees whose designation matches the requested title',
    tool: 'fetch_employees',
    metric: 'designation',
  },
});

const ORG_CHART_SIGNALS = [
  /\b(my|our)\s+manager\b/i,
  /\bwho\s+(is|are)\s+(my|our)\s+manager\b/i,
  /\breports?\s+to\b/i,
  /\b(reporting|direct)\s+reports?\b/i,
  /\borg(\s|-)?(chart|structure|hierarchy)\b/i,
  /\borganization(al)?\s+(chart|structure|hierarchy)\b/i,
  /\bhierarchy\b/i,
  /\bhead\s+of\b/i,
  /\bsupervisor\b/i,
  /\bline\s+manager\b/i,
  /\bunder\s+(the\s+)?(org|organization)\b/i,
];

const DESIGNATION_SIGNALS = [
  /\bdesignation\b/i,
  /\bjob\s+title\b/i,
  /\btitle\s+is\b/i,
  /\bemployees?\s+with\s+(the\s+)?(designation|title)\b/i,
  /\b(role|title)\s+(of\s+)?manager\b/i,
  /\bHR\s+managers?\b/i,
  /\bsenior\s+managers?\b/i,
  /\bassistant\s+managers?\b/i,
  /\bproject\s+managers?\b/i,
  /\boperations\s+managers?\b/i,
];

const BARE_MANAGER_RE =
  /\bmanagers?\b/i;

const COUNT_OR_LIST_RE =
  /\b(how many|count|number of|total|list|show|who (are|is))\b/i;

/**
 * True when the query mentions "manager" in a way that needs concept resolution.
 * @param {string} text
 * @returns {boolean}
 */
export function mentionsManagerConcept(text) {
  if (!text) return false;
  return BARE_MANAGER_RE.test(text);
}

/**
 * Extract a compound designation phrase when present (e.g. "HR Managers").
 * @param {string} text
 * @returns {string|null}
 */
export function extractDesignationPhrase(text) {
  if (!text) return null;
  if (/\bdesignation\s+(is\s+)?manager\b/i.test(text) || /\btitle\s+(is\s+)?manager\b/i.test(text)) {
    return 'Manager';
  }
  const hr = text.match(/\bHR\s+managers?\b/i);
  if (hr) return 'HR Manager';
  const compound = text.match(/\b([A-Za-z][\w-]*)\s+managers?\b/i);
  if (compound) {
    const word = compound[1];
    if (!/^(how|who|the|our|all|many|count|list|show|total|number|employees?|staff|organizational?|org|designation|title|with|is|my|have|we|do)$/i.test(word)) {
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()} Manager`;
    }
  }
  return null;
}

/**
 * Score org-chart vs designation meaning for a manager query.
 * @param {string} text
 * @returns {ConceptResolution[]}
 */
export function resolveConcept(term, queryContext = {}) {
  const text = String(queryContext.text || queryContext.query || '');
  const normalized = String(term || '').trim().toLowerCase();
  if (normalized !== 'manager' && normalized !== 'managers') {
    return [];
  }
  if (!mentionsManagerConcept(text)) return [];

  const designationPhrase = extractDesignationPhrase(text);
  const isCountOrList = COUNT_OR_LIST_RE.test(text);
  const hasBareManagerCount =
    isCountOrList &&
    BARE_MANAGER_RE.test(text) &&
    !designationPhrase &&
    !/\b(reports?\s+to|my manager|org chart|hierarchy|supervisor)\b/i.test(text);

  if (hasBareManagerCount) {
    // Bare count/list → manager POSITIONS on org chart (same as supervisors), not ambiguous.
    return [];
  }

  let orgScore = 0;
  let desigScore = 0;

  for (const re of ORG_CHART_SIGNALS) {
    if (re.test(text)) orgScore += 0.35;
  }
  for (const re of DESIGNATION_SIGNALS) {
    if (re.test(text)) desigScore += 0.35;
  }

  if (designationPhrase) desigScore += 0.55;

  if (/\bin\s+(the\s+)?org\b/i.test(text) && isCountOrList && BARE_MANAGER_RE.test(text)) {
    orgScore += 0.15;
  }

  if (/\breports?\s+to\s+[A-Za-z]/i.test(text)) orgScore += 0.6;

  if (/\b(my|our)\s+manager\b/i.test(text)) orgScore += 0.85;

  const resolutions = [];
  if (orgScore > 0) {
    resolutions.push({
      concept: 'manager',
      meaning: 'OrgManager',
      confidence: Math.min(orgScore, 1),
      label: MANAGER_MEANINGS.OrgManager.label,
    });
  }
  if (desigScore > 0) {
    resolutions.push({
      concept: 'manager',
      meaning: 'DesignationManager',
      confidence: Math.min(desigScore, 1),
      label: MANAGER_MEANINGS.DesignationManager.label,
    });
  }

  resolutions.sort((a, b) => b.confidence - a.confidence);
  return resolutions;
}

/**
 * @param {ConceptResolution[]} resolutions
 * @param {{ threshold?: number }} [opts]
 * @returns {boolean}
 */
export function isAmbiguous(resolutions, opts = {}) {
  const threshold = opts.threshold ?? 0.7;
  if (!resolutions?.length) return false;
  if (resolutions.length < 2) return false;
  const top = resolutions[0]?.confidence ?? 0;
  const second = resolutions[1]?.confidence ?? 0;
  if (top >= threshold && top - second >= 0.25) return false;
  return second >= 0.4;
}

/**
 * Pick a single winning meaning when not ambiguous.
 * @param {ConceptResolution[]} resolutions
 * @returns {ManagerMeaningId|null}
 */
export function pickManagerMeaning(resolutions) {
  if (!resolutions?.length) return null;
  if (isAmbiguous(resolutions)) return null;
  return resolutions[0].meaning;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isAmbiguousManagerQuery(text) {
  if (!mentionsManagerConcept(text)) return false;
  const resolutions = resolveConcept('manager', { text });
  return isAmbiguous(resolutions);
}

/**
 * Build a data-aware clarification question.
 * @param {{ orgManagers: number, designationManagers: number, designationPhrase?: string|null }} counts
 * @returns {{ needsClarification: true, clarifyingQuestion: string, options: Array<{ id: ManagerMeaningId, label: string, count: number }> }}
 */
export function buildManagerClarification(counts = {}) {
  const org = Number(counts.orgManagers ?? 0);
  const desig = Number(counts.designationManagers ?? 0);
  const phrase = counts.designationPhrase || 'Manager';

  const options = [
    {
      id: 'OrgManager',
      label: `Organizational managers (${org} with direct reports)`,
      count: org,
    },
    {
      id: 'DesignationManager',
      label: `Employees with designation "${phrase}" (${desig})`,
      count: desig,
    },
  ];

  const clarifyingQuestion =
    '"Manager" can mean two things in Dharwin:\n' +
    `• **Organizational managers** (people with direct reports — currently **${org}**)\n` +
    `• **Employees whose designation is "${phrase}"** (currently **${desig}**)\n` +
    'Which one did you mean?';

  return {
    needsClarification: true,
    clarifyingQuestion,
    options,
    concept: 'manager',
  };
}

/**
 * Bare "how many/list managers" → manager POSITIONS (OrgUnit.type=manager), not org-manager people count.
 * @param {string} text
 * @returns {boolean}
 */
export function isBareManagerPositionQuery(text) {
  if (!text || !mentionsManagerConcept(text)) return false;
  if (!COUNT_OR_LIST_RE.test(text)) return false;
  if (extractDesignationPhrase(text)) return false;
  if (/\b(reports?\s+to|direct reports?|organizational? managers?|people with|org(\s|-)?hierarchy)\b/i.test(text)) {
    return false;
  }
  return true;
}

/**
 * Route bare manager count/list asks to org_structure_analytics (manager positions).
 * @param {string} text
 * @returns {{ modules: string[], args: object }}
 */
export function buildManagerPositionRoutingIntent(text = '') {
  return {
    modules: ['org_structure_analytics'],
    args: { ...extractOrgStructureArgs(text), phrase: text },
  };
}

/**
 * Default to proactive dual answers for ambiguous manager count/name asks.
 * @param {string} text
 * @returns {boolean}
 */
export function shouldProactivelyAnswerBoth(text) {
  if (isBareManagerPositionQuery(text)) return false;
  if (!isAmbiguousManagerQuery(text)) return false;
  return COUNT_OR_LIST_RE.test(text);
}

/**
 * Follow-up phrases that switch manager interpretation using topic memory.
 * @param {string} text
 * @param {{ concept?: string, lastInterpretation?: string }|null} topic
 * @returns {ManagerMeaningId|null}
 */
export function parseManagerTopicFollowUp(text, topic = null) {
  if (!text || topic?.concept !== 'manager') return null;
  const t = String(text).trim().toLowerCase();

  if (
    /\b(designation|title|job title|second (one|option)|by title|title instead)\b/.test(t) ||
    (/\bwhat about\b/.test(t) && /\b(designation|title)\b/.test(t))
  ) {
    return 'DesignationManager';
  }
  if (
    /\b(org(\s|-)?chart|organization(al)?|hierarchy|reporting managers?|first (one|option)|org instead)\b/.test(t) ||
    (/\bwhat about\b/.test(t) && /\b(org|chart|hierarchy)\b/.test(t)) ||
    (/\balternative interpretation\b/.test(t) && !/\b(title|designation)\b/.test(t))
  ) {
    return 'OrgManager';
  }
  return null;
}

/**
 * Format proactive dual manager answer for the LLM context layer.
 * @param {{ positions?: object, org?: object, designation?: object, designationPhrase?: string }} payload
 * @returns {string}
 */
export function formatProactiveManagerAnswer({
  positions = {},
  org = {},
  designation = {},
  designationPhrase = 'Manager',
} = {}) {
  const posRecords = positions.records || positions.positions || [];
  const posNames = posRecords
    .map((r) => r.headName || r.name)
    .filter(Boolean);
  const orgNames = (org.records || []).map((r) => r.name).filter(Boolean);
  const desigNames = (designation.records || []).map((r) => r.name).filter(Boolean);
  const posLine =
    `**Manager positions (Org Chart, OrgUnit.type=manager):** ${positions.count ?? positions.total ?? 0}` +
    (posNames.length ? ` — ${posNames.join(', ')}` : '');
  const orgLine =
    `**People with direct reports (leadership chain):** ${org.total ?? 0}` +
    (orgNames.length ? ` — ${orgNames.join(', ')}` : '');
  const desigLine =
    `**Employees titled "${designationPhrase}":** ${designation.total ?? 0}` +
    (desigNames.length ? ` — ${desigNames.join(', ')}` : '');

  return (
    `${posLine}\n${orgLine}\n${desigLine}\n\n` +
    'Note: Manager **positions** are Org Chart cards (type=manager). ' +
    '"People with direct reports" counts ceo/manager/supervisor position heads with span — NOT department unit heads. ' +
    'Designation counts match job title only.'
  );
}

/**
 * Parse the user's clarification reply.
 * @param {string} text
 * @returns {ManagerMeaningId|null}
 */
export function parseManagerConceptChoice(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();

  if (/^(1|one|first|option\s*1)\b/.test(t)) return 'OrgManager';
  if (/^(2|two|second|option\s*2)\b/.test(t)) return 'DesignationManager';

  if (
    /\b(org(ani(s|z)ation(al)?)?|org(\s|-)?chart|hierarchy|reporting managers?|direct reports?|first one)\b/.test(t)
  ) {
    return 'OrgManager';
  }
  if (/\b(designation|title|job title|second one|by title)\b/.test(t)) {
    return 'DesignationManager';
  }
  if (/\borganizational managers?\b/.test(t)) return 'OrgManager';
  if (/\bemployees?\s+(with|by)\s+(designation|title)\b/.test(t)) return 'DesignationManager';
  return null;
}

/**
 * Build routing intent for a resolved manager meaning.
 * @param {ManagerMeaningId} meaning
 * @param {string} text
 * @returns {{ modules: string[], args: object }}
 */
export function buildManagerRoutingIntent(meaning, text = '') {
  const designationPhrase = extractDesignationPhrase(text) || 'Manager';
  if (meaning === 'OrgManager') {
    if (/\b(reports?\s+to|my manager|who is .+ manager|hierarchy|org chart|structure)\b/i.test(text)) {
      return { modules: ['org_structure_analytics'], args: { ...extractOrgStructureArgs(text), phrase: text } };
    }
    return { modules: ['org_manager_analytics'], args: { metric: 'org_managers', phrase: text } };
  }
  return {
    modules: ['fetch_employees'],
    args: {
      designation: designationPhrase,
      employmentStatus: 'active',
      phrase: text,
    },
  };
}
