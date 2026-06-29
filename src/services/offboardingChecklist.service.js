import Employee from '../models/employee.model.js';
import EmailAccount from '../models/emailAccount.model.js';
import Task from '../models/task.model.js';
import TeamMember from '../models/team.model.js';
import OrgUnit from '../models/orgUnit.model.js';
import BackdatedAttendanceRequest from '../models/backdatedAttendanceRequest.model.js';
import { getOffboardingConfig } from './offboardingConfig.service.js';
import { evaluateSteps } from './offboarding.pure.js';

const EMPTY = { steps: [], completedCount: 0, totalCount: 0, skipped: true, nextStep: null };

/**
 * Active team rows for an employee: linked rows (employeeId) PLUS orphan/legacy rows
 * (employeeId null) matched by the employee's email. Shared by the validator and the
 * removal action so both see the same memberships.
 */
export const buildActiveTeamFilter = ({ _id, email }) => {
  const or = [{ employeeId: _id }];
  if (email) or.push({ employeeId: null, legacyEmail: email });
  return { isActive: true, $or: or };
};

/**
 * Match backdated-attendance requests for one person across BOTH creation paths:
 * user-based ({user}/{userEmail}) and student-based ({studentEmail}). Shared by the
 * status count and the Exit SOP list so neither misses student-filed requests.
 */
export const backdatedRequestMatch = ({ email, owner }) => {
  const or = [];
  if (email) or.push({ userEmail: email }, { studentEmail: email });
  if (owner) or.push({ user: owner });
  return or.length ? { $or: or } : { _id: null };
};

/** Build the plain decision context for one employee. owner = the User behind the Employee. */
export const loadOffboardingContext = async (employee) => {
  const owner = employee.owner;
  const [pendingBackdatedCount, activeEmailCount, openAssignedTaskCount, activeTeamRowCount, headUnitCount] =
    await Promise.all([
      BackdatedAttendanceRequest.countDocuments({ status: 'pending', ...backdatedRequestMatch(employee) }),
      owner ? EmailAccount.countDocuments({ user: owner, status: 'active' }) : 0,
      owner ? Task.countDocuments({ assignedTo: owner, status: { $ne: 'completed' } }) : 0,
      TeamMember.countDocuments(buildActiveTeamFilter(employee)),
      OrgUnit.countDocuments({ headEmployeeId: employee._id, isActive: { $ne: false } }),
    ]);
  return {
    pendingBackdatedCount,
    hasCompanyEmail: Boolean(employee.companyAssignedEmail),
    activeEmailCount,
    openAssignedTaskCount,
    employeeIsActive: employee.isActive !== false,
    activeTeamRowCount,
    // In the org tree if a department member OR the head of any unit.
    inOrgStructure: Boolean(employee.departmentId) || headUnitCount > 0,
  };
};

/**
 * Exit SOP is active ONLY when resignDate is set (inverse of onboarding skip).
 * Returns skipped:true otherwise.
 */
export const evaluateOffboardingForEmployee = async (employeeId) => {
  const employee = await Employee.findById(employeeId)
    .select('owner companyAssignedEmail email departmentId isActive resignDate fullName')
    .lean();
  if (!employee || !employee.resignDate) return { ...EMPTY };

  const config = await getOffboardingConfig();
  const ctx = await loadOffboardingContext(employee);
  const steps = evaluateSteps(config.steps, ctx);

  const totalCount = steps.length;
  const completedCount = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done) || null;
  return { steps, completedCount, totalCount, skipped: false, nextStep };
};

/**
 * Auto-list every employee with a resignation date set (notice-period OR already left)
 * that still has open exit steps. No manual id entry — this is the offboarding dashboard.
 * Sequential evaluate avoids hammering Mongo with hundreds of parallel aggregations.
 * @param {{ limit?: number }} [opts]
 */
export const listOpenOffboardingOverview = async ({ limit = 200 } = {}) => {
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const employees = await Employee.find({ resignDate: { $exists: true, $ne: null } })
    .select('_id fullName employeeId email resignDate')
    .sort({ resignDate: 1 })
    .limit(cap)
    .lean();

  const rows = [];
  for (const e of employees) {
    const id = String(e._id);
    const ev = await evaluateOffboardingForEmployee(id);
    if (ev.skipped || !ev.steps.length) continue;
    if (!ev.steps.some((s) => !s.done)) continue;
    rows.push({
      employeeId: id,
      fullName: e.fullName || '',
      empCode: e.employeeId ?? null,
      email: e.email ?? null,
      resignDate: e.resignDate,
      completedCount: ev.completedCount,
      totalCount: ev.totalCount,
      nextStep: ev.nextStep,
      steps: ev.steps,
    });
  }

  return { scannedCount: employees.length, withOpenCount: rows.length, results: rows };
};
