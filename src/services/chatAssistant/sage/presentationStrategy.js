// Intent → presentation mode for Sage person-profile replies.
// entityType (user/employee record) stays separate from business role labels.

const FULL_PROFILE_RE =
  /\b(everything|full\s+profile|complete\s+profile|entire\s+profile|all\s+(?:the\s+)?(?:details|info|information|fields)|show\s+(?:me\s+)?(?:all\s+)?details)\b/i;
const LIST_RE =
  /\b(list|who are|show all|show me all|give me all|enumerate)\b/i;
const ANYTHING_ELSE_RE =
  /\b(anything else|what else|do you know (?:anything )?else|what (?:else|more) do you know|tell me more|know more|anything more)\b/i;
const ACKNOWLEDGMENT_RE =
  /\b(this one|that one|yes(?:\s+him|\s+her|\s+them)?|that'?s (?:the one|him|her)|that is (?:the one|him|her))\b/i;

const SINGLE_FACT_CONTEXT_RE =
  /\b(what|how|tell|show|give|email|phone|salary|department|designation|join|resign|manager|location|role|status|his|her|their)\b/i;

const FIELD_PATTERNS = Object.freeze({
  email:      /\b(e-?mail|mail address)\b/i,
  phone:      /\b(phone|mobile|contact number)\b/i,
  salaryRange: /\b(salary|compensation|pay|lpa)\b/i,
  department: /\b(department|dept)\b/i,
  designation: /\b(designation|title|job title|position)\b/i,
  qualifications: /\b(education|qualification|qualifications|studied|university|college)\b/i,
  experiences: /\b(experience|work history|previous (?:job|role|company)|career)\b/i,
  skills: /\b(skills?|expertise|proficien)\b/i,
  documents: /\b(documents?|resume|cv|certificates?)\b/i,
  salarySlips: /\b(salary slip|payslip|pay slip)\b/i,
  recruiterNotes: /\b(notes?|recruiter notes?)\b/i,
  degree: /\b(degree|major)\b/i,
  joiningDate: /\b(join(?:ing)? date|date of join|started|start date)\b/i,
  resignDate: /\b(resign(?:ation)? date|exit date|left|leaving)\b/i,
  employmentStatus: /\b(employment status|working|resigned|active employee)\b/i,
  reportingManager: /\b(reporting manager|manager|supervisor)\b/i,
  location:   /\b(location|city|where (?:do|does) .* live)\b/i,
  employeeId: /\b(employee id|emp id|dbs\d+)\b/i,
  role:       /\b(role|position)\b/i,
});

/**
 * @param {string} message
 * @returns {string|null}
 */
export function detectTargetField(message) {
  const text = String(message || '');
  for (const [key, re] of Object.entries(FIELD_PATTERNS)) {
    if (re.test(text)) return key;
  }
  return null;
}

/**
 * @param {string} message
 * @param {{
 *   selectionKind?: 'select'|'reask'|'cancel'|'unrelated',
 *   hasPriorCommunication?: boolean,
 *   hasSubject?: boolean,
 *   depth?: 'brief'|'full',
 * }} [ctx]
 * @returns {{ intent: string, mode: string, field?: string|null }}
 */
export function detectPresentationIntent(message, ctx = {}) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();

  if (ctx.selectionKind === 'select' || ACKNOWLEDGMENT_RE.test(text)) {
    return { intent: 'acknowledgment', mode: 'conversation' };
  }

  if (
    ANYTHING_ELSE_RE.test(text) &&
    ctx.hasPriorCommunication &&
    ctx.hasSubject
  ) {
    return { intent: 'anything_else', mode: 'conversation' };
  }

  if (FULL_PROFILE_RE.test(text) || ctx.depth === 'full') {
    return { intent: 'full_profile', mode: 'profile' };
  }

  if (LIST_RE.test(text)) {
    return { intent: 'list', mode: 'list' };
  }

  const field = detectTargetField(text);
  const asksAboutSubject =
    ctx.hasSubject ||
    /\b(his|her|their|what about|how about)\b/i.test(lower);
  if (field && asksAboutSubject && SINGLE_FACT_CONTEXT_RE.test(lower)) {
    return { intent: 'single_fact', mode: 'single_fact', field };
  }

  return { intent: 'conversation', mode: 'conversation' };
}

/** Table blocks attach only for explicit structured modes. */
export function shouldAttachTableBlocks(mode) {
  return mode === 'profile' || mode === 'list' || mode === 'table' || mode === 'comparison';
}

/**
 * Suppress fetch_employees person-search tables on conversational turns.
 * @param {object|null} fetched
 * @param {string} mode
 */
export function shouldSuppressPersonSearchTable(fetched, mode) {
  if (shouldAttachTableBlocks(mode)) return false;
  const data = fetched?.fetch_employees;
  if (!data?.isPersonSearch) return false;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return total === 1;
}

/**
 * @param {object[]} blocks
 * @param {object|null} fetched
 * @param {string} mode
 */
export function filterBlocksForPresentation(blocks, fetched, mode) {
  if (!shouldSuppressPersonSearchTable(fetched, mode)) return blocks;
  return (blocks || []).filter((b) => b?.type !== 'table');
}
