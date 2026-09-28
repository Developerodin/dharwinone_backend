import Joi from 'joi';
import { EMPLOYMENT_TYPES } from '../../../../../constants/atsPipeline.js';

export const employeeFilters = Joi.object({
  search: Joi.string().min(1)
    .description('Name, email or employee id — like the Employees page search box.'),
  employmentStatus: Joi.string().valid('current', 'resigned', 'all')
    .description('Defaults to current (still working). "all" = current + resigned.'),
  compensationType: Joi.string().valid('paid', 'unpaid'),
  employmentType: Joi.string().valid(...EMPLOYMENT_TYPES),
  designation: Joi.string().min(1)
    .description('Job title / position, e.g. "React Developer". Partial match.'),
  agent: Joi.string().min(1).description('Name of the agent the employee is assigned to.'),
}).description('Employee filters. Omit a key to leave it unfiltered.');
