import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as meetingService from '../services/meeting.service.js';
import * as meetingExcelService from '../services/meetingExcel.service.js';

/**
 * GET /v1/meetings/export — stream all interviews the current user can see as an
 * .xlsx download. Reuses queryMeetings (same title/status filters + per-user
 * scope as the list) with a high limit so the export respects the active view.
 */
export const exportExcel = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'status']);
  const result = await meetingService.queryMeetings(filter, { limit: 100000, page: 1 }, req.user);
  const buf = meetingExcelService.buildMeetingsExportBuffer(result.results || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="interviews-export-${date}.xlsx"`);
  res.send(buf);
});
