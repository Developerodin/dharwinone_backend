import logger from '../config/logger.js';
import Employee from '../models/employee.model.js';
import Student from '../models/student.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import CandidateSopTemplate from '../models/candidateSopTemplate.model.js';

/**
 * Candidate first, then Student — avoids flicker when training profile sync lags behind Employee.
 * @param {import('../models/employee.model.js').default} candidate
 * @param {import('../models/student.model.js').default|null} student
 */
const ctxFromRecords = (candidate, student) => ({ candidate, student });

const checkProfileComplete = async ({ candidate }) =>
  Boolean(candidate?.isCompleted || candidate?.isProfileCompleted === 100);

const checkShiftAssigned = async ({ candidate, student }) =>
  Boolean(candidate?.shift || student?.shift);

const checkWeekoffAssigned = async ({ candidate, student }) => {
  const cw = Array.isArray(candidate?.weekOff) ? candidate.weekOff.length : 0;
  const sw = Array.isArray(student?.weekOff) ? student.weekOff.length : 0;
  return cw > 0 || sw > 0;
};

const checkHolidayAssigned = async ({ candidate, student }) => {
  const ch = Array.isArray(candidate?.holidays) ? candidate.holidays.length : 0;
  const sh = Array.isArray(student?.holidays) ? student.holidays.length : 0;
  return ch > 0 || sh > 0;
};

const checkAgentAssigned = async ({ candidate }) => Boolean(candidate?.assignedAgent);

const checkTrainingAssigned = async ({ student }) => {
  if (!student?._id) return false;
  const sid = student._id;
  if (await StudentCourseProgress.exists({ student: sid })) return true;
  // Assigned on module (enrollment) counts even before progress row exists
  return Boolean(await TrainingModule.exists({ students: sid }));
};

/** Phase 2 — no Candidate↔Project link; treat as satisfied for v1. */
const checkProjectAssigned = async () => true;

export const SOP_CHECKER_KEYS = new Set([
  'profile_complete',
  'shift_assigned',
  'weekoff_assigned',
  'holiday_assigned',
  'agent_assigned',
  'training_assigned',
  'project_assigned',
]);

const CHECKERS = {
  profile_complete: checkProfileComplete,
  shift_assigned: checkShiftAssigned,
  weekoff_assigned: checkWeekoffAssigned,
  holiday_assigned: checkHolidayAssigned,
  agent_assigned: checkAgentAssigned,
  training_assigned: checkTrainingAssigned,
  project_assigned: checkProjectAssigned,
};

export const DEFAULT_SOP_STEPS = () => [
  {
    checkerKey: 'profile_complete',
    label: 'Complete profile',
    description: 'Candidate has completed required profile sections.',
    sortOrder: 0,
    enabled: true,
    linkTemplate: '/ats/candidates/edit?id={{candidateId}}',
  },
  {
    checkerKey: 'agent_assigned',
    label: 'Assign Agent',
    description: 'Assign a training staff agent to this candidate.',
    sortOrder: 1,
    enabled: true,
    linkTemplate: '/ats/candidates/edit?id={{candidateId}}&assignAgent=1',
  },
  {
    checkerKey: 'shift_assigned',
    label: 'Assign shift',
    description: 'Assign work shift for attendance.',
    sortOrder: 2,
    enabled: true,
    linkTemplate:
      '/settings/attendance/assign-shift?candidateId={{candidateId}}&candidateName={{candidateName}}&studentId={{studentId}}',
  },
  {
    checkerKey: 'weekoff_assigned',
    label: 'Assign week-off',
    description: 'Configure week-off days.',
    sortOrder: 3,
    enabled: true,
    linkTemplate:
      '/settings/attendance/week-off?candidateId={{candidateId}}&candidateName={{candidateName}}&studentId={{studentId}}',
  },
  {
    checkerKey: 'holiday_assigned',
    label: 'Assign holiday',
    description: 'Assign applicable holidays.',
    sortOrder: 4,
    enabled: true,
    linkTemplate:
      '/settings/attendance/assign-holidays?candidateId={{candidateId}}&candidateName={{candidateName}}&studentId={{studentId}}',
  },
  {
    checkerKey: 'training_assigned',
    label: 'Assign training (course)',
    description: 'Enroll in at least one training module.',
    sortOrder: 5,
    enabled: true,
    linkTemplate: '/ats/candidates/edit?id={{candidateId}}&assignCourse=1',
  },
  {
    checkerKey: 'project_assigned',
    label: 'Assign project',
    description: 'Reserved — satisfied automatically until project linking exists.',
    sortOrder: 6,
    enabled: true,
    linkTemplate: '/projects',
  },
];

