// uat.dharwin.backend/src/services/chatAssistant/factExtractor.js
//
// Strip authoritative numeric facts from a `fetched` blob produced by
// chatAssistant.service.js#executeFetches. Returns the same data the
// summariser already serialises into the prompt — but in a structured
// shape factRenderer + responseValidator can compare against the LLM
// reply.
//
// Returned shape:
//   {
//     counts: [
//       { kind, label, total, role?, date?, status?, breakdown? },
//       ...
//     ],
//     primary: { ...one of the counts above } | null
//   }

function readEmployees(fetched) {
  const data = fetched?.fetch_employees;
  if (!data || data.notFound) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);

  // PRIMARY: trust the requestedRole the handler tagged on the result. This
  // is what the caller actually asked for — never inferred from records.
  // Multi-role users (Employee + Agent) used to defeat record-derived role
  // detection, causing the renderer to label agent counts as "employees".
  let role = data.requestedRole || null;

  // FALLBACK: only when handler didn't tag a role (legacy paths) — try to
  // infer from records' roleNames when every record carries the same single
  // role. Skip "Employee" / "Candidate" since they are the catch-all label.
  if (!role && Array.isArray(data.records) && data.records.length) {
    const first = data.records[0];
    if (Array.isArray(first.roleNames) && first.roleNames.length === 1) {
      const candidate = first.roleNames[0];
      if (candidate && !/^(employee|candidate)$/i.test(candidate)) role = candidate;
    }
  }

  // Distinguish a generic "employees" headcount from a role-scoped count.
  // When role is a real role (Agent / Recruiter / etc.) we treat the
  // population as role-specific; otherwise fall through to generic label.
  const isGenericEmployeeQuery = !role || /^(employee|candidate)$/i.test(role);
  return {
    kind: 'fetch_employees',
    label: isGenericEmployeeQuery ? 'employees' : role.toLowerCase() + 's',
    role: isGenericEmployeeQuery ? null : role,
    total,
    breakdown: data.employmentBreakdown || null,
    requestedRole: data.requestedRole || null,
  };
}

function readPeople(fetched) {
  const data = fetched?.fetch_people;
  if (!data || data.notFound) return null;
  const total = Number(data?.page?.total ?? data?.records?.length ?? 0);
  return { kind: 'fetch_people', label: 'people', total };
}

function readAttendanceSummary(fetched) {
  const data = fetched?.fetch_attendance_summary;
  if (!data || data.notFound || data.needsTimeWindow) return null;
  const days = data.perDay || [];
  if (days.length === 1) {
    const d = days[0];
    return {
      kind: 'attendance_summary_day',
      label: 'attendance summary',
      total: data.total,
      date: d.date,
      counts: d.counts,
    };
  }
  return {
    kind: 'attendance_summary_range',
    label: 'attendance summary',
    total: data.total,
    perDay: days,
  };
}

function readLeaveRequests(fetched) {
  const data = fetched?.fetch_leave_requests;
  if (!data || data.notFound) return null;
  return {
    kind: 'fetch_leave_requests',
    label: 'leave requests',
    total: Number(data.total ?? 0),
    breakdown: data.breakdown || null,
    typeBreakdown: data.typeBreakdown || null,
    statusFilter: data.statusFilter || null,
  };
}

function readBackdated(fetched) {
  const data = fetched?.fetch_backdated_attendance_requests;
  if (!data || data.notFound) return null;
  return {
    kind: 'fetch_backdated_attendance_requests',
    label: 'backdated attendance requests',
    total: Number(data.total ?? 0),
    breakdown: data.breakdown || null,
  };
}

function readJobs(fetched) {
  const data = fetched?.fetch_jobs;
  if (!data) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return { kind: 'fetch_jobs', label: 'jobs', total };
}

function readCandidates(fetched) {
  const data = fetched?.fetch_candidates;
  if (!data) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return { kind: 'fetch_candidates', label: 'candidates', total };
}

function readRoles(fetched) {
  const data = fetched?.fetch_roles;
  if (!data) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return { kind: 'fetch_roles', label: 'roles', total };
}

function readPlacements(fetched) {
  const data = fetched?.fetch_placements;
  if (!data) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return { kind: 'fetch_placements', label: 'placements', total };
}

function readOffers(fetched) {
  const data = fetched?.fetch_offers;
  if (!data) return null;
  const total = Number(data.total ?? data.records?.length ?? 0);
  return { kind: 'fetch_offers', label: 'offers', total };
}

/**
 * @param {object} fetched - output of executeFetches
 * @param {string} [lastUserMsg] - last user message, used to bias the
 *   "primary" pick toward whatever the user actually asked for.
 */
export function extractFacts(fetched, lastUserMsg = '') {
  const counts = [];
  const push = (f) => { if (f) counts.push(f); };
  push(readEmployees(fetched));
  push(readPeople(fetched));
  push(readAttendanceSummary(fetched));
  push(readLeaveRequests(fetched));
  push(readBackdated(fetched));
  push(readJobs(fetched));
  push(readCandidates(fetched));
  push(readRoles(fetched));
  push(readPlacements(fetched));
  push(readOffers(fetched));

  let primary = null;
  if (lastUserMsg && counts.length) {
    const txt = lastUserMsg.toLowerCase();
    primary =
      counts.find((c) => c.role && txt.includes(String(c.role).toLowerCase())) ||
      counts.find((c) => c.label && txt.includes(c.label.toLowerCase())) ||
      counts[0];
  } else {
    primary = counts[0] || null;
  }

  return { counts, primary };
}
