import { listRoleSlugs, resolveRole as registryResolveRole } from './roleRegistry.js';

const VALID_SCOPES = ['active', 'resigned', 'all'];

export const CLASSIFIER_DEFAULT = {
  role: null,
  employmentScope: 'active',
  search: null,
  continuation: false,
  ambiguous: true,
  confidence: 0,
  clarifyingQuestion: 'Which role did you mean?',
};

const FALLBACK_HINT_ROLES = ['Employee', 'Agent', 'Recruiter', 'Administrator', 'Student'];

/**
 * Build the classifier system prompt. `roleSlugs` is the live registry
 * snapshot; when omitted, a minimal fallback hint keeps the prompt sensible
 * (legacy tests + degraded environments). Sync so callers can pre-load the
 * registry once and reuse the prompt.
 */
export function buildClassifierPrompt({ lastEntities, lastListing, roleSlugs = null }) {
  const list = Array.isArray(roleSlugs) && roleSlugs.length ? roleSlugs : null;

  const universeBlock = list
    ? [
        'Roles (use the slug):',
        ...list.map((r) =>
          `  - ${r.slug} (display: ${r.name}${r.aliases?.length ? `; aliases: ${r.aliases.join(', ')}` : ''})`
        ),
      ].join('\n')
    : [
        `Roles (exact spelling): ${FALLBACK_HINT_ROLES.join(', ')}.`,
        'Aliases: candidate / applicant → Employee. sales agent / sales_agent → Agent. admin → Administrator.',
      ].join('\n');

  const lines = [
    'You classify HR queries into structured JSON. Output JSON only — no prose, no markdown.',
    '',
    universeBlock,
    '',
    'employmentScope values: "active" (current), "resigned" (retired/former/ex/past/left collapse here), "all" (both).',
    '',
    'Set ambiguous=true (and provide clarifyingQuestion) when:',
    '  - the query spans multiple roles ("list everyone", "all people"),',
    '  - no role can be inferred,',
    '  - confidence < 0.6.',
    '',
    'continuation=true ONLY when the user says "next", "more", "show more", "continue" AND lastListing is present.',
    '',
    'JSON schema:',
    '{ "role": <slug|null>, "employmentScope": <scope>, "search": <string|null>,',
    '  "continuation": <bool>, "ambiguous": <bool>, "confidence": <0..1>, "clarifyingQuestion": <string|null> }',
  ];
  if (lastEntities) lines.push('', 'lastEntities: ' + JSON.stringify(lastEntities));
  if (lastListing) {
    lines.push('', 'lastListing: ' + JSON.stringify({
      role: lastListing.role,
      employmentScope: lastListing.employmentScope,
      total: lastListing.total,
    }));
  }

  const clarifyHint = list
    ? `Did you mean ${list.map((r) => r.name).slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''}?`
    : `Did you mean ${FALLBACK_HINT_ROLES.join(', ')}?`;

  return { system: lines.join('\n'), clarifyHint };
}

/**
 * Parse a classifier completion. Caller may supply `validRoleSlugs` (a Set
 * of lowercased slugs) to enforce the role universe; when omitted, validation
 * still rejects roles outside the legacy fallback list so behaviour remains
 * conservative.
 */
export function parseClassifierResponse(raw, { validRoleSlugs = null, fallbackClarify = null } = {}) {
  let obj;
  try {
    obj = JSON.parse(String(raw).trim());
  } catch {
    return { ...CLASSIFIER_DEFAULT, clarifyingQuestion: fallbackClarify || CLASSIFIER_DEFAULT.clarifyingQuestion };
  }
  if (typeof obj !== 'object' || obj === null) {
    return { ...CLASSIFIER_DEFAULT, clarifyingQuestion: fallbackClarify || CLASSIFIER_DEFAULT.clarifyingQuestion };
  }

  const validator = validRoleSlugs
    ? (v) => validRoleSlugs.has(String(v).toLowerCase())
    : (v) => FALLBACK_HINT_ROLES.includes(v);

  const role = obj.role && validator(obj.role) ? obj.role : null;
  const employmentScope = VALID_SCOPES.includes(obj.employmentScope) ? obj.employmentScope : 'active';
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  const continuation = !!obj.continuation && !!role;
  const search = typeof obj.search === 'string' && obj.search.trim() ? obj.search.trim() : null;

  let ambiguous = !!obj.ambiguous;
  if (!continuation && !role) ambiguous = true;
  if (confidence < 0.6) ambiguous = true;

  return {
    role,
    employmentScope,
    search,
    continuation,
    ambiguous,
    confidence,
    clarifyingQuestion: ambiguous
      ? (obj.clarifyingQuestion || fallbackClarify || CLASSIFIER_DEFAULT.clarifyingQuestion)
      : null,
  };
}

export async function classifyRole({ openai, userTurn, history, lastEntities, lastListing }) {
  let roleSlugs = null;
  try {
    roleSlugs = await listRoleSlugs();
  } catch {
    /* registry unavailable — fall through with null */
  }
  const { system, clarifyHint } = buildClassifierPrompt({ lastEntities, lastListing, roleSlugs });
  const validRoleSlugs = roleSlugs && roleSlugs.length
    ? new Set(roleSlugs.map((r) => r.slug.toLowerCase()))
    : null;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...history.slice(-3),
        { role: 'user', content: userTurn },
      ],
    });
    const raw = completion?.choices?.[0]?.message?.content || '';
    const out = parseClassifierResponse(raw, { validRoleSlugs, fallbackClarify: clarifyHint });

    // Allow alias / display-name input by post-resolving through the registry.
    if (out.role && validRoleSlugs && !validRoleSlugs.has(String(out.role).toLowerCase())) {
      try {
        const r = await registryResolveRole(out.role);
        if (r.canonical) out.role = r.canonical;
        else { out.role = null; out.ambiguous = true; }
      } catch {
        out.role = null;
        out.ambiguous = true;
      }
    }
    return out;
  } catch {
    return { ...CLASSIFIER_DEFAULT };
  }
}