/**
 * Built-in deep links per checker. Used when rendering SOP links so stale template rows in DB
 * (e.g. week-off / holiday steps still using /ats/candidates/edit) do not send users to the wrong page.
 * @param {string} checkerKey
 * @returns {string|null}
 */
const canonicalLinkTemplateForChecker = (checkerKey) => {
  const k = (checkerKey || '').trim();
  const found = DEFAULT_SOP_STEPS().find((s) => s.checkerKey === k);
  return found?.linkTemplate ?? null;
};

/**
 * Substitute SOP link templates. Use encodeURIComponent for query values.
 * Placeholders: {{candidateId}}, {{candidateName}}, {{fullName}}, {{studentId}}
 */
function renderLink(template, { candidateId, fullName, studentId }) {
  if (!template || typeof template !== 'string') return '';
  const name = encodeURIComponent((fullName || '').trim());
  const sid = studentId ? String(studentId) : '';
  const cid = String(candidateId || '');
  return template
    .replace(/\{\{candidateId\}\}/g, encodeURIComponent(cid))
    .replace(/\{\{candidateName\}\}/g, name)
    .replace(/\{\{fullName\}\}/g, name)
    .replace(/\{\{studentId\}\}/g, encodeURIComponent(sid));
}

/**
 * Always append checklist context to internal links so older templates (plain paths) still deep-link.
 */
function mergeSopContextIntoUrl(href, { candidateId, fullName, studentId, ownerUserId }) {
  if (!href || typeof href !== 'string' || !href.startsWith('/')) return href;
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const noHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const qIdx = noHash.indexOf('?');
  const path = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const existingQs = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
  const params = new URLSearchParams(existingQs);
  params.set('candidateId', String(candidateId || ''));
  const trimmedName = (fullName || '').trim();
  if (trimmedName) params.set('candidateName', trimmedName);
  if (studentId) params.set('studentId', String(studentId));
  if (ownerUserId) params.set('ownerUserId', String(ownerUserId));
  const q = params.toString();
  return `${path}?${q}${hash}`;
}

/** SOP "Assign agent" opens candidate edit with assignAgent=1 so the UI can show the agent picker. */
function ensureAssignAgentQueryOnCandidateEdit(href) {
  if (!href || typeof href !== 'string') return href;
  if (!href.includes('/ats/candidates/edit')) return href;
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const noHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const qIdx = noHash.indexOf('?');
  const path = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const existingQs = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
  const params = new URLSearchParams(existingQs);
  params.set('assignAgent', '1');
  const q = params.toString();
  return `${path}?${q}${hash}`;
}

/** SOP "Assign training" opens candidate edit with assignCourse=1 so the UI can show the course picker. */
function ensureAssignCourseQueryOnCandidateEdit(href) {
  if (!href || typeof href !== 'string') return href;
  if (!href.includes('/ats/candidates/edit')) return href;
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const noHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const qIdx = noHash.indexOf('?');
  const path = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const existingQs = qIdx >= 0 ? noHash.slice(qIdx + 1) : '';
  const params = new URLSearchParams(existingQs);
  params.set('assignCourse', '1');
  const q = params.toString();
  return `${path}?${q}${hash}`;
}

/**
 * Ensure one active template exists (seed on cold DB).
 */
