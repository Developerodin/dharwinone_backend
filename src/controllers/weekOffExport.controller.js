import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as weekOffExportService from '../services/weekOffExport.service.js';

/**
 * GET /v1/training/students/week-off/export?days=Saturday,Sunday
 */
export const exportWeekOffExcel = catchAsync(async (req, res) => {
  const days = Array.isArray(req.query.days) ? req.query.days : String(req.query.days || '').split(',');
  const selectedDays = [...new Set(days.map((day) => String(day).trim()).filter(Boolean))];

  const { buffer, rowCount } = await weekOffExportService.buildWeekOffExportForDays(selectedDays);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="week-off-export.xlsx"');
  res.setHeader('X-Export-Row-Count', String(rowCount));
  res.send(buffer);
});

/**
 * GET /v1/training/students/week-off/counts
 */
export const listWeekOffDayCounts = catchAsync(async (_req, res) => {
  const result = await weekOffExportService.queryWeekOffDayCounts();
  res.status(httpStatus.OK).send({ success: true, data: result });
});

/**
 * GET /v1/training/students/week-off/assignments?day=Monday
 */
export const listWeekOffAssignments = catchAsync(async (req, res) => {
  const result = await weekOffExportService.queryWeekOffAssignmentsForDay(req.query.day, {
    page: req.query.page,
    limit: req.query.limit,
    search: req.query.search,
  });
  res.status(httpStatus.OK).send({ success: true, data: result });
});

/**
 * POST /v1/training/students/week-off/unassign
 */
export const unassignWeekOffDay = catchAsync(async (req, res) => {
  const result = await weekOffExportService.unassignWeekOffDay(req.body);
  res.status(httpStatus.OK).send({
    success: true,
    message: `Removed ${result.day} from week-off`,
    data: result,
  });
});
