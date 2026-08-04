import catchAsync from '../utils/catchAsync.js';
import { buildMeetingsMongoFilter } from '../utils/meetingQueryFilter.js';
import * as meetingService from '../services/meeting.service.js';
import * as meetingExcelService from '../services/meetingExcel.service.js';

const MEETINGS_EXPORT_CAP = 100000;

/**
 * POST /v1/meetings/export — stream filtered interviews the current user can see as an
 * .xlsx download. Uses the same query filters as GET /meetings (omit page/limit) and
 * applies them to the full scoped dataset before Excel generation.
 */
export const exportExcel = catchAsync(async (req, res) => {
  const filter = buildMeetingsMongoFilter(req.query, req.body);
  const sortBy = req.query.sortBy || '-createdAt';
  const result = await meetingService.queryMeetings(
    filter,
    { limit: MEETINGS_EXPORT_CAP, page: 1, sortBy },
    req.user
  );
  const buf = meetingExcelService.buildMeetingsExportBuffer(result.results || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="interviews-export-${date}.xlsx"`);
  res.send(buf);
});
