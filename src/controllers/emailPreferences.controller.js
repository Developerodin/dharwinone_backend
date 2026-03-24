import catchAsync from '../utils/catchAsync.js';
import * as emailTemplateService from '../services/emailTemplate.service.js';
import * as emailSignatureService from '../services/emailSignature.service.js';

const currentUserId = (req) => req.user.id || req.user._id;

const listTemplates = catchAsync(async (req, res) => {
  const data = await emailTemplateService.listTemplatesForAgent(currentUserId(req));
  res.json(data);
});

const createTemplate = catchAsync(async (req, res) => {
  const doc = await emailTemplateService.createTemplate(currentUserId(req), req.body);
  res.status(201).json(doc);
});

const updateTemplate = catchAsync(async (req, res) => {
  const doc = await emailTemplateService.updateTemplateById(req.params.templateId, currentUserId(req), req.body);
  res.json(doc);
});

const deleteTemplate = catchAsync(async (req, res) => {
  await emailTemplateService.deleteTemplateById(req.params.templateId, currentUserId(req));
  res.status(204).send();
});

const getSignature = catchAsync(async (req, res) => {
  const doc = await emailSignatureService.getOrCreateSignature(currentUserId(req));
  res.json(doc);
});

const patchSignature = catchAsync(async (req, res) => {
  const doc = await emailSignatureService.updateSignature(currentUserId(req), req.body);
  res.json(doc);
});

const adminListTemplates = catchAsync(async (req, res) => {
  const { userId } = req.query;
  const rows = await emailTemplateService.listTemplatesForAdminTarget(userId);
  res.json({ results: rows });
});

const adminCreateTemplate = catchAsync(async (req, res) => {
  const { userId, title, subject, bodyHtml, isShared } = req.body;
  const doc = await emailTemplateService.createTemplateForAdminTarget(userId, {
    title,
    subject,
    bodyHtml,
    isShared,
  });
  res.status(201).json(doc);
});

const adminGetSignature = catchAsync(async (req, res) => {
  const { userId } = req.query;
  const doc = await emailSignatureService.getSignatureForAdminTarget(userId);
  res.json(doc);
});

const adminUpdateTemplate = catchAsync(async (req, res) => {
  const doc = await emailTemplateService.updateTemplateAdmin(req.params.templateId, req.body);
  res.json(doc);
});

const adminDeleteTemplate = catchAsync(async (req, res) => {
  await emailTemplateService.deleteTemplateAdmin(req.params.templateId);
  res.status(204).send();
});

const adminPatchSignature = catchAsync(async (req, res) => {
  const { userId, html, enabled } = req.body;
  const doc = await emailSignatureService.updateSignatureAdmin(userId, { html, enabled });
  res.json(doc);
});

export {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getSignature,
  patchSignature,
  adminListTemplates,
  adminCreateTemplate,
  adminGetSignature,
  adminUpdateTemplate,
  adminDeleteTemplate,
  adminPatchSignature,
};
