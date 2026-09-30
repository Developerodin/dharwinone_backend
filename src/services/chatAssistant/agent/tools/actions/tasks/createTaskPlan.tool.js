import Joi from 'joi';
import { defineTool } from '../../../defineTool.js';
import TaskBreakdownPreviewModel from '../../../../../../models/taskBreakdownPreview.model.js';
import {
  previewTaskBreakdown as realPreviewTaskBreakdown,
  applyTaskBreakdown as realApplyTaskBreakdown,
} from '../../../../../pmAssistant.service.js';
import { workScope, workDeps, idOf } from '../../projects/common.js';

// pmAssistant.route.js POST …/task-breakdown/apply is requirePermissions('projects.manage', 'tasks.manage').
// The preview route only needs projects.read, but a draft the viewer could never apply is pointless.
export const TASK_PLAN_ACCESS = Object.freeze({ allOf: ['projects.manage', 'tasks.manage'] });

// pmAssistant.validation.js applyTaskBreakdown caps tasks at 60; Sage calls the service directly, so
// the route's Joi never runs — enforce the same cap here.
const MAX_PLAN_TASKS = 60;
const TITLE_CAP = 60;

export const OWNER_ONLY_MESSAGE = "Only the project's creator or an administrator can plan its tasks with the PM assistant.";
export const PM_OFF_MESSAGE = 'The PM assistant is turned off, so Sage cannot draft a task plan.';
const STALE_PLAN_MESSAGE = 'This task plan is no longer available — ask Sage for a new one.';

const cap = (text, n) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const plural = (n) => (n === 1 ? 'task' : 'tasks');

function planDeps(ctx) {
  const deps = ctx?.deps || {};
  return {
    resolveProject: workDeps(ctx).resolveProject,
    previewTaskBreakdown: deps.previewTaskBreakdown ?? realPreviewTaskBreakdown,
    applyTaskBreakdown: deps.applyTaskBreakdown ?? realApplyTaskBreakdown,
    TaskBreakdownPreview: deps.TaskBreakdownPreview ?? TaskBreakdownPreviewModel,
    now: deps.now ?? (() => new Date()),
  };
}

/** The PM service's ApiErrors → a refusal Sage can say; null = unexpected, let it throw. */
function refusalFor(err) {
  const status = err?.statusCode;
  if (status === 403) return OWNER_ONLY_MESSAGE;
  // ensurePmAssistantEnabled → 404, ensureOpenAIConfigured → 503.
  if ((status === 404 && /PM assistant is disabled/i.test(err.message)) || status === 503) return PM_OFF_MESSAGE;
  if (status === 404) return 'That project no longer exists.';
  if (status >= 400 && status < 500) return err.message;
  return null;
}

export default defineTool({
  name: 'create_task_plan',
  domain: 'actions',
  kind: 'write',
  description:
    'Draft a task plan for one project with the PM assistant: it generates new tasks and shows them to the ' +
    'user, and nothing is created until the user presses Confirm. Use for "break project X into tasks", "plan ' +
    'the tasks for X", "create a task list for project X". Only the project creator or an admin can use it. ' +
    'Not for listing existing tasks, adding one specific task, or assigning people to tasks.',
  input: Joi.object({
    project: Joi.string().min(1).max(200).required().description('The project name or id, as the user said it.'),
    brief: Joi.string()
      .min(1)
      .max(2000)
      .description('Optional extra direction for the plan the user gave (scope, deliverables, focus).'),
  }),
  access: TASK_PLAN_ACCESS,
  // The preview is one LLM call (9000 max tokens); 15000 is defineTool's ceiling.
  timeoutMs: 15000,
  async prepare({ project, brief }, ctx) {
    const user = workScope(ctx);
    const deps = planDeps(ctx);

    // Row scope: only projects this viewer can see; anything else is refused by the name they typed.
    const res = await deps.resolveProject(project, user);
    if (res.kind === 'ambiguous') {
      const names = res.matches.slice(0, 5).map((p) => `"${p.name}"`).join(', ');
      return { ok: false, error: `More than one project matches "${project}": ${names}. Which one?` };
    }
    if (res.kind !== 'found') return { ok: false, error: `No project you can see matches "${project}".` };
    const projectId = idOf(res.project);
    const projectName = res.project.name || project;

    // ponytail: the one write a prepare may do. previewTaskBreakdown stores a TaskBreakdownPreview
    // (state open, 24 h TTL) — itself a draft artifact, like the SageAction row — and apply marks it
    // applied. If the 15 s timeout fires first, the LLM call still finishes and leaves an orphan
    // preview that the TTL removes; the draft is refused and the user asks again.
    let preview;
    try {
      preview = await deps.previewTaskBreakdown(projectId, user, { extraBrief: brief });
    } catch (err) {
      const refusal = refusalFor(err);
      if (refusal) return { ok: false, error: refusal };
      throw err;
    }

    const tasks = Array.isArray(preview?.tasks) ? preview.tasks : [];
    if (!tasks.length) return { ok: false, error: `The PM assistant suggested no new tasks for ${projectName}.` };
    if (tasks.length > MAX_PLAN_TASKS) {
      return {
        ok: false,
        error: `The plan has ${tasks.length} tasks; at most ${MAX_PLAN_TASKS} can be created at once. Ask for a smaller plan.`,
      };
    }

    return {
      ok: true,
      summary: {
        title: `Create ${tasks.length} ${plural(tasks.length)} in ${cap(projectName, TITLE_CAP)}`,
        lines: tasks.map((t) => cap(t.title, TITLE_CAP)),
        targetCount: 1,
        targets: [{ id: projectId, name: projectName }],
        confirmLabel: 'Create tasks',
      },
      payload: { projectId, previewId: preview.previewId, tasks },
    };
  },
  // Never re-run the preview on confirm: it is a fresh LLM call that would produce a different plan.
  async recheck({ payload }, ctx) {
    const user = workScope(ctx);
    const deps = planDeps(ctx);
    const snap = await deps.TaskBreakdownPreview.findOne({ previewId: payload?.previewId })
      .select('projectId userId state expiresAt')
      .lean();
    if (
      !snap ||
      String(snap.projectId) !== String(payload.projectId) ||
      String(snap.userId) !== String(user.id ?? user._id) ||
      !(snap.expiresAt > deps.now())
    ) {
      return { ok: false, error: STALE_PLAN_MESSAGE };
    }
    if (snap.state !== 'open') {
      return { ok: false, error: 'This task plan was already applied or replaced — ask Sage for a new one.' };
    }
    return { ok: true };
  },
  async commit({ key, summary, payload }, ctx) {
    const user = workScope(ctx);
    const deps = planDeps(ctx);
    const { projectId, previewId, tasks } = payload;
    let res;
    try {
      // The SageAction key doubles as the apply idempotency key: a replay returns the stored response.
      res = await deps.applyTaskBreakdown(projectId, user, { tasks, previewId, idempotencyKey: key });
    } catch (err) {
      const refusal = refusalFor(err);
      if (refusal) return { ok: false, message: refusal };
      throw err;
    }
    const created = res?.createdCount ?? 0;
    const projectName = summary?.targets?.[0]?.name ?? 'the project';
    return { ok: true, message: `Created ${created} ${plural(created)} in ${projectName}.`, details: { projectId, createdCount: created } };
  },
});