export const ensureDefaultActiveTemplate = async () => {
  const active = await CandidateSopTemplate.findOne({ isActive: true }).lean();
  if (active) return active;

  const latest = await CandidateSopTemplate.findOne().sort({ version: -1 }).lean();
  if (latest) {
    await CandidateSopTemplate.updateMany({}, { $set: { isActive: false } });
    await CandidateSopTemplate.updateOne({ _id: latest._id }, { $set: { isActive: true } });
    const reloaded = await CandidateSopTemplate.findById(latest._id).lean();
    logger.info('[SOP] No active template; reactivated latest version %s', latest.version);
    return reloaded;
  }

  await CandidateSopTemplate.updateMany({}, { $set: { isActive: false } });
  const steps = DEFAULT_SOP_STEPS();
  const doc = await CandidateSopTemplate.create({
    name: 'Default onboarding',
    version: 1,
    isActive: true,
    steps,
  });
  logger.info('[SOP] Seeded default CandidateSopTemplate v1');
  return doc.toObject();
};

/**
 * @returns {Promise<import('mongoose').LeanDocumentOrNull>}
 */
export const getActiveTemplateLean = async () => {
  let t = await CandidateSopTemplate.findOne({ isActive: true }).lean();
  if (!t) {
    t = await ensureDefaultActiveTemplate();
  }
  return t;
};

/**
 * Load candidate + student for SOP evaluation.
 */
export const loadSopContext = async (candidateId) => {
  const candidate = await Employee.findById(candidateId).lean();
  if (!candidate) return { candidate: null, student: null };
  const ownerId = candidate.owner;
  const student = ownerId
    ? await Student.findOne({ user: ownerId }).lean()
    : null;
  return { candidate, student };
};

/**
 * Skip noisy SOP for resigned / inactive candidates (product: no blocking checklist).
 */
export const shouldSkipSopForCandidate = (candidate) => {
  if (!candidate) return true;
  if (candidate.isActive === false) return true;
  if (candidate.resignDate) return true;
  return false;
};

/**
 * @param {string} candidateId
 * @returns {Promise<{ templateVersion: number, templateId: string, steps: Array, nextStep: object|null, completedCount: number, totalCount: number, skipped: boolean }>}
 */
