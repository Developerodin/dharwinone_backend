import mongoose from 'mongoose';
import Placement from '../models/placement.model.js';
import Employee from '../models/employee.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import logger from '../config/logger.js';
import config from '../config/config.js';

/**
 * Idempotent: assign default training module to hire's student profile on Joined.
 * @param {import('mongoose').Document} placement
 */
export const assignDefaultTrainingOnJoined = async (placement) => {
  const moduleIdStr = config.ats?.defaultOnboardingModuleId;
  if (!moduleIdStr || !mongoose.Types.ObjectId.isValid(moduleIdStr)) return;

  const modId = new mongoose.Types.ObjectId(moduleIdStr);
  const mod = await TrainingModule.findById(modId).select('students moduleName').lean();
  if (!mod) return;

  const employee = await Employee.findById(placement.candidate).select('owner').lean();
  if (!employee?.owner) return;
  const student = await Student.findOne({ user: employee.owner }).select('_id').lean();
  if (!student?._id) return;

  const sid = student._id;
  const already = (mod.students || []).some((s) => String(s) === String(sid));
  if (already) {
    await Placement.updateOne(
      { _id: placement._id },
      { $set: { trainingModuleId: modId, trainingAssignedAt: placement.trainingAssignedAt || new Date() } }
    );
    return;
  }

  await TrainingModule.updateOne({ _id: modId }, { $addToSet: { students: sid } });
  await Placement.updateOne({ _id: placement._id }, { $set: { trainingModuleId: modId, trainingAssignedAt: new Date() } });
  logger.info(`[placementTraining] assigned module ${modId} to student ${sid} for placement ${placement._id}`);
};
