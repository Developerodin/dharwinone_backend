import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import EmployeeModel from '../../../../../../models/employee.model.js';
import UserModel from '../../../../../../models/user.model.js';
import ProjectModel from '../../../../../../models/project.model.js';
import { getProjectById as realGetProjectById, updateProjectById as realUpdateProjectById } from '../../../../../project.service.js';
import {
  countActiveProjectsByAssignee as realCountActiveProjects,
  isAtProjectCapacity,
  MAX_ACTIVE_PROJECTS_PER_ASSIGNEE,
  ACTIVE_PROJECT_STATUSES,
} from '../../../../../projectCapacity.js';
import { resolveRowScope as realResolveRowScope } from '../../../../toolAccess.js';
import { resolveProjectByNameOrId as realResolveProject } from '../../../../projectGraph.resolvers.js';
import {
  HEX_ID_RE, MAX_PEOPLE, actorOf, idOf, escapeRegex, nameList, recheckSameDraft,
} from './common.js';

// project.route.js PATCH /projects/:projectId — requirePermissions('projects.manage').
// canManageProject also accepts that permission, so the route's check is the effective gate.
export const ALLOCATE_ACCESS = Object.freeze({ allOf: ['projects.manage'] });

const NOTICE_TITLE = 'Project assigned';

function allocateDeps(ctx) {
  const d = ctx?.deps || {};
  return {
    Employee: d.Employee ?? EmployeeModel,
    User: d.User ?? UserModel,
    Project: d.Project ?? ProjectModel,
    resolveProject: d.resolveProject ?? realResolveProject,
    resolveRowScope: d.resolveRowScope ?? realResolveRowScope,
    countActiveProjects: d.countActiveProjects ?? realCountActiveProjects,
    getProjectById: d.getProjectById ?? realGetProjectById,
    updateProjectById: d.updateProjectById ?? realUpdateProjectById,
  };
}

const lean = (q) => (q && typeof q.lean === 'function' ? q.lean() : q);

function toPerson(row) {
  return {
    userId: String(row.owner ?? row._id),
    name: row.fullName || row.name || 'Unknown',
    employeeId: row.employeeId ?? null,
  };
}

function pickRows(rows, query) {
  const exact = new RegExp(`^${escapeRegex(query)}$`, 'i');
  const exactRows = rows.filter((r) =>
    exact.test(r.fullName || r.name || '') || exact.test(r.employeeId || '') || exact.test(r.email || ''));
  const pool = exactRows.length ? exactRows : rows;
  if (pool.length > 1) {
    const shown = pool.slice(0, 5).map((r) => {
      const name = r.fullName || r.name || 'Unknown';
      return r.employeeId ? `${name} (${r.employeeId})` : name;
    });
    return { error: `${pool.length} people match "${query}". Say which one: ${shown.join('; ')}.` };
  }
  return { person: toPerson(pool[0]) };
}

async function findEmployees(deps, filter) {
  const rows = await lean(deps.Employee.find(filter).select('fullName employeeId owner email').limit(8));
  return rows || [];
}

/**
 * One person, inside the Employees-page row scope (resolveRowScope). A person the viewer
 * cannot see is refused and never becomes a target. Unrestricted viewers (scope null) may
 * also match a login that has no employee profile, because project assignees are user ids.
 */
