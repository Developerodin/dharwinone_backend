import Joi from 'joi';
import { EMPLOYMENT_TYPES } from '../../../../../constants/atsPipeline.js';
import { DOCUMENT_TYPES } from '../../../../../models/employee.model.js';
import { normalizeSlipMonth } from '../../../../employee.service.js';

// Month is stored as the full English name ("September"); accept "Sep", "9" etc. and normalize here.
const slipMonth = Joi.alternatives()
  .try(Joi.string().min(1), Joi.number().integer().min(1).max(12))
  .custom((value, helpers) => normalizeSlipMonth(value) ?? helpers.error('any.invalid'))
  .description('Month name or number, e.g. "September" or 9.');

const isoDay = Joi.string().min(10).max(10).description('YYYY-MM-DD.'); // format checked in common.js dayRange
// Inclusive, whole UTC days (same bounds as the legacy resolveDateWindow).
const dayWindow = (what) => Joi.object({ from: isoDay, to: isoDay }).or('from', 'to')
  .description(`${what} on or between these days (inclusive). Includes people who have since resigned.`);

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
  joinedBetween: dayWindow('Joining date'),
  resignedBetween: dayWindow('Resign date'),
  missingSalarySlip: Joi.alternatives()
    .try(
      Joi.boolean().valid(true),
      Joi.object({ month: slipMonth.required(), year: Joi.number().integer().min(1900).max(2100).required() }),
    )
    .description(
      'Employees who have NOT uploaded a salary slip: true = no slips at all; { month, year } = none for ' +
        'that month. Checks upload records only, never slip contents.',
    ),
  missingDocument: Joi.object({
    type: Joi.string().valid(...DOCUMENT_TYPES).required()
      .description('Document type. "Resume" also covers "CV/Resume" and the versioned resume slot.'),
    approvedOnly: Joi.boolean()
      .description('true = a pending or rejected upload still counts as missing; only an approved one counts.'),
  }).description('Employees who have NOT uploaded this document type. Checks upload records only, never contents.'),
}).description('Employee filters. Omit a key to leave it unfiltered.');