export const evaluateSopForCandidate = async (candidateId) => {
  const template = await getActiveTemplateLean();
  const { candidate, student } = await loadSopContext(candidateId);

  if (!candidate) {
    return {
      templateVersion: template?.version ?? 0,
      templateId: template?._id ? String(template._id) : '',
      steps: [],
      nextStep: null,
      completedCount: 0,
      totalCount: 0,
      skipped: false,
    };
  }

  if (shouldSkipSopForCandidate(candidate)) {
    return {
      templateVersion: template?.version ?? 0,
      templateId: template?._id ? String(template._id) : '',
      steps: [],
      nextStep: null,
      completedCount: 0,
      totalCount: 0,
      skipped: true,
    };
  }

  const ctx = ctxFromRecords(candidate, student);
  const sortedSteps = [...(template.steps || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const stepResults = [];
  let nextStep = null;

  for (const step of sortedSteps) {
    if (!step.enabled) continue;
    const key = (step.checkerKey || '').trim();
    if (key === 'position_assigned') continue;
    if (key === 'recruiter_assigned') continue;
    const fn = CHECKERS[key];
    let done = false;
    if (!fn) {
      logger.warn(`[SOP] Unknown checkerKey skipped: ${key}`);
      done = false;
    } else {
      try {
        done = await fn(ctx);
      } catch (e) {
        logger.warn(`[SOP] Checker ${key} error: ${e?.message || e}`);
        done = false;
      }
    }

    const sid =
      student?._id != null
        ? String(student._id)
        : student?.id != null
          ? String(student.id)
          : '';
    const ownerRaw = candidate?.owner;
    const ownerUserId =
      ownerRaw && typeof ownerRaw === 'object' && ownerRaw._id != null
        ? String(ownerRaw._id)
        : ownerRaw != null
          ? String(ownerRaw)
          : '';
    const fullName = candidate?.fullName || '';
    const linkTemplateStr =
      canonicalLinkTemplateForChecker(key) ??
      (typeof step.linkTemplate === 'string' ? step.linkTemplate : '');
    const rawLink = renderLink(linkTemplateStr, {
      candidateId,
      fullName,
      studentId: sid,
    });
    let link = mergeSopContextIntoUrl(rawLink, {
      candidateId,
      fullName,
      studentId: sid,
      ownerUserId,
    });
    if (key === 'agent_assigned') {
      link = ensureAssignAgentQueryOnCandidateEdit(link);
    }
    if (key === 'training_assigned') {
      link = ensureAssignCourseQueryOnCandidateEdit(link);
    }
    const row = {
      checkerKey: key,
      label: step.label || key,
      description: step.description || '',
      done,
      sortOrder: step.sortOrder ?? 0,
      link,
    };
    stepResults.push(row);
    if (!done && !nextStep) {
      nextStep = { ...row };
    }
  }

  const totalCount = stepResults.length;
  const completedCount = stepResults.filter((s) => s.done).length;

  return {
    templateVersion: template.version,
    templateId: String(template._id),
    steps: stepResults,
    nextStep,
    completedCount,
    totalCount,
    skipped: false,
  };
};

/**
 * Count incomplete enabled steps (for list badges). Returns 0 if skipped or missing candidate.
 */
export const countOpenSopSteps = async (candidateId) => {
  const r = await evaluateSopForCandidate(candidateId);
  if (r.skipped || !r.steps.length) return 0;
  return r.steps.filter((s) => !s.done).length;
};

/**
 * For users with candidates.manage: scan current ATS candidates (same pool as list) and return those
 * with at least one incomplete step on the active SOP template.
 * @param {{ limit?: number }} opts - max candidates to scan (default 200, max 500)
 */
export const listSopOpenOverviewForManage = async ({ limit = 200 } = {}) => {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const activeTemplate = await getActiveTemplateLean();

  const { queryCandidates } = await import('./employee.service.js');
  const list = await queryCandidates(
    { employmentStatus: 'current' },
    { limit: cap, page: 1, sortBy: 'fullName:asc' }
  );

  const rows = [];
  for (const row of list.results || []) {
    const id = row._id != null ? String(row._id) : row.id != null ? String(row.id) : '';
    if (!id) continue;
    // Sequential evaluate avoids hammering Mongo with hundreds of parallel aggregations.
    const ev = await evaluateSopForCandidate(id);
    if (ev.skipped || !ev.steps?.length) continue;
    const open = ev.steps.filter((s) => !s.done);
    if (!open.length) continue;
    rows.push({
      candidateId: id,
      fullName: row.fullName || '',
      employeeId: row.employeeId ?? null,
      email: row.email ?? null,
      templateVersion: ev.templateVersion,
      nextStep: ev.nextStep
        ? {
            label: ev.nextStep.label,
            link: ev.nextStep.link,
            checkerKey: ev.nextStep.checkerKey,
          }
        : null,
      openSteps: open.map((s) => ({
        checkerKey: s.checkerKey,
        label: s.label,
        description: s.description || '',
        link: s.link || '',
      })),
      completedCount: ev.completedCount,
      totalCount: ev.totalCount,
    });
  }

  return {
    activeSopVersion: activeTemplate?.version ?? null,
    activeTemplateId: activeTemplate?._id ? String(activeTemplate._id) : null,
    scannedCount: (list.results || []).length,
    totalCurrentCandidates: list.totalResults ?? (list.results || []).length,
    withOpenStepsCount: rows.length,
    results: rows,
  };
};

/**
 * BOLA-safe view: candidates.manage, platform super-user, owner, or assigned agent.
 * @param {import('express').Request} req - after auth(); needs user, authContext
 * @param {object} candidate - lean or document (owner / assignedAgent may be ObjectId or populated)
 */
export const assertCanViewCandidateSop = (req, candidate) => {
  if (!req?.user || !candidate) return false;
  if (req.user.platformSuperUser) return true;
  const canManage = req.authContext?.permissions?.has('candidates.manage') ?? false;
  if (canManage) return true;
  const uid = String(req.user.id || req.user._id || '');
  const ownerId = candidate.owner?.id ?? candidate.owner?._id ?? candidate.owner;
  if (ownerId && String(ownerId) === uid) return true;
  const agentId = candidate.assignedAgent?.id ?? candidate.assignedAgent?._id ?? candidate.assignedAgent;
  if (agentId && String(agentId) === uid) return true;
  return false;
};
