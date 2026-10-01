import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { PLACEMENT_STATUSES } from '../../../../../constants/atsPipeline.js';
import { checkAccessRule } from '../../../toolAccess.js';
import { PLACEMENTS_ACCESS, hiringScope } from './common.js';
import {
  detailDeps, placementSteps, firstBlockingStep, serviceMiss, idOf, NOT_CAPTURED, PLACEMENT_AUDIT_ACCESS,
  placementJoin,
} from './placementDetail.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const MAX_MATCHES = 6;
const MAX_AUDIT_ROWS = 20;

/**
 * The placement's audit trail (status changes, pre-boarding gate bypasses, compensation type changes), newest
 * first — only for viewers the audit route lets in (placement.audit / candidates.manage). The service applies
 * its own row access; values are status / compensation-type words, never amounts. undefined = not allowed.
 */
async function auditTrail(placementId, user, deps) {
  if (!(await checkAccessRule(PLACEMENT_AUDIT_ACCESS, user)).ok) return undefined;
  let rows;
  try {
    rows = await deps.listAuditForPlacementId(placementId, user);
  } catch (err) {
    if (err?.statusCode === 403 || err?.statusCode === 404) return undefined;
    throw err;
  }
  return (rows || []).slice(0, MAX_AUDIT_ROWS).map((r) => ({
    action: r.action ?? null,
    from: r.fromValue ?? null,
    to: r.toValue ?? null,
    by: r.actor?.name ?? null,
    at: r.createdAt ?? null,
  }));
}

/** Name → placement id through the placement list's own search and visibility (queryPlacements). */
async function resolvePlacementId(candidate, user, deps) {
  const search = String(candidate).trim();
  const res = await deps.queryPlacements(
    { search, status: PLACEMENT_STATUSES.join(',') },
    { page: 1, limit: MAX_MATCHES, sortBy: 'joiningDate:desc' },
    user,
  );
  const rows = res?.results || [];
  if (!rows.length) return { notFound: 'placement', searchedFor: search };
  const people = new Set(rows.map((p) => idOf(p.candidate)));
  if (people.size === 1) {
    const live = rows.find((p) => p.status !== 'Cancelled') || rows[0];
    return { id: idOf(live), otherPlacements: rows.length - 1 };
  }
  return {
    matches: rows.map((p) => ({
      id: idOf(p), candidate: p.candidate?.fullName ?? null, job: p.job?.title ?? null, status: p.status ?? null,
    })),
  };
}

/** Whether the candidate's own login (User with the profile's email) now holds the Employee role. */
async function holdsEmployeeRole(login, deps) {
  return login ? !!(await deps.userHasEmployeeRole(login)) : null;
}

export default defineTool({
  name: 'get_placement',
  domain: 'hiring',
  kind: 'read',
  description:
    'One person\'s placement end to end: pre-boarding checklist → background verification → assets / IT → ' +
    'onboarding checklist → joined, each with status and dates; department, assigned agent, whether their ' +
    'login now holds the Employee role, and the first step blocking them. Use for "where is X in onboarding", ' +
    '"what is holding up X", "has X\'s BGV been done", "is X an employee yet", "who changed X\'s placement ' +
    'status" (auditTrail — only for viewers with placement audit access). Pass id (from list_placements) ' +
    'or the candidate name.',
  input: Joi.object({
    id: Joi.string().min(1).max(64).description('Placement id from a list_placements record.'),
    candidate: Joi.string().min(1).max(120).description('Candidate name, email or employee id.'),
  }).or('id', 'candidate'),
  access: PLACEMENTS_ACCESS,
  async execute({ id, candidate } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);

    let placementId = id;
    let otherPlacements = 0;
    if (!placementId) {
      const r = await resolvePlacementId(candidate, user, deps);
      if (!r.id) return r;
      placementId = r.id;
      otherPlacements = r.otherPlacements;
    }
    if (!OBJECT_ID_RE.test(String(placementId))) return { notFound: 'placement' };

    let p;
    try {
      p = await deps.getPlacementById(placementId, user);
    } catch (err) {
      return serviceMiss(err, 'placement');
    }
    if (!p) return { notFound: 'placement' };
    if (typeof p.toJSON === 'function') p = p.toJSON();

    const candidateId = idOf(p.candidate);
    const profile = candidateId
      ? await deps.Employee.findById(candidateId).select('assignedAgent email').lean()
      : null;
    const agentId = idOf(profile?.assignedAgent);
    const email = profile?.email ?? p.candidate?.email ?? null;
    const [{ login, facts }, agent, audit] = await Promise.all([
      placementJoin(p, email, ctx),
      agentId ? deps.User.findById(agentId).select('name').lean() : null,
      auditTrail(placementId, user, deps),
    ]);
    const employeeRole = await holdsEmployeeRole(login, deps);
    const now = deps.now();

    return {
      id: idOf(p),
      candidate: p.candidate?.fullName ?? null,
      employeeId: p.employeeId ?? p.candidate?.employeeId ?? null,
      job: p.job?.title ?? null,
      offerCode: p.offer?.offerCode ?? null,
      status: p.status ?? null,
      ...facts,
      department: p.candidate?.department ?? null,
      designation: p.candidate?.designation ?? null,
      agentAssigned: agent?.name ?? null,
      holdsEmployeeRole: employeeRole,
      ...(employeeRole === null ? { employeeRoleNote: `no login account found for this candidate — ${NOT_CAPTURED}` } : {}),
      firstBlockingStep: firstBlockingStep(p, now),
      steps: placementSteps(p),
      ...(audit ? { auditTrail: audit } : {}),
      ...(otherPlacements ? { otherPlacements } : {}),
    };
  },
});
