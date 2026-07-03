import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import pick from '../utils/pick.js';
import * as contactService from '../services/contact.service.js';
import { userIsAdmin } from '../utils/roleHelpers.js';
import { authHasPermission, sanitizeCallRecords } from '../utils/callRecordAccess.util.js';

export const create = catchAsync(async (req, res) => {
  const result = await contactService.createContact(req.user, req.body);
  res.status(httpStatus.CREATED).send(result);
});
export const list = catchAsync(async (req, res) => {
  res.send(await contactService.queryContacts(req.user, pick(req.query, ['q', 'sortBy', 'limit', 'page'])));
});
export const get = catchAsync(async (req, res) => {
  res.send(await contactService.getContactById(req.user, req.params.contactId));
});
export const update = catchAsync(async (req, res) => {
  res.send(await contactService.updateContact(req.user, req.params.contactId, req.body));
});
export const remove = catchAsync(async (req, res) => {
  await contactService.softDeleteContact(req.user, req.params.contactId);
  res.status(httpStatus.NO_CONTENT).send();
});
export const getCalls = catchAsync(async (req, res) => {
  const isAdmin = await userIsAdmin(req.user);
  const { results } = await contactService.getContactCalls(req.user, req.params.contactId, { isAdmin });
  const access = {
    canViewTranscripts: authHasPermission(req, 'call-transcripts.read'),
    canViewAi: authHasPermission(req, 'call-ai.read'),
  };
  res.send({ success: true, results: sanitizeCallRecords(results, access) });
});
