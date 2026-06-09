import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as orgStructureService from '../services/orgStructure.service.js';
import { persistActivityLogFailSoft } from '../services/activityLog.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id);

const persistEnvelope = async (req, envelope) => {
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  return envelope.result;
};

export const getTree = catchAsync(async (req, res) => {
  const { rootId, depth } = req.query;
  if (rootId !== undefined || depth !== undefined) {
    return res.send(
      await orgStructureService.buildTreeLazy(req.user, {
        rootId: rootId ?? null,
        depth: depth !== undefined ? Number(depth) : 2,
      })
    );
  }
  res.send(await orgStructureService.buildTree(req.user));
});
export const searchChart = catchAsync(async (req, res) =>
  res.send(await orgStructureService.searchOrgChart(req.user, req.query.q))
);
export const getDirectory = catchAsync(async (req, res) =>
  res.send(await orgStructureService.queryEmployeeDirectory(req.user, req.query))
);
/** Live chart drag-drop reparent — same as structure reparent with audit. */
export const reparentFromChart = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.reparentOrgUnit(req.params.orgUnitId, req.body.parentId);
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  res.send(envelope.result);
});
export const getOrgUnits = catchAsync(async (req, res) => {
  const { q, page, limit, sortBy, includeInactive } = req.query;
  const paginated = page !== undefined || limit !== undefined || q !== undefined || includeInactive !== undefined;
  if (paginated) {
    return res.send(
      await orgStructureService.queryOrgUnits({
        q,
        page,
        limit,
        sortBy,
        includeInactive: includeInactive === true || includeInactive === 'true',
      })
    );
  }
  res.send(await orgStructureService.listOrgUnits());
});
export const getCoverage = catchAsync(async (req, res) => res.send(await orgStructureService.getOrgCoverageSummary(req.user)));
export const getAssignableHeads = catchAsync(async (req, res) =>
  res.send(await orgStructureService.listAssignableHeads(req.user, req.query.departmentId || null))
);
export const exportReport = catchAsync(async (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase();
  const envelope = await orgStructureService.exportComplianceReport(req.user, { format });
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  if (format === 'csv' && envelope.result?.csv) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="org-structure-export.csv"');
    return res.send(envelope.result.csv);
  }
  res.send(envelope.result);
});
export const createOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.createOrgUnit(req.body, req.user?._id);
  const result = await persistEnvelope(req, envelope);
  res.status(httpStatus.CREATED).send(result);
});
export const updateOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.updateOrgUnit(req.params.orgUnitId, req.body);
  res.send(await persistEnvelope(req, envelope));
});
export const reparentOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.reparentOrgUnit(req.params.orgUnitId, req.body.parentId);
  res.send(await persistEnvelope(req, envelope));
});
export const assignHead = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.assignHead(req.params.orgUnitId, req.body.headEmployeeId);
  res.send(await persistEnvelope(req, envelope));
});
export const deactivateOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.deactivateOrgUnit(req.params.orgUnitId);
  res.send(await persistEnvelope(req, envelope));
});
export const reactivateOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.reactivateOrgUnit(req.params.orgUnitId);
  res.send(await persistEnvelope(req, envelope));
});
export const deleteOrgUnit = catchAsync(async (req, res) => {
  const envelope = await orgStructureService.deleteOrgUnit(req.params.orgUnitId);
  res.send(await persistEnvelope(req, envelope));
});
