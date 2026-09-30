import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { peopleScope, peopleDeps } from './common.js';
import { PERMISSION_MODULES } from './permissionCatalog.js';

const VERBS = { view: 'view', create: 'add', edit: 'edit', delete: 'delete' };
const VERB_ORDER = ['view', 'add', 'edit', 'delete'];
// Legacy colon-less Help & Support toggle, derived the same way by permission.service deriveApiPermissions.
const LEGACY = { 'devTickets.view': 'support.help-and-support:view' };

/** "ats.jobs:view,create" → { moduleId: 'ats', areaId: 'jobs', actions: ['view', 'add'] }; null when unparseable. */
function parsePermission(raw) {
  const p = LEGACY[raw] ?? String(raw).trim();
  const colon = p.indexOf(':');
  if (colon < 0) return null;
  const key = p.slice(0, colon);
  const dot = key.indexOf('.');
  if (dot <= 0 || dot === key.length - 1) return null;
  const actions = p.slice(colon + 1).split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!actions.length) return null;
  return { moduleId: key.slice(0, dot), areaId: key.slice(dot + 1), actions: actions.map((a) => VERBS[a] ?? a) };
}

const byVerbOrder = (a, b) => {
  const ia = VERB_ORDER.indexOf(a);
  const ib = VERB_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};

/** Raw role permissions → modules the caller has something in, in Roles-page order (unknown modules last). */
function groupCapabilities(permissions) {
  const held = new Map();
  for (const raw of permissions || []) {
    const parsed = parsePermission(raw);
    if (!parsed) continue;
    if (!held.has(parsed.moduleId)) held.set(parsed.moduleId, new Map());
    const areas = held.get(parsed.moduleId);
    if (!areas.has(parsed.areaId)) areas.set(parsed.areaId, new Set());
    parsed.actions.forEach((a) => areas.get(parsed.areaId).add(a));
  }
  const catalogIds = PERMISSION_MODULES.map((m) => m.id);
  const moduleIds = [...catalogIds.filter((id) => held.has(id)), ...[...held.keys()].filter((id) => !catalogIds.includes(id))];
  return moduleIds.map((id) => {
    const def = PERMISSION_MODULES.find((m) => m.id === id);
    const areas = [...held.get(id)].map(([areaId, actions]) => ({
      area: def?.areas[areaId] ?? areaId,
      can: [...actions].sort(byVerbOrder),
    }));
    return { module: def?.label ?? id, areas };
  });
}

export default defineTool({
  name: 'what_can_i_do',
  domain: 'people',
  kind: 'read',
  description:
    "The signed-in user's OWN access, grouped by module in plain words (e.g. ATS → Jobs: view, add). Use for " +
    '"what can I do", "what access do I have", "can I edit jobs", "what can\'t I see", "why can\'t I open X". ' +
    'Lists module names without access — never data from them. For another role\'s permissions use get_role.',
  input: Joi.object({}),
  access: { note: "self only — the caller's own role permissions (GET /auth/my-permissions)" },
  async execute(_args, ctx) {
    const user = peopleScope(ctx);
    const deps = peopleDeps(ctx);
    const mine = await deps.getMyPermissionsForFrontend(user);
    const fullAccess = !!mine?.isPlatformSuperUser;
    const modules = groupCapabilities(mine?.permissions);
    const heldLabels = new Set(modules.map((m) => m.module));
    return {
      roles: mine?.roleNames || [],
      fullAccess,
      modules,
      modulesWithoutAccess: fullAccess ? [] : PERMISSION_MODULES.map((m) => m.label).filter((l) => !heldLabels.has(l)),
      ...(user.__impersonating ? { impersonating: true } : {}),
      note:
        'Capabilities come from your roles. Some pages still narrow which records you see (for example only ' +
        'your own, or people assigned to you).',
    };
  },
  render(result) {
    if (!result?.modules) return null;
    const rows = result.modules.flatMap((m) => m.areas.map((a) => ({ module: m.module, area: a.area, can: a.can.join(', ') })));
    if (!rows.length) return { blocks: [] };
    return {
      blocks: [{
        type: 'table',
        id: 'my-access',
        tableType: 'my-access',
        title: 'What you can do',
        columns: [
          { key: 'module', label: 'Module', priority: 'primary' },
          { key: 'area', label: 'Area', priority: 'primary' },
          { key: 'can', label: 'You can', priority: 'primary' },
        ],
        rows,
        layout: 'auto',
      }],
    };
  },
});
