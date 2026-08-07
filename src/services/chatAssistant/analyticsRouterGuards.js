/**
 * Epic A router guards — keep employee analytics off ATS funnel language,
 * and force clarification when "joined" is ambiguous.
 */

const FUNNEL_RE =
  /\b(referral\s+leads?|refer\s+leads?|hiring\s+(tunnel|funnel|pipeline)|candidate\s+pipeline|applicants?|applications?|offer\s+letters?|placements?|onboarding|bgv|background\s+verification)\b/i;

const EMPLOYEE_ANALYTICS_RE =
  /\b(resign(ed|ations?)?|left\s+(the\s+)?(company|org)|ex-?employees?|former\s+employees?|headcount|paid\s+employees?|unpaid\s+employees?|joining\s+date|joined\s+(this|last|in|during|before|after)|how\s+many\s+(employees?|staff).*(join|resign|paid|unpaid))\b/i;

const JOINED_AMBIGUOUS_RE =
  /\b(joined|joiners?|new\s+joiners?|who\s+joined|employees?\s+who\s+joined|joined\s+(this|last)\s+month|joined\s+in\s+\w+)\b/i;

const PLACEMENT_JOIN_HINT_RE =
  /\b(placement|placements|onboarding|bgv|hired|offer|candidate|referral)\b/i;

const EMPLOYMENT_JOIN_HINT_RE =
  /\b(employee|employees|joiningDate|joining\s+date|employment|staff|workforce|headcount)\b/i;

/**
 * True when the user is clearly asking about ATS funnel / referral leads —
 * must NOT be answered by employee_analytics (resign/join on Employee docs).
 */
export function isAtsFunnelQuery(text) {
  if (!text) return false;
  return FUNNEL_RE.test(text);
}

/**
 * True when the message looks like an employee analytics ask
 * (resign / join / paid-unpaid / headcount with employment flavour).
 */
export function looksLikeEmployeeAnalytics(text) {
  if (!text) return false;
  if (isAtsFunnelQuery(text) && !EMPLOYMENT_JOIN_HINT_RE.test(text)) return false;
  return EMPLOYEE_ANALYTICS_RE.test(text);
}

/**
 * Ambiguous "joined this month" — employment join vs placement Joined vs Hired.
 * @returns {{ needsClarification: true, clarifyingQuestion: string } | null}
 */
export function clarifyAmbiguousJoined(text) {
  if (!text) return null;
  if (!JOINED_AMBIGUOUS_RE.test(text)) return null;

  const hasPlacement = PLACEMENT_JOIN_HINT_RE.test(text);
  const hasEmployment = EMPLOYMENT_JOIN_HINT_RE.test(text);

  // Explicit placement/hire language → not an employee_analytics problem.
  if (hasPlacement && !hasEmployment) return null;
  // Explicit employment language without placement → ok to proceed.
  if (hasEmployment && !hasPlacement) return null;

  // Bare "joined" / mixed signals → clarify.
  return {
    needsClarification: true,
    clarifyingQuestion:
      'Just to confirm — do you mean employees whose **employment joining date** falls in that period, ' +
      'people whose **placement status is Joined**, or candidates marked **Hired** on an application?',
  };
}

/**
 * Block employee_analytics when the ask is clearly funnel/refer-lead.
 * @returns {{ block: true, reason: string, preferModules: string[] } | null}
 */
export function guardEmployeeAnalyticsRoute(text) {
  if (!text) return null;
  if (!isAtsFunnelQuery(text)) return null;
  // If they also said "resigned employees", allow employee path.
  if (/\bresign/i.test(text) && /\bemployee/i.test(text)) return null;
  return {
    block: true,
    reason:
      'ATS funnel / referral-lead questions must use referral / application / placement tools — not employee resign/join filters.',
    preferModules: ['fetch_candidates', 'fetch_job_applications', 'fetch_placements', 'fetch_offers'],
  };
}
