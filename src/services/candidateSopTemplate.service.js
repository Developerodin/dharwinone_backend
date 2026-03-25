import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import CandidateSopTemplate from '../models/candidateSopTemplate.model.js';
import { DEFAULT_SOP_STEPS } from './sopChecklist.service.js';

const nextVersion = async () => {
  const last = await CandidateSopTemplate.findOne().sort({ version: -1 }).select('version').lean();
  return (last?.version ?? 0) + 1;
};

/**
 * Legacy rows: ensureDefaultActiveTemplate used to insert a new v1 whenever no template was active,
 * producing many documents with the same version. Keep one per version (active wins, else newest).
 */
const dedupeDuplicateCandidateSopTemplateVersions = async () => {
  const all = await CandidateSopTemplate.find({}).lean();
  const byVersion = new Map();
  for (const t of all) {
    const list = byVersion.get(t.version) ?? [];
    list.push(t);
    byVersion.set(t.version, list);
  }
  for (const [, docs] of byVersion) {
    if (docs.length <= 1) continue;
    docs.sort((a, b) => {
      if (Boolean(a.isActive) !== Boolean(b.isActive)) return a.isActive ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    for (const d of docs.slice(1)) {
      if (d.isActive) {
        await CandidateSopTemplate.updateOne({ _id: d._id }, { $set: { isActive: false } });
      }
      await CandidateSopTemplate.deleteOne({ _id: d._id });
    }
  }
};

export const listCandidateSopTemplates = async () => {
  const dupVersions = await CandidateSopTemplate.aggregate([
    { $group: { _id: '$version', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (dupVersions.length > 0) {
    await dedupeDuplicateCandidateSopTemplateVersions();
  }
  const items = await CandidateSopTemplate.find({}).sort({ version: -1 }).lean();
  return items;
};

export const getCandidateSopTemplateById = async (id) => {
  const t = await CandidateSopTemplate.findById(id).lean();
  if (!t) throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  return t;
};

export const getActiveCandidateSopTemplate = async () => {
  let t = await CandidateSopTemplate.findOne({ isActive: true }).lean();
  if (!t) {
    const { ensureDefaultActiveTemplate } = await import('./sopChecklist.service.js');
    t = await ensureDefaultActiveTemplate();
  }
  return t;
};

/**
 * Create a new immutable version (draft or immediately active via options.activate).
 */
export const createCandidateSopTemplate = async (body) => {
  const version = await nextVersion();
  const steps = Array.isArray(body.steps) && body.steps.length ? body.steps : DEFAULT_SOP_STEPS();
  const doc = await CandidateSopTemplate.create({
    name: body.name?.trim() || 'Onboarding',
    version,
    isActive: Boolean(body.activate),
    steps,
  });
  if (body.activate) {
    await CandidateSopTemplate.updateMany({ _id: { $ne: doc._id } }, { $set: { isActive: false } });
  }
  return doc;
};

/**
 * Update only non-active templates (draft editing).
 */
export const updateCandidateSopTemplate = async (id, body) => {
  const t = await CandidateSopTemplate.findById(id);
  if (!t) throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  if (t.isActive) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot edit the active template; create a new version');
  }
  if (body.name != null) t.name = String(body.name).trim() || t.name;
  if (Array.isArray(body.steps)) t.steps = body.steps;
  await t.save();
  return t;
};

export const deleteCandidateSopTemplate = async (id) => {
  const t = await CandidateSopTemplate.findById(id);
  if (!t) throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  if (t.isActive) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete the active template');
  }
  await t.deleteOne();
};

export const setActiveCandidateSopTemplate = async (id) => {
  const t = await CandidateSopTemplate.findById(id);
  if (!t) throw new ApiError(httpStatus.NOT_FOUND, 'Template not found');
  await CandidateSopTemplate.updateMany({}, { $set: { isActive: false } });
  t.isActive = true;
  await t.save();
  return t;
};
