import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as companyPhoneNumberService from '../services/companyPhoneNumber.service.js';

const list = catchAsync(async (req, res) => {
  const data = await companyPhoneNumberService.listCompanyPhoneNumbers(req.user, req.query);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const syncFromProvider = catchAsync(async (req, res) => {
  const data = await companyPhoneNumberService.syncCompanyPhoneNumbersFromProvider(req.user);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const patch = catchAsync(async (req, res) => {
  const row = await companyPhoneNumberService.updateCompanyPhoneNumberById(req.user, req.params.id, req.body);
  res.status(httpStatus.OK).send({ success: true, number: row });
});

const myAssigned = catchAsync(async (req, res) => {
  const uid = req.user._id || req.user.id;
  const numbers = await companyPhoneNumberService.listActiveNumbersForUser(uid);
  res.status(httpStatus.OK).send({ success: true, numbers });
});

const userAssignments = catchAsync(async (req, res) => {
  const data = await companyPhoneNumberService.listUserPhoneAssignments(req.user);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const assignUser = catchAsync(async (req, res) => {
  const result = await companyPhoneNumberService.assignPhoneNumberToUser(req.user, req.body);
  res.status(httpStatus.OK).send({ success: true, ...result });
});

export { list, syncFromProvider, patch, myAssigned, userAssignments, assignUser };
