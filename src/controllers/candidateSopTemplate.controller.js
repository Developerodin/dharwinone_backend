import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as candidateSopTemplateService from '../services/candidateSopTemplate.service.js';

const list = catchAsync(async (req, res) => {
  const items = await candidateSopTemplateService.listCandidateSopTemplates();
  res.send(items);
});

const getActive = catchAsync(async (req, res) => {
  const t = await candidateSopTemplateService.getActiveCandidateSopTemplate();
  res.send(t);
});

const getOne = catchAsync(async (req, res) => {
  const t = await candidateSopTemplateService.getCandidateSopTemplateById(req.params.templateId);
  res.send(t);
});

const create = catchAsync(async (req, res) => {
  const doc = await candidateSopTemplateService.createCandidateSopTemplate(req.body);
  res.status(httpStatus.CREATED).send(doc);
});

const update = catchAsync(async (req, res) => {
  const doc = await candidateSopTemplateService.updateCandidateSopTemplate(req.params.templateId, req.body);
  res.send(doc);
});

const remove = catchAsync(async (req, res) => {
  await candidateSopTemplateService.deleteCandidateSopTemplate(req.params.templateId);
  res.status(httpStatus.NO_CONTENT).send();
});

const setActive = catchAsync(async (req, res) => {
  const doc = await candidateSopTemplateService.setActiveCandidateSopTemplate(req.params.templateId);
  res.send(doc);
});

export default {
  list,
  getActive,
  getOne,
  create,
  update,
  remove,
  setActive,
};