async function findPerson(raw, scope, deps) {
  const q = String(raw).trim();
  const inScope = (ownerId) => scope == null || scope.has(String(ownerId));

  if (HEX_ID_RE.test(q)) {
    const rows = await findEmployees(deps, { $or: [{ owner: q }, { _id: q }] });
    const emp = rows[0];
    if (emp) {
      if (!emp.owner) return { error: `${emp.fullName || 'This person'} has no DharwinOne login, so they cannot be a project assignee.` };
      if (!inScope(emp.owner)) return { error: '1 person is outside your scope.' };
      return { person: toPerson(emp) };
    }
    const user = await lean(deps.User.findById(q).select('name email'));
    if (user && (scope == null || scope.has(q))) return { person: toPerson({ _id: q, name: user.name, email: user.email }) };
    if (user) return { error: '1 person is outside your scope.' };
    return { error: 'No person found with that id.' };
  }

  const exact = new RegExp(`^${escapeRegex(q)}$`, 'i');
  const loose = new RegExp(escapeRegex(q), 'i');
  const nameFilter = {
    $or: [{ fullName: loose }, { employeeId: exact }, { email: exact }],
  };
  const scopedFilter = scope ? { ...nameFilter, owner: { $in: [...scope] } } : { ...nameFilter, owner: { $ne: null } };
  const visible = await findEmployees(deps, scopedFilter);
  if (visible.length) return pickRows(visible, q);

  const any = await findEmployees(deps, nameFilter);
  if (any.some((e) => e.owner && !inScope(e.owner))) return { error: `"${q}" is outside the employees you can see.` };
  if (any.some((e) => !e.owner)) return { error: `"${q}" has no DharwinOne login, so they cannot be a project assignee.` };

  if (scope == null) {
    const users = await lean(deps.User.find({ $or: [{ name: loose }, { email: exact }] }).select('name email').limit(6));
    if (users?.length) return pickRows(users, q);
  }
  return { error: `No employee you can see matches "${q}".` };
}

async function resolveProject(text, user, deps) {
  const found = await deps.resolveProject(text, user);
  if (found?.kind === 'ambiguous') {
    const shown = (found.matches || []).slice(0, 5).map((p) => `${p.name || 'Untitled'} (id ${idOf(p)})`);
    return { error: `${found.matches.length} projects match "${text}". Say which one: ${shown.join('; ')}.` };
  }
  if (found?.kind === 'found' && found.project) return { project: found.project };
  const exists = HEX_ID_RE.test(text)
    ? await deps.Project.exists({ _id: text })
    : await deps.Project.exists({ name: new RegExp(`^${escapeRegex(text)}$`, 'i') });
  return { error: exists ? '1 project is outside your scope.' : `No project you can see matches "${text}".` };
}

function assigneeIds(project) {
  return [...new Set((project?.assignedTo || []).map(idOf).filter(Boolean))];
}

async function prepare({ people, project }, ctx) {
  const { user } = actorOf(ctx);
  const deps = allocateDeps(ctx);
  const scope = await deps.resolveRowScope(user);

  const resolved = [];
  const issues = [];
  const seen = new Set();
  for (const raw of people) {
    const found = await findPerson(raw, scope, deps);
    if (found.error) issues.push(found.error);
    else if (!seen.has(found.person.userId)) {
      seen.add(found.person.userId);
      resolved.push(found.person);
    }
  }
  const proj = await resolveProject(project, user, deps);
  if (issues.length || proj.error) return { ok: false, error: [...issues, proj.error].filter(Boolean).join(' ') };

  const current = new Set(assigneeIds(proj.project));
  const already = resolved.filter((p) => current.has(p.userId));
  const fresh = resolved.filter((p) => !current.has(p.userId));
  if (!fresh.length) {
    return { ok: false, error: `Already on "${proj.project.name}": ${nameList(already)}. Nobody new to add.` };
  }

  const counts = await deps.countActiveProjects(fresh.map((p) => p.userId), { excludeProjectId: idOf(proj.project) });
  const blocked = fresh.filter((p) => isAtProjectCapacity(counts.get(p.userId) ?? 0, { alreadyOnProject: false }));
  if (blocked.length) {
    const why = blocked.map((p) => `${p.name} is already on ${counts.get(p.userId) ?? 0} other active projects`).join('; ');
    return { ok: false, error: `Cannot allocate: ${why}. The limit is ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}.` };
  }

  const projectName = proj.project.name || 'this project';
  const status = proj.project.status || null;
  const lines = [
    `Add ${nameList(fresh)} to project "${projectName}"${status ? ` (${status})` : ''}.`,
    `Each person added becomes a project assignee and gets an in-app notification "${NOTICE_TITLE}" — ` +
      `"You have been assigned to project \\"${projectName}\\"." No email is sent.`,
  ];
  if (status && !ACTIVE_PROJECT_STATUSES.includes(status)) {
    lines.push(`Note: "${projectName}" is ${status}. The ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}-active-project limit still applies.`);
  }
  if (already.length) lines.push(`Skipped — already on "${projectName}", not notified again: ${nameList(already)}.`);

  return {
    ok: true,
    summary: {
      title: `Add ${fresh.length === 1 ? fresh[0].name : `${fresh.length} people`} to ${projectName}`,
      lines,
      targetCount: fresh.length,
      targets: fresh.map((p) => ({ id: p.userId, name: p.name })),
      confirmLabel: 'Allocate to project',
    },
    payload: { projectId: idOf(proj.project), userIds: fresh.map((p) => p.userId) },
  };
}

