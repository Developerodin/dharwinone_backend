import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import * as payrollService from '../services/payrollDetail.service.js';
import { writeAtsAudit } from '../services/atsAudit.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

const audit = (req, action, employeeId, metadata) =>
  writeAtsAudit(
    auditActorId(req),
    { action, entityType: EntityTypes.EMPLOYEE, entityId: String(employeeId), metadata },
    req,
    { editContext: { staffEdit: true } }
  );

/** Self-service lookup: Employee.findOne({ owner }) — queryCandidates 404s staff roles. */
const myEmployeeOrThrow = async (req) => {
  const employee = await Employee.findOne({ owner: req.user._id || req.user.id });
  if (!employee) throw new ApiError(httpStatus.NOT_FOUND, 'No employee profile is linked to this account');
  return employee;
};

const getDetails = catchAsync(async (req, res) => {
  const data = await payrollService.getPayrollDetails(req.params.employeeId);
  res.send({ success: true, data });
});

const requestDetails = catchAsync(async (req, res) => {
  const data = await payrollService.requestPayrollDetails(req.params.employeeId, req.body, req.user);
  await audit(req, ActivityActions.PAYROLL_DETAILS_REQUEST, req.params.employeeId, {
    payrollCountry: data.payrollCountry,
    countrySource: data.countrySource,
  });
  res.status(httpStatus.CREATED).send({ success: true, data });
});

/**
 * Audited AFTER the delete, unlike revealAccount. The risk here is the mirror image:
 * reveal must never happen unaudited, whereas a cancel that failed must never leave an
 * audit row claiming it succeeded. Ordinary fail-soft audit is right for this one.
 */
const cancelRequest = catchAsync(async (req, res) => {
  const snapshot = await payrollService.cancelPayrollRequest(req.params.employeeId, req.user);
  await audit(req, ActivityActions.PAYROLL_DETAILS_CANCEL, req.params.employeeId, {
    payrollCountry: snapshot.payrollCountry,
    countrySource: snapshot.countrySource,
    requestedAt: snapshot.requestedAt,
  });
  res.status(httpStatus.NO_CONTENT).send();
});

const submitOnBehalf = catchAsync(async (req, res) => {
  const data = await payrollService.submitPayrollDetails(req.params.employeeId, req.body, req.user);
  await audit(req, ActivityActions.PAYROLL_DETAILS_SUBMIT, req.params.employeeId, {
    payrollCountry: data.payrollCountry,
    onBehalf: true,
  });
  res.send({ success: true, data });
});

const verifyDetails = catchAsync(async (req, res) => {
  const data = await payrollService.verifyPayrollDetails(req.params.employeeId, req.body, req.user);
  await audit(
    req,
    req.body.approved ? ActivityActions.PAYROLL_DETAILS_VERIFY : ActivityActions.PAYROLL_DETAILS_REJECT,
    req.params.employeeId,
    { rejectionReason: req.body.approved ? undefined : req.body.rejectionReason }
  );
  res.send({ success: true, data });
});

const revealAccount = catchAsync(async (req, res) => {
  // Audit BEFORE decrypting, and REQUIRE the row. writeAtsAudit resolves to null on a
  // failed write (persistActivityLogFailSoft is fail-soft) — awaiting it is not enough,
  // so the return value is checked. An unaudited decryption is the one outcome this
  // endpoint must never produce.
  const entry = await audit(req, ActivityActions.PAYROLL_DETAILS_REVEAL, req.params.employeeId, {});
  if (!entry) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Cannot reveal the account number: the audit log is unavailable');
  }
  const data = await payrollService.revealAccountNumber(req.params.employeeId);
  res.send({ success: true, data });
});

const getMyDetails = catchAsync(async (req, res) => {
  const employee = await myEmployeeOrThrow(req);
  const data = await payrollService.getPayrollDetails(employee._id);
  res.send({ success: true, data });
});

const submitMyDetails = catchAsync(async (req, res) => {
  const employee = await myEmployeeOrThrow(req);
  const data = await payrollService.submitPayrollDetails(employee._id, req.body, req.user);
  await audit(req, ActivityActions.PAYROLL_DETAILS_SUBMIT, employee._id, {
    payrollCountry: data.payrollCountry,
    onBehalf: false,
  });
  res.send({ success: true, data });
});

export {
  getDetails,
  requestDetails,
  cancelRequest,
  submitOnBehalf,
  verifyDetails,
  revealAccount,
  getMyDetails,
  submitMyDetails,
};
