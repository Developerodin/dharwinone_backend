import Employee from '../models/employee.model.js';
import EmailAccount from '../models/emailAccount.model.js';
import Task from '../models/task.model.js';
import TeamMember from '../models/team.model.js';
import BackdatedAttendanceRequest from '../models/backdatedAttendanceRequest.model.js';
import { getOffboardingConfig } from './offboardingConfig.service.js';
import { evaluateSteps } from './offboarding.pure.js';

const EMPTY = { steps: [], completedCount: 0, totalCount: 0, skipped: true, nextStep: null };

/** Build the plain decision context for one employee. owner = the User behind the Employee. */
export const loadOffboardingContext = async (employee) => {
  const owner = employee.owner;
  const [pendingBackdatedCount, emailAccount, openAssignedTaskCount, activeTeamRowCount] = await Promise.all([
    owner ? BackdatedAttendanceRequest.countDocuments({ user: owner, status: 'pending' }) : 0,
    owner ? EmailAccount.findOne({ user: owner }).select('status').lean() : null,
    owner ? Task.countDocuments({ assignedTo: owner, status: { $ne: 'completed' } }) : 0,
    TeamMember.countDocuments({ employeeId: employee._id, isActive: true }),
  ]);
  return {
    pendingBackdatedCount,
    hasCompanyEmail: Boolean(employee.companyAssignedEmail),
    emailStatus: emailAccount?.status ?? null,
    openAssignedTaskCount,
    employeeIsActive: employee.isActive !== false,
    activeTeamRowCount,
  };
};

/**
 * Exit SOP is active ONLY when resignDate is set (inverse of onboarding skip).
 * Returns skipped:true otherwise.
 */
export const evaluateOffboardingForEmployee = async (employeeId) => {
  const employee = await Employee.findById(employeeId)
    .select('owner companyAssignedEmail isActive resignDate fullName')
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
