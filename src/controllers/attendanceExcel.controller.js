import catchAsync from '../utils/catchAsync.js';
import attendanceService from '../services/attendance.service.js';
import { buildHistoryExportBuffer, buildTrackExportBuffer } from '../utils/attendanceExcel.service.js';

const HISTORY_EXPORT_LIMIT = 10000;

/**
 * GET /v1/training/attendance/track/export — live track list with same filters as GET /track.
 */
export const exportTrackExcel = catchAsync(async (req, res) => {
  const { search, punchStatus } = req.query;
  const result = await attendanceService.getTrackList({ search, punchStatus });
  const buf = buildTrackExportBuffer(result.results || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="track-attendance-export-${date}.xlsx"`);
  res.send(buf);
});

/**
 * GET /v1/training/attendance/track/history/export — history with same filters as GET /track/history.
 */
export const exportHistoryExcel = catchAsync(async (req, res) => {
  const { search, ...rest } = req.query;
  const result = await attendanceService.getTrackHistory({
    ...rest,
    search,
    limit: HISTORY_EXPORT_LIMIT,
    page: 1,
  });
  const buf = buildHistoryExportBuffer(result.data || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="attendance-history-export-${date}.xlsx"`);
  res.send(buf);
});