async function commit(draft, ctx) {
  const { user } = actorOf(ctx);
  const deps = allocateDeps(ctx);
  const { projectId, userIds } = draft.payload;
  const project = await deps.getProjectById(projectId);
  if (!project) return { ok: false, message: 'Project not found.' };

  const current = assigneeIds(project);
  const currentSet = new Set(current);
  const wanted = (userIds || []).map(String);
  const already = wanted.filter((id) => currentSet.has(id));
  const fresh = wanted.filter((id) => !currentSet.has(id));
  if (!fresh.length) {
    return { ok: true, message: 'Already allocated — nobody new was added.', details: { skipped: true, alreadyAllocated: already } };
  }

  const counts = await deps.countActiveProjects(fresh, { excludeProjectId: projectId });
  const blocked = fresh.filter((id) => isAtProjectCapacity(counts.get(id) ?? 0, { alreadyOnProject: false }));
  const allowed = fresh.filter((id) => !blocked.includes(id));
  if (!allowed.length) {
    const names = await namesFor(blocked, deps);
    return {
      ok: false,
      message: `Nobody was added. At the ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}-active-project limit: ${names.join(', ')}.`,
      details: { skippedUserIds: blocked },
    };
  }

  // updateProjectById replaces assignedTo. Merge so people already on the project stay.
  // ponytail: two confirms at once can each read the roster and overwrite the other. The upgrade
  // is $addToSet in project.service. One confirm re-reads and skips anyone already allocated.
  await deps.updateProjectById(projectId, { assignedTo: [...current, ...allowed] }, user);
  const extra = [];
  if (already.length) extra.push(`${already.length} already on the project`);
  if (blocked.length) extra.push(`${blocked.length} skipped — at the ${MAX_ACTIVE_PROJECTS_PER_ASSIGNEE}-active-project limit`);
  return {
    ok: true,
    message: `Added ${allowed.length === 1 ? '1 person' : `${allowed.length} people`} to the project.${extra.length ? ` ${extra.join('; ')}.` : ''}`,
    details: { addedUserIds: allowed, alreadyAllocated: already, skippedUserIds: blocked },
  };
}

async function namesFor(ids, deps) {
  const rows = await lean(deps.Employee.find({ owner: { $in: ids } }).select('fullName owner'));
  const byOwner = new Map((rows || []).map((r) => [String(r.owner), r.fullName]));
  return ids.map((id) => byOwner.get(String(id)) || id);
}

export default defineTool({
  name: 'allocate_to_project',
  domain: 'actions',
  kind: 'write',
  description:
    'Draft adding named people to one project (the Projects page assignee list). Only drafts: the user must ' +
    'press Confirm. Refuses anyone who would go over the max-2 active projects rule. People must be named ' +
    'one by one — never "everyone" or a team. Use only when the user asks to allocate / assign / add people ' +
    'to a project. A question about whether someone can be added is get_allocation, not this.',
  input: Joi.object({
    people: Joi.array().items(Joi.string().trim().min(1).max(120)).min(1).max(MAX_PEOPLE).unique().required()
      .description('Names, emails, employee ids, or user ids of the people to add, one per entry. At most 10.'),
    project: Joi.string().trim().min(1).max(200).required()
      .description('Project name or id.'),
  }),
  access: ALLOCATE_ACCESS,
  maxTargets: MAX_PEOPLE,
  prepare,
  recheck: recheckSameDraft(prepare),
  commit,
});
